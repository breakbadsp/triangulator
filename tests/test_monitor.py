import http.server
import json
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from triangulator.config import DEFAULT_ALERTS, RULE_NAMES, load, merge_settings, validate_alerts
from triangulator.engine import Monitor
from triangulator.protocol import HEADER, RECORD, Packet, Record, classify, decode
from triangulator.storage import SCHEMA, Storage, history


def record(**values):
    return Record(**{**dict(tid=42, state="S", flags=0, processor=0, utime=0, stime=0, run_delay=0,
                           timeslices=10, major_faults=0, read_bytes=0, write_bytes=0, comm="worker-1",
                           wchan="futex_do_wait"), **values})


def packet(sequence, records=None, **values):
    return Packet(**{**dict(flags=0, chunk=0, chunks=1, session=1, sequence=sequence,
                           monotonic_ns=(1000 + sequence) * 10**9,
                           wall_ns=(1700000000 + sequence) * 10**9, interval_ms=1000,
                           pid=123, records=tuple([record()] if records is None else records)), **values})


def encode(value):
    header = HEADER.pack(b"TMON", 2, value.flags, value.chunk, value.chunks, value.session,
                         value.sequence, len(value.records), value.monotonic_ns, value.wall_ns,
                         value.interval_ms, value.pid)
    body = b"".join(RECORD.pack(item.tid, ord(item.state), item.flags, item.processor, item.utime, item.stime,
                               item.run_delay, item.timeslices, item.major_faults, item.read_bytes,
                               item.write_bytes, item.comm.encode().ljust(16, b"\0"),
                               item.wchan.encode().ljust(32, b"\0")) for item in value.records)
    return header + body


class ProtocolTests(unittest.TestCase):
    def test_exact_wire_sizes_and_round_trip(self):
        self.assertEqual(HEADER.size, 48)
        self.assertEqual(RECORD.size, 112)
        value = packet(123, [record(comm="name ) ( space", wchan="", flags=1, read_bytes=2**64 - 1)],
                       session=2**64 - 1)
        self.assertEqual(decode(encode(value)), value)

    def test_reject_invalid_datagrams(self):
        for data in (b"", encode(packet(0))[:-1], encode(packet(0)) + b"x",
                     encode(packet(0, chunks=0)), encode(packet(0, flags=1)),
                     encode(packet(0, [record(), record()])), encode(packet(0, interval_ms=0)),
                     encode(packet(0, [record(flags=2)])), encode(packet(0, [record(tid=index) for index in range(1, 12)]))):
            with self.subTest(data=data):
                with self.assertRaises(ValueError):
                    decode(data)

    def test_classification_from_state_and_wait_channel(self):
        cases = [(record(state="D"), "kernel"), (record(state="R", wchan=""), "running"),
                 (record(state="t"), "stopped"), (record(), "futex"), (record(wchan="futex_wait_queue"), "futex"),
                 (record(wchan="do_epoll_wait"), "poll"), (record(wchan="poll_schedule_timeout"), "poll"),
                 (record(wchan="__skb_wait_for_more_packets"), "socket"),
                 (record(wchan="unix_stream_read_generic"), "socket"), (record(wchan="anon_pipe_read"), "pipe"),
                 (record(wchan="hrtimer_nanosleep"), "sleep"), (record(wchan="do_wait"), "other"),
                 (record(wchan=""), "no_access")]
        for sample, expected in cases:
            with self.subTest(wchan=sample.wchan, state=sample.state):
                self.assertEqual(classify(sample), expected)


class AlertSettingsTests(unittest.TestCase):
    def alerts(self):
        alerts = dict(DEFAULT_ALERTS)
        validate_alerts(alerts)
        return alerts

    def test_every_rule_defaults_to_enabled(self):
        self.assertEqual(self.alerts()["enabled"], {rule: True for rule in RULE_NAMES})

    def test_merge_validates_without_modifying_current_settings(self):
        current = self.alerts()
        merged = merge_settings(current, {"cpu_warn_pct": 70, "enabled": {"starved": False}})
        self.assertEqual((merged["cpu_warn_pct"], merged["enabled"]["starved"]), (70, False))
        self.assertEqual((current["cpu_warn_pct"], current["enabled"]["starved"]), (50, True))
        for changes in ({"cpu_warn_pct": 95}, {"cpu_sustain_secs": 0}, {"window_s": 7},
                        {"enabled": {"blocked": False}}, {"enabled": {"cpu_warn": "no"}},
                        {"enabled": "abc"}, {"enabled": ["cpu_warn"]}, {"enabled": None},
                        {"packet_loss_pct": float("nan")}, {"webhook_url": "http://x"}, []):
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    merge_settings(current, changes)


