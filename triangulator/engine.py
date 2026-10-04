import collections
import dataclasses
import math

from .protocol import STATUS_FALLBACK, TARGET_ABSENT, classify


class AlertEngine:
    def __init__(self, config, storage, deliver):
        self.config = config
        self.storage = storage
        self.deliver = deliver
        recent, self.open = storage.recover_alerts()
        self.streaks = {}
        self.recent = collections.deque(recent, maxlen=500)

    def event(self, key, metadata, status, now, detail, severity):
        event = dict(metadata, rule=key[0], group=key[1], tid=key[2], status=status,
                     ts=now, detail=detail, severity=severity)
        self.storage.event(event)
        self.recent.append(event)
        self.deliver(event)
        return event

    def evaluate(self, rule, group, tid, condition, now, metadata, detail,
                 severity="warning", immediate=False):
        key = rule, group, tid
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
        self.blocked_since = None
        self.kernel_since = None


class Monitor:
    def __init__(self, config, storage, deliver, now):
        self.config = config
        self.storage = storage
        self.alerts = AlertEngine(config["alerts"], storage, deliver)
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
                            record, classify(record, self.config["arch"]))
            group = self.group_for(record.comm)
            thread = self.threads.get(record.tid)
            if thread is not None:
                reset = (any(current < old for current, old in zip(record.counters, thread.latest.record.counters))
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
                thread.blocked_since = None
                thread.kernel_since = None
            thread.bucket = bucket
            thread.latest = sample
            thread.raw.append(sample)
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

    def invalidate(self, tid, thread):
        thread.blocked_since = None
        thread.kernel_since = None
        for rule in ("cpu_warn", "cpu_critical", "starved", "blocked", "kernel_wait"):
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
        counts = dict(collections.Counter(sample.state for sample in samples))
        row = {"ts": last.wall - (last.monotonic % window_s), "session": str(self.session),
               "tid": tid, "name": last.record.comm, "group": thread.group["name"],
               "cpu_pct": cpu, "run_delay_pct": delay, "sample_counts": counts,
               "timeslices_delta": slices_delta if valid else None, "samples": len(samples),
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
            "cpu_warn": (cpu > thresholds["cpu_warn_pct"], f"CPU {cpu:.1f}%", "warning"),
            "cpu_critical": (cpu > thresholds["cpu_crit_pct"], f"CPU {cpu:.1f}%", "critical"),
            "starved": ((sum(sample.record.state == "R" for sample in samples) > len(samples) / 2 and cpu < 10 and delay_delta > 0)
                        if last.fallback else delay > thresholds["starve_run_delay_pct"],
                        "Runnable with little CPU" if last.fallback else f"Run delay {delay:.1f}%", "warning"),
        }
        for rule, (condition, detail, severity) in conditions.items():
            self.alerts.evaluate(rule, thread.group["name"], tid, condition, last.wall, metadata, detail, severity)
        contiguous = all(right.monotonic - left.monotonic <= max(left.interval, right.interval) * 1.5
                         for left, right in zip([first] + samples, samples))
        frozen = cpu_delta == 0 and slices_delta == 0 and (not last.fallback or delay_delta == 0)
        all_blocked = (all(sample.state in {"lock", "condition"} for sample in samples)
                       and len({(sample.record.syscall, sample.record.futex_op) for sample in samples}) == 1
                       and frozen and not thread.group.get("allow_untimed_wait", False))
        all_kernel = counts.get("kernel", 0) == len(samples)
        for rule, active, attribute, duration in (
            ("blocked", all_blocked, "blocked_since", thresholds["blocked_secs"]),
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
            "access_lost": (not silent and bool(self.threads) and sum(thread.latest.record.syscall == -3 for thread in self.threads.values()) > len(self.threads) / 2,
                            "Most threads have unreadable syscall data"),
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
            cpu = ((sample.record.utime + sample.record.stime - first.record.utime - first.record.stime)
                   / self.config["clock_ticks"] / elapsed * 100) if elapsed > 0 else None
            threads.append({"tid": tid, "name": sample.record.comm, "group": thread.group["name"],
                            "state": sample.state, "cpu_pct": cpu, "state_mix": counts,
                            "syscall": sample.record.syscall, "futex_op": sample.record.futex_op,
                            "last_sample": sample.wall, "stale": now - sample.wall > max(10, self.interval * 3),
                            "generation": thread.generation})
        return {"threads": threads, "groups": dict(collections.Counter(item["group"] for item in threads)),
                "alerts": list(self.alerts.open.values()), "recent_alerts": list(reversed(self.alerts.recent))}

    def close(self):
        self.drain(self.last_seen or self.started, force=True)
        for tid, thread in self.threads.items():
            self.finish_window(tid, thread)
