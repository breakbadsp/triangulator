import collections
import dataclasses
import math

from .config import RULE_NAMES
from .protocol import STATUS_FALLBACK, TARGET_ABSENT, classify


def counters_regressed(current, previous):
    """True when a cumulative counter went backwards: the tid now belongs to a new thread."""
    if any(now < before for now, before in zip(current.counters, previous.counters)):
        return True
    io_now, io_before = current.io_counters, previous.io_counters
    return io_now is not None and io_before is not None and any(
        now < before for now, before in zip(io_now, io_before))


def io_rate(current, previous, index, elapsed):
    """Bytes per second between two samples, or None if either lacks I/O data."""
    if elapsed <= 0 or current.io_counters is None or previous.io_counters is None:
        return None
    return (current.io_counters[index] - previous.io_counters[index]) / elapsed


class AlertEngine:
    def __init__(self, config, storage, deliver, now):
        self.config = config
        self.storage = storage
        self.deliver = deliver
        recent, self.open = storage.recover_alerts()
        self.streaks = {}
        self.recent = collections.deque(recent, maxlen=500)
        for key in [key for key in self.open
                    if key[0] not in RULE_NAMES or not config.get("enabled", {}).get(key[0], True)]:
            # Alerts from removed or disabled rules are closed quietly, without notification.
            event = self.open.pop(key)
            detail = "Alert rule disabled" if key[0] in RULE_NAMES else "Alert rule removed"
            closed = dict(event, status="resolved", ts=now, detail=detail)
            self.storage.event(closed)
            self.recent.append(closed)

    def event(self, key, metadata, status, now, detail, severity):
        event = dict(metadata, rule=key[0], group=key[1], tid=key[2], status=status,
                     ts=now, detail=detail, severity=severity)
        self.storage.event(event)
        self.recent.append(event)
        self.deliver(event)
        return event

    def close_disabled(self, now):
        for key in [key for key in self.open if not self.config.get("enabled", {}).get(key[0], True)]:
            event = self.open.pop(key)
            self.event(key, {"name": event["name"], "session": event["session"]},
                       "resolved", now, "Alert rule disabled", event["severity"])
        for key in [key for key in self.streaks if not self.config.get("enabled", {}).get(key[0], True)]:
            del self.streaks[key]

    def evaluate(self, rule, group, tid, condition, now, metadata, detail,
                 severity="warning", immediate=False):
        key = rule, group, tid
        if not self.config.get("enabled", {}).get(rule, True):
            return
        if condition is None:
            self.streaks.pop(key, None)
            return
        previous, count = self.streaks.get(key, (None, 0))
        count = count + 1 if condition == previous else 1
        self.streaks[key] = condition, count
        if condition and key not in self.open and (immediate or count >= self.config["sustain_windows"]):
            self.open[key] = self.event(key, metadata, "opened", now, detail, severity)
        elif not condition and key in self.open and (immediate or count >= self.config["resolve_windows"]):
            self.event(key, metadata, "resolved", now, detail, self.open[key]["severity"])
            del self.open[key]

    def retire(self, tid, now, detail):
        for key in list(self.open):
            if key[2] == tid and tid != 0:
                event = self.open.pop(key)
                self.event(key, {"name": event["name"], "session": event["session"]},
                           "resolved", now, detail, event["severity"])
        for key in list(self.streaks):
            if key[2] == tid and tid != 0:
                del self.streaks[key]

    def reminders(self, now):
        for key, event in list(self.open.items()):
            if now - event["ts"] >= self.config["reminder_secs"]:
                self.open[key] = self.event(key, {"name": event["name"], "session": event["session"]},
                                            "reminder", now, event["detail"], event["severity"])


@dataclasses.dataclass
class Sample:
    monotonic: float
    wall: float
    interval: float
    fallback: bool
    record: object
    state: str


class ThreadState:
    def __init__(self, sample, group, generation):
        self.group = group
        self.generation = generation
        self.latest = sample
        self.raw = collections.deque()
        self.window = []
        self.baseline = None
        self.bucket = None
        self.last_rollup = None
        self.kernel_since = None
        self.cpu_runs = {}
        self.contiguous_since = sample.monotonic