class ConfigTests(unittest.TestCase):
    def test_delivery_destinations_are_optional(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "collector.toml"
            path.write_text(f'data_dir = "{directory}"\n')
            config = load(path)
            self.assertFalse(config["alerts"].get("webhook_url"))
            self.assertFalse(config["alerts"].get("smtp"))

    def load_toml(self, text="", alerts=""):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "collector.toml"
            path.write_text(f'data_dir = "{directory}"\n{text}\n[alerts]\nwebhook_url = "http://127.0.0.1/"\n{alerts}\n')
            return load(path)

    def test_allowed_hosts_must_be_a_list(self):
        self.assertEqual(self.load_toml('http_allowed_hosts = ["Proxy.Example"]')["http_allowed_hosts"],
                         ["proxy.example"])
        for value in ('"proxy.example"', '[""]', "[1]"):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    self.load_toml(f"http_allowed_hosts = {value}")

    def test_dashboard_ranges_apply_to_toml(self):
        with self.assertRaises(ValueError):
            self.load_toml(alerts="reminder_secs = 30")
        self.assertEqual(self.load_toml(alerts="reminder_secs = 60")["alerts"]["reminder_secs"], 60)


class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.storage = Storage(self.directory.name)
        self.events = []
        self.config = dict(clock_ticks=100, max_live_samples=10000,
                           group=[dict(name="worker", prefix="worker-")], alerts=dict(DEFAULT_ALERTS))
        self.monitor = Monitor(self.config, self.storage, self.events.append, 1700000000)

    def tearDown(self):
        self.storage.close()
        self.directory.cleanup()

    def feed(self, sequence, samples=None, **values):
        value = packet(sequence, samples, **values)
        received = value.wall_ns / 1e9
        self.monitor.accept(value, received)
        self.monitor.drain(received, force=True)

    def opened(self, rule):
        return [event for event in self.events if event["rule"] == rule and event["status"] == "opened"]

    def test_hot_thread_opens_after_five_observed_seconds_and_resolves_after_five_cool_seconds(self):
        # Sample 1 is the first to measure CPU (over seconds 0..1), so the hot run starts there.
        for sequence in range(6):
            self.feed(sequence, [record(state="R", wchan="", utime=sequence * 95)])
        self.assertFalse(self.opened("cpu_critical"))
        self.feed(6, [record(state="R", wchan="", utime=6 * 95)])
        self.assertEqual(len(self.opened("cpu_critical")), 1)
        self.assertEqual(len(self.opened("cpu_warn")), 1)
        self.assertEqual(self.opened("cpu_critical")[0]["ts"], 1700000006)
        for sequence in range(7, 12):
            self.feed(sequence, [record(utime=6 * 95, timeslices=10 + sequence)])
        self.assertIn(("cpu_critical", "worker", 42), self.monitor.alerts.open)
        self.feed(12, [record(utime=6 * 95, timeslices=22)])
        self.assertNotIn(("cpu_critical", "worker", 42), self.monitor.alerts.open)

    def feed_at_10hz(self, start, samples):
        """Feed (seconds, utime) pairs as 10 Hz samples; sequence numbers continue from start."""
        for offset, (seconds, utime) in enumerate(samples):
            self.feed(start + offset, [record(state="R", utime=utime)], interval_ms=100,
                      monotonic_ns=round((1000 + seconds) * 1e9), wall_ns=round((1700000000 + seconds) * 1e9))

    def burst(self, burst_start, burst_end, until):
        """utime for a thread at 100% from burst_start to burst_end seconds, idle otherwise, sampled at 10 Hz."""
        samples = []
        for step in range(round(until * 10) + 1):
            seconds = step / 10
            busy = min(max(seconds, burst_start), burst_end) - burst_start
            samples.append((seconds, round(busy * 100)))
        return samples

    def test_burst_shorter_than_sustain_does_not_alert_at_10hz(self):
        self.feed_at_10hz(0, self.burst(1.0, 5.5, until=8))
        self.assertFalse(self.opened("cpu_warn"))

    def test_burst_longer_than_sustain_alerts_at_10hz(self):
        self.feed_at_10hz(0, self.burst(1.0, 7.5, until=9))
        self.assertEqual(len(self.opened("cpu_warn")), 1)

    def test_short_cpu_spike_and_moderate_cpu_do_not_alert(self):
        for sequence in range(4):
            self.feed(sequence, [record(state="R", utime=sequence * 100)])
        for sequence in range(4, 20):
            self.feed(sequence, [record(utime=300 + (sequence - 3) * 30)])
        self.assertFalse(self.opened("cpu_critical"))
        self.assertFalse(self.opened("cpu_warn"))

    def test_disabled_rule_never_opens_and_disabling_resolves_open_alerts(self):
        alerts = dict(self.config["alerts"])
        validate_alerts(alerts)
        self.monitor.apply_alert_settings(merge_settings(alerts, {"enabled": {"cpu_critical": False}}), 1700000000)
        for sequence in range(8):
            self.feed(sequence, [record(state="R", utime=sequence * 100)])
        self.assertFalse(self.opened("cpu_critical"))
        self.assertEqual(len(self.opened("cpu_warn")), 1)
        self.monitor.apply_alert_settings(merge_settings(self.config["alerts"], {"enabled": {"cpu_warn": False}}), 1700000008)
        self.assertEqual(self.monitor.alerts.open, {})
        self.assertEqual(self.events[-1]["detail"], "Alert rule disabled")
        self.monitor.apply_alert_settings(merge_settings(self.config["alerts"], {"cpu_warn_pct": 99.5, "cpu_crit_pct": 99.9,
                                                                                  "enabled": {"cpu_warn": True}}), 1700000008)
        for sequence in range(8, 16):
            self.feed(sequence, [record(state="R", utime=sequence * 100)])
        self.assertEqual(len(self.opened("cpu_warn")), 2)

    def test_raising_threshold_discards_evidence_from_old_threshold(self):
        alerts = dict(self.config["alerts"])
        validate_alerts(alerts)
        self.monitor.apply_alert_settings(merge_settings(alerts, {"cpu_sustain_secs": 20, "cpu_crit_pct": 99.5}), 1700000000)
        for sequence in range(21):  # 60% CPU for 20 measured seconds, just short of opening
            self.feed(sequence, [record(state="R", utime=sequence * 60)])
        self.assertFalse(self.opened("cpu_warn"))
        self.monitor.apply_alert_settings(merge_settings(self.config["alerts"], {"cpu_warn_pct": 80}), 1700000020)
        self.feed(21, [record(state="R", utime=20 * 60 + 100)])
        self.assertFalse(self.opened("cpu_warn"), "one second over 80% must not count as 20")
        for sequence in range(22, 42):
            self.feed(sequence, [record(state="R", utime=20 * 60 + (sequence - 20) * 100)])
        self.assertEqual(len(self.opened("cpu_warn")), 1, "20 seconds over the new threshold still alert")

    def test_futex_and_socket_waits_never_alert(self):
        for sequence in range(40):
            self.feed(sequence, [record(), record(tid=43, wchan="__skb_wait_for_more_packets", comm="io-1")])
        self.assertFalse([event for event in self.events if event["status"] == "opened"])

    def test_sampling_gap_restarts_cpu_duration(self):
        for sequence in list(range(4)) + list(range(7, 11)):
            self.feed(sequence, [record(state="R", utime=sequence * 100)])
        self.assertFalse(self.opened("cpu_critical"))
        for sequence in range(11, 14):
            self.feed(sequence, [record(state="R", utime=sequence * 100)])
        self.assertEqual(len(self.opened("cpu_critical")), 1)

    def test_kernel_and_starvation(self):
        for sequence in range(16):
            self.feed(sequence, [record(state="D", run_delay=sequence * 300000000)])
        self.assertEqual(len(self.opened("kernel_wait")), 1)
        self.assertEqual(len(self.opened("starved")), 1)

    def test_fallback_starvation(self):
        for sequence in range(16):
            self.feed(sequence, [record(state="R", run_delay=sequence)], flags=2)
        self.assertEqual(len(self.opened("starved")), 1)
        self.assertIsNone(self.monitor.threads[42].last_rollup["run_delay_pct"])

    def test_counter_reset_and_session_reset(self):
        self.feed(0, [record(utime=100)])
        self.feed(1, [record(utime=1)])
        self.assertEqual(self.monitor.threads[42].generation, 1)
        self.feed(2, [record(utime=1000)], session=2)
        self.assertEqual(self.monitor.threads[42].generation, 0)
        self.assertIsNone(self.monitor.threads[42].baseline)
        self.monitor.accept(packet(3, session=1), 1700000003)
        self.assertEqual(self.monitor.session, 2)

    def test_reordered_chunks_duplicates_partial_ticks_and_loss(self):
        self.monitor.accept(packet(1, [record(tid=43)], chunk=1, chunks=2), 1700000001)
        self.monitor.accept(packet(0), 1700000001.1)
        self.monitor.accept(packet(1, chunks=2), 1700000001.2)
        self.monitor.accept(packet(1, chunks=2), 1700000001.3)
        self.monitor.drain(1700000005)
        self.assertEqual(set(self.monitor.threads), {42, 43})
        self.assertEqual(self.monitor.duplicates, 1)
        self.monitor.accept(packet(2, chunks=2), 1700000006)
        self.monitor.drain(1700000009)
        self.assertEqual(set(self.monitor.threads), {42, 43})
        self.assertGreater(self.monitor.health(1700000009)["packet_loss_pct"], 0)
        self.monitor.accept(packet(2, [record(tid=43)], chunk=1, chunks=2), 1700000010)
        self.assertEqual(self.monitor.late_packets, 1)

    def test_health_absence_access_and_silence(self):
        self.feed(0, [], flags=1, pid=0)
        self.monitor.health(1700000005)
        self.assertEqual(len(self.opened("target_absent")), 1)
        self.monitor.health(1700000011)
        self.assertEqual(len(self.opened("sampler_silent")), 1)
        self.feed(12, [record(wchan="")])
        self.monitor.health(1700000012)
        self.assertEqual(len(self.opened("access_lost")), 1)

    def test_rollups_retention_and_bounded_memory(self):
        self.config["max_live_samples"] = 5
        for sequence in range(11):
            self.feed(sequence)
        self.assertLessEqual(self.monitor.raw_count, 5)
        self.storage.flush(1700000011)
        rows = history(self.directory.name, "1", 42, 1700000000, 1700000100)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["sample_counts"], {"futex": 5})
        self.storage.flush(1700000000 + 10 * 86400)
        self.assertEqual(list(Path(self.directory.name).glob("*.sqlite3")), [])

    def test_io_fault_and_switch_rates_in_rollup_and_snapshot(self):
        for sequence in range(11):
            self.feed(sequence, [record(wchan="do_epoll_wait", read_bytes=sequence * 4096,
                                        write_bytes=sequence * 100, major_faults=sequence, timeslices=sequence * 3)])
        row = self.monitor.threads[42].last_rollup
        self.assertAlmostEqual(row["read_bps"], 4096)
        self.assertAlmostEqual(row["write_bps"], 100)
        self.assertEqual(row["sample_counts"], {"poll": 5})
        live = self.monitor.snapshot(1700000010)["threads"][0]
        self.assertEqual(live["wchan"], "do_epoll_wait")
        self.assertAlmostEqual(live["read_bps"], 4096)
        self.assertAlmostEqual(live["switches_per_s"], 3)
        self.assertAlmostEqual(live["major_faults_per_s"], 1)
        self.feed(11, [record(flags=1, read_bytes=0)], session=2)
        self.feed(12, [record(flags=1, read_bytes=0)], session=2)
        self.assertIsNone(self.monitor.snapshot(1700000012)["threads"][0]["read_bps"])

    def test_unreadable_io_sample_does_not_reset_thread_or_fake_traffic(self):
        for sequence in range(3):
            self.feed(sequence, [record(read_bytes=5000, write_bytes=5000)])
        self.feed(3, [record(flags=1, read_bytes=0, write_bytes=0)])
        self.assertEqual(self.monitor.threads[42].generation, 0)
        self.assertIsNone(self.monitor.snapshot(1700000003)["threads"][0]["read_bps"])
        for sequence in range(4, 11):
            self.feed(sequence, [record(read_bytes=5000 + (sequence - 3) * 100, write_bytes=5000)])
        self.assertEqual(self.monitor.threads[42].generation, 0)
        live = self.monitor.snapshot(1700000010)["threads"][0]
        self.assertAlmostEqual(live["read_bps"], 70)  # 700 bytes over the 10 s since sample 0
        self.assertAlmostEqual(self.monitor.threads[42].last_rollup["read_bps"], 100)
        self.feed(11, [record(read_bytes=0, write_bytes=0)])
        self.assertEqual(self.monitor.threads[42].generation, 1, "a real counter drop is still tid reuse")

    def test_existing_day_file_gains_new_rollup_columns(self):
        path = Path(self.directory.name) / "2023-11-14.sqlite3"
        old = sqlite3.connect(path)
        old.executescript(SCHEMA.split("read_bps")[0].rstrip(", \n") + ", PRIMARY KEY(ts, session, tid, generation));")
        old.close()
        for sequence in range(11):
            self.feed(sequence)
        self.storage.flush(1700000011)
        rows = history(self.directory.name, "1", 42, 1700000000, 1700000100)
        self.assertEqual(rows[0]["read_bps"], 0)

    def test_alert_recovery_does_not_renotify_open_event(self):
        for sequence in range(8):
            self.feed(sequence, [record(state="R", utime=sequence * 100)])
        self.storage.flush(1700000008)
        events = []
        restored = Monitor(self.config, self.storage, events.append, 1700000008)
        self.assertIn(("cpu_critical", "worker", 42), restored.alerts.open)
        self.assertFalse(events)
        restored.accept(packet(22, [], flags=1, pid=0, session=2), 1700000022)
        restored.drain(1700000022, force=True)
        self.assertTrue(any(event["rule"] == "cpu_critical" and event["status"] == "resolved" for event in events))

    def test_recovered_alert_from_removed_rule_closes_quietly(self):
        self.storage.event(dict(ts=1700000000, rule="blocked", group="worker", tid=42, name="worker-1",
                                detail="blocked: sustained over 15s", status="opened", severity="warning",
                                session="1"))
        self.storage.flush(1700000001)
        events = []
        restored = Monitor(self.config, self.storage, events.append, 1700000001)
        self.assertNotIn(("blocked", "worker", 42), restored.alerts.open)
        self.assertFalse(events)
        self.storage.flush(1700000002)
        self.assertEqual(Monitor(self.config, self.storage, events.append, 1700000002).alerts.open, {})

    def test_lowest_rate_produces_valid_delta_windows(self):
        for sequence in range(5):
            self.feed(sequence, [record(state="R", utime=sequence * 500)], interval_ms=5000,
                      monotonic_ns=(1000 + sequence * 5) * 10**9,
                      wall_ns=(1700000000 + sequence * 5) * 10**9)
        self.assertEqual(len(self.opened("cpu_critical")), 1)

    def test_sequence_wrap_is_not_packet_loss(self):
        for sequence, monotonic in ((2**32 - 1, 1000), (0, 1001)):
            self.feed(sequence, monotonic_ns=monotonic * 10**9, wall_ns=(1700000000 + monotonic) * 10**9)
        self.assertEqual(sum(entry[2] for entry in self.monitor.loss), 0)