class Monitor:
    def __init__(self, config, storage, deliver, now):
        self.config = config
        self.storage = storage
        self.alerts = AlertEngine(config["alerts"], storage, deliver, now)
        self.started = now
        self.last_seen = None
        self.last_tick_seen = None
        self.session = None
        self.retired_sessions = collections.deque(maxlen=128)
        self.threads = {}
        self.pending = {}
        self.last_monotonic = -1
        self.last_sequence = None
        self.loss = collections.deque()
        self.absent_since = None
        self.target_absent = None
        self.pid = 0
        self.interval = 1.0
        self.bad_packets = 0
        self.duplicates = 0
        self.late_packets = 0
        self.raw_count = 0
        self.generations = {}

    def group_for(self, name):
        return next((group for group in self.config["group"] if name.startswith(group["prefix"])),
                    {"name": "ungrouped"})

    def accept(self, packet, received):
        if packet.session != self.session:
            if packet.session in self.retired_sessions:
                self.late_packets += 1
                return
            if self.session is not None:
                self.retired_sessions.append(self.session)
                self.drain(received, force=True)
                for tid, thread in self.threads.items():
                    self.finish_window(tid, thread)
                    self.alerts.retire(tid, received, "Sampler session or target changed")
            self.session = packet.session
            for event in list(self.alerts.open.values()):
                if event["tid"] and event["session"] != str(self.session):
                    self.alerts.retire(event["tid"], received, "Sampler session or target changed")
            self.threads.clear()
            self.generations.clear()
            self.raw_count = 0
            self.pending.clear()
            self.last_monotonic = -1
            self.last_sequence = None
            self.loss.clear()
            self.absent_since = None
        if packet.monotonic_ns <= self.last_monotonic:
            self.late_packets += 1
            return
        key = packet.sequence
        if key not in self.pending:
            if len(self.pending) >= 128:
                self.drain(received, force=True)
                if packet.monotonic_ns <= self.last_monotonic:
                    self.late_packets += 1
                    return
            self.pending[key] = {"packet": packet, "received": received, "chunks": {}}
        tick = self.pending[key]
        if packet.signature != tick["packet"].signature:
            self.bad_packets += 1
            return
        if packet.chunk in tick["chunks"]:
            self.duplicates += 1
            return
        existing_tids = {record.tid for records in tick["chunks"].values() for record in records}
        if any(record.tid in existing_tids for record in packet.records):
            self.bad_packets += 1
            return
        tick["chunks"][packet.chunk] = packet.records
        self.last_seen = received

    def drain(self, now, force=False):
        ordered = sorted(self.pending.items(), key=lambda item: item[1]["packet"].monotonic_ns)
        for key, tick in ordered:
            packet = tick["packet"]
            grace = max(0.25, min(2, 2 * packet.interval_ms / 1000))
            if not force and now - tick["received"] < grace:
                break
            del self.pending[key]
            if packet.monotonic_ns <= self.last_monotonic:
                continue
            missing_ticks = 0
            if self.last_sequence is not None:
                distance = (packet.sequence - self.last_sequence) & 0xFFFFFFFF
                if distance == 0 or distance > 0x7FFFFFFF:
                    self.late_packets += 1
                    continue
                missing_ticks = distance - 1
            expected = packet.chunks * (missing_ticks + 1)
            self.loss.append((tick["received"], expected, expected - len(tick["chunks"])))
            self.last_sequence = packet.sequence
            self.last_monotonic = packet.monotonic_ns
            self.last_tick_seen = tick["received"]
            records = [record for chunk in sorted(tick["chunks"]) for record in tick["chunks"][chunk]]
            self.process(packet, records, tick["received"], len(tick["chunks"]) == packet.chunks)

    def process(self, packet, records, received, complete):
        self.interval = packet.interval_ms / 1000
        self.pid = packet.pid
        self.target_absent = bool(packet.flags & TARGET_ABSENT)
        if self.target_absent:
            if self.absent_since is None:
                self.absent_since = received
        else:
            self.absent_since = None
        monotonic = packet.monotonic_ns / 1e9
        wall = packet.wall_ns / 1e9
        if abs(wall - received) > 86400:
            wall = received
        seen = set()
        for record in records:
            seen.add(record.tid)
            sample = Sample(monotonic, wall, self.interval, bool(packet.flags & STATUS_FALLBACK),
                            record, classify(record))
            group = self.group_for(record.comm)
            thread = self.threads.get(record.tid)
            if thread is not None:
                reset = (counters_regressed(record, thread.latest.record)
                         or thread.latest.fallback != sample.fallback or thread.group != group)
                if reset:
                    self.finish_window(record.tid, thread)
                    self.alerts.retire(record.tid, received, "Thread counters, group or counter mode changed")
                    self.raw_count -= len(thread.raw)
                    thread = None
            if thread is None:
                generation = self.generations.get(record.tid, -1) + 1
                self.generations[record.tid] = generation
                thread = ThreadState(sample, group, generation)
                self.threads[record.tid] = thread
            bucket = math.floor(monotonic / self.config["alerts"]["window_s"])
            if thread.bucket is not None and bucket != thread.bucket:
                self.finish_window(record.tid, thread)
                if bucket != thread.bucket + 1:
                    self.invalidate(record.tid, thread)
                    thread.baseline = None
            if thread.raw and monotonic - thread.latest.monotonic > self.interval * 1.5:
                thread.kernel_since = None
                thread.cpu_runs.clear()
                thread.contiguous_since = monotonic
            thread.bucket = bucket
            thread.latest = sample
            thread.raw.append(sample)
            self.check_cpu(record.tid, thread, sample)
            self.raw_count += 1
            thread.window.append(sample)
            self.storage.raw(wall, str(self.session), dataclasses.asdict(record))
        if complete:
            for tid in set(self.threads) - seen:
                self.remove_thread(tid, received, "Thread exited or target absent")
            for event in list(self.alerts.open.values()):
                if event["tid"] and event["tid"] not in seen:
                    self.alerts.retire(event["tid"], received, "Thread exited or target absent")
        for tid, thread in list(self.threads.items()):
            if monotonic - thread.latest.monotonic > max(10, 3 * self.interval):
                self.remove_thread(tid, received, "Thread no longer observed (possibly packet loss)")
        self.prune_raw(monotonic)

    def remove_thread(self, tid, now, detail):
        thread = self.threads.pop(tid)
        self.finish_window(tid, thread)
        self.raw_count -= len(thread.raw)
        self.alerts.retire(tid, now, detail)

    def prune_raw(self, monotonic):
        for thread in self.threads.values():
            while thread.raw and thread.raw[0].monotonic < monotonic - 600:
                thread.raw.popleft()
                self.raw_count -= 1
        if self.raw_count > self.config["max_live_samples"]:
            quota = max(1, self.config["max_live_samples"] // max(1, len(self.threads)))
            for thread in self.threads.values():
                while len(thread.raw) > quota:
                    thread.raw.popleft()
                    self.raw_count -= 1

    def apply_alert_settings(self, alerts, now):
        """Replace thresholds and enabled rules in place; both engines share the dict."""
        self.config["alerts"].clear()
        self.config["alerts"].update(alerts)
        self.alerts.close_disabled(now)

    def check_cpu(self, tid, thread, sample):
        """Open a CPU alert once a thread stays above the threshold for cpu_sustain_secs.

        CPU is measured against the newest sample at least one second older, so
        clock-tick resolution stays near 1% at any sampling rate. A run of
        above- or below-threshold readings starts at that reference sample; a
        sampling gap clears the runs and the usable history (see process).
        """
        reference = next((item for item in reversed(thread.raw)
                          if item.monotonic <= sample.monotonic - 1.0), None)
        if reference is None or reference.monotonic < thread.contiguous_since:
            return
        elapsed = sample.monotonic - reference.monotonic
        ticks = (sample.record.utime + sample.record.stime
                 - reference.record.utime - reference.record.stime)
        cpu = ticks / self.config["clock_ticks"] / elapsed * 100
        thresholds = self.config["alerts"]
        sustain = thresholds["cpu_sustain_secs"]
        metadata = {"name": sample.record.comm, "session": str(self.session)}
        for rule, threshold, severity in (("cpu_warn", thresholds["cpu_warn_pct"], "warning"),
                                          ("cpu_critical", thresholds["cpu_crit_pct"], "critical")):
            above = cpu > threshold
            run = thread.cpu_runs.get(rule)
            if run is None or run[0] != above:
                run = thread.cpu_runs[rule] = (above, reference.monotonic)
            duration = sample.monotonic - run[1]
            condition = above if duration >= sustain else None
            if condition is None:
                continue
            detail = (f"CPU {cpu:.1f}% for {duration:.0f}s (over {threshold:g}%)" if above
                      else f"CPU {cpu:.1f}%, below {threshold:g}% for {duration:.0f}s")
            self.alerts.evaluate(rule, thread.group["name"], tid, condition, sample.wall, metadata,
                                 detail, severity, immediate=True)

    def invalidate(self, tid, thread):
        thread.kernel_since = None
        for rule in ("starved", "kernel_wait"):
            self.alerts.streaks.pop((rule, thread.group["name"], tid), None)

    def finish_window(self, tid, thread):
        samples = thread.window
        if not samples:
            return
        first = thread.baseline or samples[0]
        last = samples[-1]
        window_s = self.config["alerts"]["window_s"]
        expected = sum(window_s / sample.interval for sample in samples) / len(samples)
        elapsed = last.monotonic - first.monotonic
        valid = (len(samples) >= math.ceil(expected / 2) and elapsed > 0
                 and elapsed <= window_s + max(first.interval, last.interval) * 1.5)
        cpu_delta = last.record.utime + last.record.stime - first.record.utime - first.record.stime
        delay_delta = last.record.run_delay - first.record.run_delay
        slices_delta = last.record.timeslices - first.record.timeslices
        cpu = cpu_delta / self.config["clock_ticks"] / elapsed * 100 if valid else None
        delay = delay_delta / 1e9 / elapsed * 100 if valid and not last.fallback else None
        read_rate = io_rate(last.record, first.record, 0, elapsed) if valid else None
        write_rate = io_rate(last.record, first.record, 1, elapsed) if valid else None
        faults_delta = last.record.major_faults - first.record.major_faults
        counts = dict(collections.Counter(sample.state for sample in samples))
        row = {"ts": last.wall - (last.monotonic % window_s), "session": str(self.session),
               "tid": tid, "name": last.record.comm, "group": thread.group["name"],
               "cpu_pct": cpu, "run_delay_pct": delay, "sample_counts": counts,
               "timeslices_delta": slices_delta if valid else None, "read_bps": read_rate,
               "write_bps": write_rate, "major_faults_delta": faults_delta if valid else None,
               "samples": len(samples),
               "expected_samples": expected, "valid": valid, "generation": thread.generation}
        self.storage.rollup(row)
        thread.last_rollup = row
        thread.window = []
        thread.baseline = last
        if not valid:
            self.invalidate(tid, thread)
            return
        metadata = {"name": last.record.comm, "session": str(self.session)}
        thresholds = self.config["alerts"]
        conditions = {
            "starved": ((sum(sample.record.state == "R" for sample in samples) > len(samples) / 2 and cpu < 10 and delay_delta > 0)
                        if last.fallback else delay > thresholds["starve_run_delay_pct"],
                        "Runnable with little CPU" if last.fallback else f"Run delay {delay:.1f}%", "warning"),
        }
        for rule, (condition, detail, severity) in conditions.items():
            self.alerts.evaluate(rule, thread.group["name"], tid, condition, last.wall, metadata, detail, severity)
        contiguous = all(right.monotonic - left.monotonic <= max(left.interval, right.interval) * 1.5
                         for left, right in zip([first] + samples, samples))
        all_kernel = counts.get("kernel", 0) == len(samples)
        for rule, active, attribute, duration in (
            ("kernel_wait", all_kernel, "kernel_since", thresholds["kernel_wait_secs"]),
        ):
            since = getattr(thread, attribute)
            if active and contiguous:
                if since is None:
                    since = samples[0].monotonic
                setattr(thread, attribute, since)
                condition = last.monotonic - since > duration
                if not condition:
                    continue
            else:
                setattr(thread, attribute, None)
                condition = False if not active else None
            self.alerts.evaluate(rule, thread.group["name"], tid, condition, last.wall, metadata,
                                 f"{rule}: sustained over {duration:g}s" if condition else f"{rule}: condition cleared",
                                 immediate=condition is True)

    def health(self, now):
        self.drain(now)
        while self.loss and self.loss[0][0] < now - 60:
            self.loss.popleft()
        expected = sum(item[1] for item in self.loss)
        lost = sum(item[2] for item in self.loss)
        loss_pct = lost / expected * 100 if expected else 0
        thresholds = self.config["alerts"]
        silent = now - (self.last_seen if self.last_seen is not None else self.started) >= thresholds["sampler_silent_secs"]
        metadata = {"name": "monitor", "session": str(self.session or 0)}
        conditions = {
            "sampler_silent": (silent, "No fresh sampler datagrams"),
            "target_absent": (not silent and self.absent_since is not None and now - self.absent_since >= thresholds["target_absent_secs"], "Sampler reports target absent"),
            "packet_loss": (loss_pct > thresholds["packet_loss_pct"], f"Estimated packet loss {loss_pct:.1f}% over 60s"),
            "access_lost": (not silent and bool(self.threads) and sum(thread.latest.state == "no_access" for thread in self.threads.values()) > len(self.threads) / 2,
                            "Most threads have a hidden wait channel"),
        }
        for rule, (condition, detail) in conditions.items():
            self.alerts.evaluate(rule, "monitor", 0, condition, now, metadata, detail, immediate=True)
        if silent:
            for tid, thread in self.threads.items():
                self.invalidate(tid, thread)
        self.alerts.reminders(now)
        return {"last_seen": self.last_seen, "sampler_silent": silent, "target_absent": self.target_absent,
                "packet_loss_pct": loss_pct, "session": str(self.session) if self.session is not None else None,
                "pid": self.pid, "bad_packets": self.bad_packets, "duplicates": self.duplicates,
                "late_packets": self.late_packets, "raw_samples": self.raw_count,
                "sample_interval_ms": round(self.interval * 1000)}

    def snapshot(self, now):
        threads = []
        for tid, thread in sorted(self.threads.items()):
            sample = thread.latest
            recent = [item for item in thread.raw if item.monotonic >= sample.monotonic - 10]
            counts = dict(collections.Counter(item.state for item in recent))
            first = recent[0] if recent else sample
            elapsed = sample.monotonic - first.monotonic
            current, previous = sample.record, first.record

            def rate(name, scale=1.0):
                return (getattr(current, name) - getattr(previous, name)) / scale / elapsed if elapsed > 0 else None

            cpu = ((current.utime + current.stime - previous.utime - previous.stime)
                   / self.config["clock_ticks"] / elapsed * 100) if elapsed > 0 else None
            threads.append({"tid": tid, "name": current.comm, "group": thread.group["name"],
                            "state": sample.state, "wchan": current.wchan, "cpu": current.processor,
                            "cpu_pct": cpu, "state_mix": counts,
                            "run_delay_pct": None if sample.fallback or elapsed <= 0 else rate("run_delay", 1e9) * 100,
                            "switches_per_s": rate("timeslices"), "major_faults_per_s": rate("major_faults"),
                            "read_bps": io_rate(current, previous, 0, elapsed),
                            "write_bps": io_rate(current, previous, 1, elapsed),
                            "last_sample": sample.wall, "stale": now - sample.wall > max(10, self.interval * 3),
                            "generation": thread.generation})
        return {"threads": threads, "groups": dict(collections.Counter(item["group"] for item in threads)),
                "alerts": list(self.alerts.open.values()), "recent_alerts": list(reversed(self.alerts.recent))}

    def close(self):
        self.drain(self.last_seen or self.started, force=True)
        for tid, thread in self.threads.items():
            self.finish_window(tid, thread)