class SamplerTests(unittest.TestCase):
    def test_real_proc_wire_format_reload_and_absent_heartbeat(self):
        binary = Path(__file__).resolve().parents[1] / "build/triangulator-sampler"
        with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
            receiver.bind(("127.0.0.1", 0))
            receiver.settimeout(3)
            target = subprocess.Popen(["sleep", "20"])
            config = Path(directory) / "sampler.toml"
            config.write_text(f'target_pid = {target.pid}\nrate_hz = 10\ncollector = "127.0.0.1:{receiver.getsockname()[1]}"\n')
            sampler = subprocess.Popen([str(binary), str(config)], stderr=subprocess.PIPE, text=True)
            try:
                first = decode(receiver.recv(1200))
                self.assertEqual(first.pid, target.pid)
                self.assertEqual(first.records[0].comm, "sleep")
                self.assertEqual(classify(first.records[0]), "sleep", first.records[0].wchan)
                self.assertFalse(first.records[0].flags & 1, "per-thread io must be readable as the same UID")
                self.assertEqual(first.interval_ms, 100)
                config.write_text(f'target_pid = {target.pid}\nrate_hz = 99\ncollector = "127.0.0.1:{receiver.getsockname()[1]}"\n')
                sampler.send_signal(signal.SIGHUP)
                for _ in range(3):
                    unchanged = decode(receiver.recv(1200))
                    self.assertEqual(unchanged.session, first.session)
                    self.assertEqual(unchanged.interval_ms, 100)
                self.assertIsNone(sampler.poll())
                config.write_text(f'target_pid = {target.pid}\nrate_hz = 5\nstatus_fallback = true\ncollector = "127.0.0.1:{receiver.getsockname()[1]}"\n')
                sampler.send_signal(signal.SIGHUP)
                for _ in range(10):
                    value = decode(receiver.recv(1200))
                    if value.session != first.session:
                        break
                self.assertEqual(value.interval_ms, 200)
                self.assertEqual(value.flags, 2)
                target.terminate()
                target.wait(timeout=3)
                for _ in range(10):
                    absent = decode(receiver.recv(1200))
                    if absent.flags & 1:
                        break
                self.assertEqual(absent.flags, 3)
                self.assertEqual(absent.records, ())
                self.assertNotEqual(absent.session, value.session)
            finally:
                sampler.terminate()
                sampler.communicate(timeout=3)
                if target.poll() is None:
                    target.terminate()
                target.wait(timeout=3)

    def test_named_target_chunking_thread_names_and_descriptor_cleanup(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
            receiver.bind(("127.0.0.1", 0))
            receiver.settimeout(3)
            target = subprocess.Popen([sys.executable, str(root / "tests/sampler_target.py")],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            sampler = None
            try:
                name = target.stdout.readline().strip()
                self.assertTrue(name.startswith("tmon-"))
                config = Path(directory) / "sampler.toml"
                config.write_text(f'target_process="{name}"\nrate_hz=10\ncollector="127.0.0.1:{receiver.getsockname()[1]}"\n')
                sampler = subprocess.Popen([str(root / "build/triangulator-sampler"), str(config)],
                                           stderr=subprocess.PIPE, text=True)
                chunks = {}
                for _ in range(20):
                    datagram = receiver.recv(1200)
                    value = decode(datagram)
                    self.assertLessEqual(len(datagram), 1168)
                    self.assertEqual(value.chunks, 3)
                    chunks.setdefault(value.sequence, {})[value.chunk] = value.records
                    if len(chunks[value.sequence]) == 3:
                        records = [item for chunk in chunks[value.sequence].values() for item in chunk]
                        break
                else:
                    self.fail("sampler did not emit a complete multi-packet tick")
                self.assertEqual(len(records), 26)
                self.assertEqual(len({item.tid for item in records}), 26)
                self.assertEqual({item.comm for item in records}, {name} | {f"worker ) ( {index}" for index in range(25)})
                descriptors = Path(f"/proc/{sampler.pid}/fd")
                self.assertGreaterEqual(len(list(descriptors.iterdir())), 26 * 3)
                target.stdin.write("release\n")
                target.stdin.flush()
                self.assertEqual(target.stdout.readline().strip(), "released")
                for _ in range(30):
                    value = decode(receiver.recv(1200))
                    if value.chunks == 1 and len(value.records) == 1:
                        break
                else:
                    self.fail("exited threads remain in the sampler cache")
                self.assertEqual(value.records[0].comm, name)
                self.assertLessEqual(len(list(descriptors.iterdir())), 12)
                self.assertEqual(len(list(Path(f"/proc/{sampler.pid}/task").iterdir())), 1)
            finally:
                if sampler is not None:
                    sampler.terminate()
                    sampler.communicate(timeout=3)
                target.terminate()
                target.communicate(timeout=3)


class DescriptorLimitTests(unittest.TestCase):
    def test_low_descriptor_limit_keeps_every_thread_and_one_session(self):
        """Caching 4 descriptors per thread must not exhaust RLIMIT_NOFILE and make a live target look absent."""
        import resource
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
            receiver.bind(("127.0.0.1", 0))
            receiver.settimeout(3)
            target = subprocess.Popen([sys.executable, str(root / "tests/sampler_target.py")],
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            sampler = None
            try:
                name = target.stdout.readline().strip()
                config = Path(directory) / "sampler.toml"
                config.write_text(f'target_process="{name}"\nrate_hz=10\ncollector="127.0.0.1:{receiver.getsockname()[1]}"\n')
                # 26 threads x 4 descriptors = 104 cached descriptors, more than the limit.
                sampler = subprocess.Popen([str(root / "build/triangulator-sampler"), str(config)], stderr=subprocess.PIPE,
                                           text=True, preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_NOFILE, (96, 96)))
                ticks, sessions, absent = {}, set(), 0
                for _ in range(200):
                    if len([tick for tick in ticks.values() if len(tick) == 3]) >= 15:
                        break
                    value = decode(receiver.recv(1200))
                    sessions.add(value.session)
                    if value.flags & 1:
                        absent += 1
                        continue
                    ticks.setdefault(value.sequence, {})[value.chunk] = value.records
                complete = [tick for tick in ticks.values() if len(tick) == 3]
                self.assertEqual(absent, 0, "a live target was reported absent")
                self.assertGreaterEqual(len(complete), 15, "too few complete ticks")
                self.assertEqual(len(sessions), 1, "the session was reset")
                for tick in complete:
                    self.assertEqual(sum(len(records) for records in tick.values()), 26)
            finally:
                if sampler is not None:
                    sampler.terminate()
                    sampler.communicate(timeout=3)
                target.stdin.write("release\n")
                target.stdin.flush()
                target.terminate()
                target.communicate(timeout=3)


ROOT = Path(__file__).resolve().parents[1]
PYTHON_COLLECTOR = [sys.executable, "-B", "-m", "triangulator"]
CPP_COLLECTOR = [str(ROOT / "build/triangulator-collector")]


def free_port(kind):
    with socket.socket(socket.AF_INET, kind) as reservation:
        reservation.bind(("127.0.0.1", 0))
        return reservation.getsockname()[1]


class CollectorIntegrationTests(unittest.TestCase):
    def test_sampler_collector_dashboard_history_and_webhook(self):
        root = ROOT
        notifications = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                notifications.append(json.loads(self.rfile.read(int(self.headers["Content-Length"]))))
                self.send_response(204)
                self.end_headers()

            def log_message(self, *_):
                pass

        with tempfile.TemporaryDirectory() as directory:
            webhook = http.server.HTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=webhook.serve_forever, daemon=True)
            thread.start()
            with socket.socket() as reservation:
                reservation.bind(("127.0.0.1", 0))
                http_port = reservation.getsockname()[1]
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as reservation:
                reservation.bind(("127.0.0.1", 0))
                udp_port = reservation.getsockname()[1]
            collector_config = Path(directory) / "collector.toml"
            collector_config.write_text(
                f'udp_host="127.0.0.1"\nudp_port={udp_port}\nhttp_port={http_port}\n'
                f'data_dir="{directory}/data"\n[alerts]\ntarget_absent_secs=1\n'
                f'webhook_url="http://127.0.0.1:{webhook.server_port}/"\n')
            target = subprocess.Popen(["sleep", "30"])
            sampler_config = Path(directory) / "sampler.toml"
            sampler_config.write_text(f'target_pid={target.pid}\nrate_hz=10\ncollector="127.0.0.1:{udp_port}"\n')
            collector = subprocess.Popen([*PYTHON_COLLECTOR, str(collector_config)],
                                         cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            sampler = subprocess.Popen([str(root / "build/triangulator-sampler"), str(sampler_config)],
                                       stderr=subprocess.PIPE, text=True)
            base = f"http://127.0.0.1:{http_port}"

            def fetch(path):
                with urllib.request.urlopen(base + path, timeout=2) as response:
                    return response.read()

            try:
                deadline = time.monotonic() + 10
                rows = []
                while time.monotonic() < deadline:
                    if collector.poll() is not None:
                        self.fail(collector.communicate()[1])
                    try:
                        live = json.loads(fetch("/api/live"))
                        if live.get("threads"):
                            session = live["health"]["session"]
                            rows = json.loads(fetch(f"/api/history?session={session}&tid={target.pid}"))["rows"]
                            if rows:
                                break
                    except (OSError, KeyError):
                        pass
                    time.sleep(0.1)
                self.assertTrue(rows, "collector did not persist a live thread rollup")
                self.assertIn(b"Triangulator", fetch("/"))
                self.assertFalse(live["health"]["sampler_silent"])
                self.assertEqual(live["threads"][0]["name"], "sleep")

                def post(body, headers=None):
                    request = urllib.request.Request(base + "/api/alert-settings", data=json.dumps(body).encode(),
                                                     method="POST", headers=headers if headers is not None else
                                                     {"Content-Type": "application/json", "X-Triangulator": "1"})
                    try:
                        with urllib.request.urlopen(request, timeout=8) as response:
                            return response.status, json.loads(response.read())
                    except urllib.error.HTTPError as error:
                        return error.code, json.loads(error.read())

                settings = json.loads(fetch("/api/alert-settings"))
                self.assertEqual(settings["values"]["cpu_warn_pct"], 50)
                self.assertFalse(settings["saved"])
                self.assertEqual(post({"cpu_warn_pct": 60}, {"Content-Type": "application/json"})[0], 400)
                self.assertEqual(post({"cpu_warn_pct": 60}, {"Content-Type": "application/json", "X-Triangulator": "1",
                                                              "Origin": "http://evil.example"})[0], 403)
                self.assertEqual(post({"cpu_warn_pct": 60}, {"Content-Type": "application/json", "X-Triangulator": "1",
                                                              "Host": "evil.example"})[0], 403)
                self.assertEqual(post({"cpu_warn_pct": 95})[0], 400)
                self.assertEqual(post({"enabled": "abc"})[0], 400)
                self.assertIsNone(collector.poll(), "a malformed settings request must not stop the collector")
                status, settings = post({"cpu_warn_pct": 60, "enabled": {"target_absent": False}})
                self.assertEqual(status, 200)
                self.assertEqual((settings["values"]["cpu_warn_pct"], settings["saved"]), (60, True))
                saved = json.loads((Path(directory) / "data/alert-settings.json").read_text())
                self.assertEqual(saved["enabled"]["target_absent"], False)
                status, settings = post({"reset": True})
                self.assertEqual((status, settings["values"]["cpu_warn_pct"], settings["saved"]), (200, 50, False))
                self.assertFalse((Path(directory) / "data/alert-settings.json").exists())
                target.terminate()
                target.wait(timeout=3)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not any(event["rule"] == "target_absent" for event in notifications):
                    time.sleep(0.1)
                self.assertTrue(any(event["rule"] == "target_absent" and event["status"] == "opened" for event in notifications))
            finally:
                for process in (sampler, collector, target):
                    if process.poll() is None:
                        process.terminate()
                    process.communicate(timeout=8)
                webhook.shutdown()
                webhook.server_close()
                thread.join(timeout=2)



class CppCollectorIntegrationTests(unittest.TestCase):
    """The C++ core collector: live data, history and no alerting."""

    def test_sampler_cpp_collector_dashboard_and_history_without_alerting(self):
        with tempfile.TemporaryDirectory() as directory:
            udp_port, http_port = free_port(socket.SOCK_DGRAM), free_port(socket.SOCK_STREAM)
            collector_config = Path(directory) / "collector.toml"
            # Alert settings from a Python-collector config are accepted and ignored.
            collector_config.write_text(
                f'udp_host="127.0.0.1"\nudp_port={udp_port}\nhttp_port={http_port}\n'
                f'data_dir="{directory}/data"\ndeadman_url="http://127.0.0.1:9/"\n'
                '[alerts]\nwindow_s=5\ncpu_warn_pct=60\nwebhook_url="http://127.0.0.1:9/"\n')
            invalid = Path(directory) / "invalid.toml"
            invalid.write_text("[alerts]\nwindow_s=4\n")
            checked = subprocess.run([*CPP_COLLECTOR, str(invalid), "--check-config"], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 2)
            self.assertIn("window_s must be 5..10", checked.stderr)
            target = subprocess.Popen(["sleep", "30"])
            sampler_config = Path(directory) / "sampler.toml"
            sampler_config.write_text(f'target_pid={target.pid}\nrate_hz=10\ncollector="127.0.0.1:{udp_port}"\n')
            collector = subprocess.Popen([*CPP_COLLECTOR, str(collector_config)], cwd=ROOT,
                                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            sampler = subprocess.Popen([str(ROOT / "build/triangulator-sampler"), str(sampler_config)],
                                       stderr=subprocess.PIPE, text=True)
            base = f"http://127.0.0.1:{http_port}"

            def fetch(path, method="GET"):
                request = urllib.request.Request(base + path, method=method,
                                                 data=b"{}" if method == "POST" else None)
                try:
                    with urllib.request.urlopen(request, timeout=2) as response:
                        return response.status, response.read()
                except urllib.error.HTTPError as error:
                    with error:
                        return error.code, error.read()

            try:
                deadline = time.monotonic() + 10
                rows, live = [], {}
                while time.monotonic() < deadline:
                    if collector.poll() is not None:
                        self.fail(collector.communicate()[1])
                    try:
                        live = json.loads(fetch("/api/live")[1])
                        if live.get("threads"):
                            session = live["health"]["session"]
                            rows = json.loads(fetch(f"/api/history?session={session}&tid={target.pid}")[1])["rows"]
                            if rows:
                                break
                    except (OSError, KeyError, ValueError):
                        pass
                    time.sleep(0.1)
                self.assertTrue(rows, "collector did not persist a live thread rollup")
                self.assertEqual(live["threads"][0]["name"], "sleep")
                self.assertFalse(live["health"]["sampler_silent"])
                self.assertNotIn("alerts", live)
                self.assertNotIn("recent_alerts", live)
                status, page = fetch("/")
                self.assertEqual(status, 200)
                self.assertIn(b"showAlerting", page)
                self.assertEqual(fetch("/api/alert-settings")[0], 404)
                self.assertEqual(fetch("/api/alert-settings", "POST")[0], 501)
                self.assertEqual(fetch("/api/history?session=1")[0], 400)
            finally:
                for process in (sampler, collector, target):
                    if process.poll() is None:
                        process.terminate()
                stderr = collector.communicate(timeout=8)[1]
                sampler.communicate(timeout=8)
                target.wait(timeout=8)
            self.assertIn("Alerting is not part of the C++ collector", stderr)
            self.assertFalse((Path(directory) / "data/alert-settings.json").exists())
            for path in (Path(directory) / "data").glob("????-??-??.sqlite3"):
                with sqlite3.connect(path) as connection:
                    self.assertEqual(connection.execute("SELECT COUNT(*) FROM alert_event").fetchone()[0], 0)


class CollectorParityTests(unittest.TestCase):
    """Both collectors store the same rollups for the same datagrams."""

    def test_python_and_cpp_collectors_store_identical_rollups(self):
        with tempfile.TemporaryDirectory() as directory:
            collectors = []
            for name, command in (("python", PYTHON_COLLECTOR), ("cpp", CPP_COLLECTOR)):
                udp_port, http_port = free_port(socket.SOCK_DGRAM), free_port(socket.SOCK_STREAM)
                config = Path(directory) / f"{name}.toml"
                config.write_text(f'udp_host="127.0.0.1"\nudp_port={udp_port}\nhttp_port={http_port}\n'
                                  f'sampler_ip="127.0.0.1"\ndata_dir="{directory}/{name}"\n'
                                  '[[group]]\nname="worker"\nprefix="worker-"\n')
                process = subprocess.Popen([*command, str(config)], cwd=ROOT,
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                collectors.append((name, process, udp_port, http_port))
            try:
                for name, process, _udp, http_port in collectors:
                    deadline = time.monotonic() + 10
                    while True:
                        self.assertIsNone(process.poll(), f"{name} collector exited")
                        try:
                            urllib.request.urlopen(f"http://127.0.0.1:{http_port}/api/live", timeout=1).read()
                            break
                        except OSError:
                            self.assertLess(time.monotonic(), deadline, f"{name} collector did not start")
                            time.sleep(0.1)
                start_wall = int(time.time()) - 60
                datagrams = []
                for sequence in range(300):
                    # 12 threads in two chunks at 10 Hz: one hot, one starved,
                    # one stuck in D, the rest idle on futexes.
                    records = []
                    for index in range(12):
                        values = dict(tid=100 + index, comm=f"worker-{index}", timeslices=sequence)
                        if index == 0:
                            values.update(state="R", utime=sequence * 10, wchan="")
                        elif index == 1:
                            values.update(state="R", utime=sequence // 10, run_delay=sequence * 50_000_000, wchan="")
                        elif index == 2:
                            values.update(state="D", wchan="io_schedule")
                        records.append(record(**values))
                    tick = dict(session=7, sequence=sequence, chunks=2, interval_ms=100,
                                monotonic_ns=(5000 + sequence) * 10**8,
                                wall_ns=start_wall * 10**9 + sequence * 10**8)
                    chunks = [encode(packet(sequence, records[:10], chunk=0, **{k: v for k, v in tick.items() if k != "sequence"})),
                              encode(packet(sequence, records[10:], chunk=1, **{k: v for k, v in tick.items() if k != "sequence"}))]
                    # Reorder every fifth tick's chunks and repeat every seventh datagram.
                    datagrams += reversed(chunks) if sequence % 5 == 0 else chunks
                    if sequence % 7 == 0:
                        datagrams.append(chunks[0])
                with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender:
                    sender.bind(("127.0.0.1", 0))
                    for offset, datagram in enumerate(datagrams):
                        for _name, _process, udp_port, _http in collectors:
                            sender.sendto(datagram, ("127.0.0.1", udp_port))
                        if offset % 50 == 0:
                            time.sleep(0.01)
                time.sleep(1.5)
            finally:
                for _name, process, _udp, _http in collectors:
                    process.terminate()
                    process.communicate(timeout=8)

            def stored(name):
                rows = []
                for path in sorted((Path(directory) / name).glob("????-??-??.sqlite3")):
                    with sqlite3.connect(path) as connection:
                        connection.row_factory = sqlite3.Row
                        rows += [dict(row) for row in connection.execute(
                            "SELECT * FROM thread_rollup ORDER BY ts, tid, generation")]
                return rows

            python_rows, cpp_rows = stored("python"), stored("cpp")
            self.assertGreater(len(python_rows), 50)
            self.assertEqual(len(cpp_rows), len(python_rows))
            for python_row, cpp_row in zip(python_rows, cpp_rows):
                self.assertEqual(python_row.keys(), cpp_row.keys())
                for column, value in python_row.items():
                    if isinstance(value, float):
                        self.assertAlmostEqual(value, cpp_row[column], places=9, msg=(column, python_row, cpp_row))
                    else:
                        self.assertEqual(value, cpp_row[column], (column, python_row, cpp_row))


class CompareScriptTests(unittest.TestCase):
    """scripts/compare.py must never deliver alerts or leave processes running."""

    @classmethod
    def setUpClass(cls):
        import importlib.util
        spec = importlib.util.spec_from_file_location("compare", ROOT / "scripts/compare.py")
        cls.compare = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.compare)

    def test_alert_delivery_is_removed_however_it_is_written(self):
        import tomllib
        variants = [
            '[alerts.smtp] # comment\nhost = "smtp.example.com"\nfrom = "a@example.com"\nto = ["b@example.com"]\n',
            '[ alerts . smtp ]\nhost = "smtp.example.com"\nfrom = "a@example.com"\nto = "b@example.com"\n',
            '[alerts]\nsmtp = { host = "smtp.example.com", from = "a@example.com", to = "b@example.com" }\n',
            'alerts.smtp.host = "smtp.example.com"\nalerts.webhook_url = "https://hooks.example.com/x"\n',
            '[alerts] # thresholds\nwebhook_url = "https://hooks.example.com/x"  # live\ncpu_warn_pct = 60\n',
        ]
        for variant in variants:
            with self.subTest(variant=variant):
                text = 'deadman_url = "https://ping.example.com/x"\n' + variant + '[[group]]\nname = "io"\nprefix = "io-"\n'
                result = tomllib.loads(self.compare.comparison_config(text, {"udp_port": 9501, "data_dir": "/tmp/x"}))
                self.assertNotIn("deadman_url", result)
                self.assertNotIn("smtp", result.get("alerts", {}))
                self.assertNotIn("webhook_url", result.get("alerts", {}))
                self.assertEqual((result["udp_port"], result["data_dir"]), (9501, "/tmp/x"))
                self.assertEqual(result["group"], [{"name": "io", "prefix": "io-"}])
        kept = tomllib.loads(self.compare.comparison_config('[alerts]\ncpu_warn_pct = 60.5\n', {}))
        self.assertEqual(kept["alerts"], {"cpu_warn_pct": 60.5})
        config_text = (ROOT / "config/collector.toml").read_text()
        self.assertEqual({key: value for key, value in tomllib.loads(config_text).items()
                          if key not in ("alerts", "deadman_url")},
                         {key: value for key, value in tomllib.loads(
                             self.compare.comparison_config(config_text, {})).items() if key != "alerts"})

    def test_invalid_arguments_fail_before_anything_starts(self):
        for arguments, message in (
            (["--synthetic-threads", "3000"], "--synthetic-threads must be 1..2550"),
            (["--rate-hz", "0"], "--rate-hz must be 0.2..10"),
            (["--refresh", "0"], "--refresh and --duration must be positive"),
            (["--port", "65530"], "--port must be"),
        ):
            with self.subTest(arguments=arguments):
                started = time.monotonic()
                result = subprocess.run([sys.executable, str(ROOT / "scripts/compare.py"), *arguments],
                                        capture_output=True, text=True, timeout=20)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertIn(message, result.stderr)
                self.assertNotIn("Stopped", result.stdout)
                self.assertLess(time.monotonic() - started, 5, "the script started work before validating")


if __name__ == "__main__":
    unittest.main()
