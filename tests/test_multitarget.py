"""Check target routing and API isolation with real UDP and HTTP sockets."""

import json
from pathlib import Path
import socket
import sqlite3
import struct
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from wire import HEADER, RECORD

ROOT = Path(__file__).resolve().parents[1]
ANNOUNCE = struct.Struct("<4sBB2xQIIQQQII32s64s")


def announce(session, target, host="host-a", pid=123):
    return ANNOUNCE.pack(b"TTGT", 1, 0, session, pid, 5000,
                         1 if pid else 0, 1_000_000, 1_000_000_000,
                         5000, 0, target.encode(), host.encode())


def tick(session, pid=123, sequence=0, interval=200):
    now = time.time_ns()
    header = HEADER.pack(b"TMON", 2, 0 if pid else 1, 0, 1, session,
                         sequence, 1 if pid else 0, time.monotonic_ns(), now, interval, pid)
    record = RECORD.pack(pid, ord("S"), 0, 0, sequence, 0, 0, sequence,
                         0, 0, 0, f"target-{pid}".encode(), b"nanosleep") if pid else b""
    return header + record


class MultiTargetCollectorTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        with socket.socket() as http, socket.socket(type=socket.SOCK_DGRAM) as udp:
            http.bind(("127.0.0.1", 0))
            udp.bind(("127.0.0.1", 0))
            self.port = http.getsockname()[1]
            self.udp_port = udp.getsockname()[1]
        self.base = f"http://127.0.0.1:{self.port}"
        config = self.directory / "collector.toml"
        config.write_text(f'udp_host="127.0.0.1"\nudp_port={self.udp_port}\n'
                          f'http_port={self.port}\ndata_dir="{self.directory}/data"\n'
                          'max_targets=4\nmax_live_samples=10000\nreplay_interval_s=0.5\n'
                          'sampler_ips=["127.0.0.1","127.0.0.2"]\n')
        self.process = subprocess.Popen([ROOT / "build/triangulator-collector", config],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.addCleanup(self.stop)
        self.sender = socket.socket(type=socket.SOCK_DGRAM)
        self.addCleanup(self.sender.close)
        self.wait_for(lambda: self.fetch("/api/targets")["targets"] == [])

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
        _, stderr = self.process.communicate(timeout=10)
        self.assertEqual(self.process.returncode, 0, stderr.decode())

    def fetch(self, path):
        with urllib.request.urlopen(self.base + path, timeout=2) as response:
            return json.load(response)

    def send(self, data):
        self.sender.sendto(data, ("127.0.0.1", self.udp_port))

    def wait_for(self, condition):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                if condition():
                    return
            except (OSError, KeyError):
                pass
            self.assertIsNone(self.process.poll(), "collector exited")
            time.sleep(0.03)
        self.fail("collector condition did not become true")

    def test_interleaved_targets_reordered_announce_and_session_replacement(self):
        self.send(announce(101, "orders", pid=123))
        self.send(tick(101))
        self.send(tick(202, pid=456))  # Data arrives before its announcement.
        self.send(announce(202, "billing", pid=456))
        self.wait_for(lambda: len(self.fetch("/api/targets")["targets"]) == 2)
        for sequence in range(1, 8):
            self.send(tick(101, sequence=sequence))
            self.send(tick(202, pid=456, sequence=sequence))
            time.sleep(0.04)
        self.wait_for(lambda: len(self.fetch("/api/live?target=host-a/orders")["threads"]) == 1)
        with ThreadPoolExecutor(max_workers=8) as clients:
            paths = ["/api/live?target=host-a/" + target for target in ("orders", "billing") * 10]
            for path, view in zip(paths, clients.map(self.fetch, paths)):
                expected = 123 if path.endswith("orders") else 456
                self.assertEqual(view["health"]["pid"], expected)
                self.assertEqual([thread["tid"] for thread in view["threads"]], [expected])
        self.assertEqual(self.fetch("/api/live")["health"]["pid"], 456,
                         "the first key by host and id is the default")
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.fetch("/api/live?target=host-a/missing")
        self.assertEqual(error.exception.code, 404)
        error.exception.close()
        self.send(announce(303, "orders", pid=789))
        self.send(tick(303, pid=789))
        self.send(announce(101, "orders"))  # A delayed announce must not restore the old session.
        self.send(tick(101, sequence=99))
        self.wait_for(lambda: self.fetch("/api/live?target=host-a/orders")["health"]["pid"] == 789)
        self.assertEqual(self.fetch("/api/live?target=host-a/billing")["health"]["pid"], 456)
        self.wait_for(lambda: self.fetch("/api/replay?target=host-a/orders")["last"] is not None)
        bounds = self.fetch("/api/replay?target=host-a/orders")
        frame = self.fetch(f'/api/replay?target=host-a/orders&at={bounds["last"]}')["snapshot"]
        self.assertEqual(frame["target"], "host-a/orders")
        for path in (self.directory / "data").glob("*.sqlite3"):
            with sqlite3.connect(path) as database:
                rows = database.execute("SELECT session,host,target,pid FROM session_target").fetchall()
            self.assertIn(("202", "host-a", "billing", 456), rows)
            self.assertIn(("303", "host-a", "orders", 789), rows)

    def test_legacy_sampler_uses_default_and_sender_list_is_enforced(self):
        self.send(tick(111))
        self.wait_for(lambda: len(self.fetch("/api/targets")["targets"]) == 1)
        self.assertEqual(self.fetch("/api/targets")["targets"][0]["key"], "127.0.0.1/default")
        with socket.socket(type=socket.SOCK_DGRAM) as stranger:
            stranger.bind(("127.0.0.3", 0))
            stranger.sendto(announce(222, "unwanted"), ("127.0.0.1", self.udp_port))
        with socket.socket(type=socket.SOCK_DGRAM) as second:
            second.bind(("127.0.0.2", 0))
            second.sendto(announce(333, "gateway", host="host-b", pid=789),
                          ("127.0.0.1", self.udp_port))
            second.sendto(tick(333, pid=789), ("127.0.0.1", self.udp_port))
        self.wait_for(lambda: len(self.fetch("/api/targets")["targets"]) == 2)
        self.assertEqual(self.fetch("/api/live")["health"]["pid"], 123)
        self.assertEqual({target["host"] for target in self.fetch("/api/targets")["targets"]},
                         {"127.0.0.1", "host-b"})

    def test_lost_initial_announce_preserves_the_default_last_view(self):
        self.send(tick(111))
        self.wait_for(lambda: bool(self.fetch("/api/live").get("threads")))
        self.send(announce(222, "default", pid=0))
        self.send(tick(222, pid=0))
        self.wait_for(lambda: self.fetch("/api/live")["health"].get("target_absent"))
        self.assertEqual(self.fetch("/api/live")["health"]["last_target"]["session"], "111")
        self.assertEqual(len(self.fetch("/api/targets")["targets"]), 1)

    def test_capacity_and_bad_announcements_are_counted(self):
        for session in range(1, 6):
            self.send(announce(session, f"target-{session}"))
        self.send(announce(9, "../invalid"))
        self.wait_for(lambda: self.fetch("/api/targets").get("capacity_drops", 0) == 1)
        description = self.fetch("/api/targets")
        self.assertEqual(len(description["targets"]), 4)
        self.assertEqual(description["bad_packets"], 1)

    def targets(self):
        return {target["key"] for target in self.fetch("/api/targets")["targets"]}

    def test_sessions_heard_before_announcements_both_recover(self):
        # A restarted collector hears both ticks before either announcement.
        self.send(tick(101))
        self.send(tick(202, pid=456))
        self.send(announce(101, "orders"))
        self.send(announce(202, "billing", pid=456))
        self.wait_for(lambda: self.targets() == {"host-a/orders", "host-a/billing"})
        self.send(tick(101, sequence=1))
        self.send(tick(202, pid=456, sequence=1))
        self.wait_for(lambda: self.fetch("/api/live?target=host-a/orders")["health"]["pid"] == 123)
        self.wait_for(lambda: self.fetch("/api/live?target=host-a/billing")["health"]["pid"] == 456)

    def test_reused_slot_forgets_its_announced_identity(self):
        self.send(announce(101, "orders"))
        self.send(tick(101))
        self.send(tick(303, pid=789))
        self.send(announce(303, "orders", pid=789))  # Deactivates the first slot.
        self.wait_for(lambda: self.targets() == {"host-a/orders"})
        with socket.socket(type=socket.SOCK_DGRAM) as legacy:
            legacy.bind(("127.0.0.2", 0))
            legacy.sendto(tick(404, pid=321), ("127.0.0.1", self.udp_port))
        self.wait_for(lambda: self.targets() == {"host-a/orders", "127.0.0.2/default"})

    def test_legacy_samplers_record_replay_separately(self):
        with socket.socket(type=socket.SOCK_DGRAM) as other:
            other.bind(("127.0.0.2", 0))
            for sequence in range(3):
                self.send(tick(111, pid=123, sequence=sequence))
                other.sendto(tick(222, pid=456, sequence=sequence), ("127.0.0.1", self.udp_port))
                time.sleep(0.2)
        self.wait_for(lambda: self.targets() == {"127.0.0.1/default", "127.0.0.2/default"})
        for key, pid in (("127.0.0.1/default", 123), ("127.0.0.2/default", 456)):
            self.wait_for(lambda: self.fetch(f"/api/replay?target={key}")["last"] is not None)
            bounds = self.fetch(f"/api/replay?target={key}")
            frame = self.fetch(f'/api/replay?target={key}&at={bounds["last"]}')["snapshot"]
            self.assertEqual(frame["health"]["pid"], pid)

    def test_legacy_recording_owner_ignores_arrival_order(self):
        # 127.0.0.1 is the smallest allowed address, so its recordings stay in
        # data_dir/replay whichever sender arrives first.
        with socket.socket(type=socket.SOCK_DGRAM) as other:
            other.bind(("127.0.0.2", 0))
            for sequence in range(3):
                other.sendto(tick(222, pid=456, sequence=sequence), ("127.0.0.1", self.udp_port))
                time.sleep(0.2)
                self.send(tick(111, pid=123, sequence=sequence))
                time.sleep(0.2)
        self.wait_for(lambda: self.targets() == {"127.0.0.1/default", "127.0.0.2/default"})
        replay = self.directory / "data" / "replay"
        self.wait_for(lambda: replay.is_dir() and any(replay.iterdir()))
        key = b"127.0.0.2/default".hex()
        self.wait_for(lambda: (self.directory / "data" / "targets" / key / "replay").is_dir())
        self.assertFalse((self.directory / "data" / "targets" / b"127.0.0.1/default".hex()).exists())
        bounds = self.fetch("/api/replay?target=127.0.0.1/default")
        frame = self.fetch(f'/api/replay?target=127.0.0.1/default&at={bounds["last"]}')["snapshot"]
        self.assertEqual(frame["health"]["pid"], 123)

    def test_replaced_session_keeps_its_target_mapping(self):
        self.send(announce(101, "orders"))
        self.send(tick(101))
        self.send(announce(202, "orders", pid=456))  # Replaces 101 before a refresh.
        self.send(tick(202, pid=456))

        def mapped():
            for path in (self.directory / "data").glob("*.sqlite3"):
                with sqlite3.connect(path) as database:
                    rows = database.execute("SELECT session,target FROM session_target").fetchall()
                if ("101", "orders") in rows:
                    return True
            return False
        self.wait_for(mapped)

class MultiTargetSamplerTests(unittest.TestCase):
    def setUp(self):
        import signal
        self.signal = signal
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.config = Path(temporary.name) / "sampler.toml"
        self.receiver = socket.socket(type=socket.SOCK_DGRAM)
        self.receiver.bind(("127.0.0.1", 0))
        self.receiver.settimeout(4)
        self.addCleanup(self.receiver.close)
        self.targets = [subprocess.Popen(["sleep", "30"]) for _ in range(3)]
        self.sampler = None
        self.addCleanup(self.stop)

    def stop(self):
        if self.sampler is not None:
            self.sampler.terminate()
            _, stderr = self.sampler.communicate(timeout=5)
            self.assertEqual(self.sampler.returncode, 0, stderr.decode())
        for target in self.targets:
            if target.poll() is None:
                target.terminate()
            target.wait(timeout=5)

    def configure(self, entries, rate=5, heavy=False):
        text = (f'collector="127.0.0.1:{self.receiver.getsockname()[1]}"\nrate_hz={rate}\n'
                f'resource_interval_s={1 if heavy else 0}\nmemory_interval_s={1 if heavy else 0}\n')
        for index in entries:
            text += f'[[target]]\nid="target-{index}"\npid={self.targets[index].pid}\n'
        self.config.write_text(text)
        if self.sampler is None:
            self.sampler = subprocess.Popen([ROOT / "build/triangulator-sampler", self.config],
                                            stderr=subprocess.PIPE)
        else:
            self.sampler.send_signal(self.signal.SIGHUP)

    def collect_sessions(self, ids, old=None, changed=False):
        from wire import decode
        seen, announcements = {}, set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            data = self.receiver.recv(1500)
            if data.startswith(b"TTGT"):
                values = ANNOUNCE.unpack(data)
                announcements.add(values[3])
            if not data.startswith(b"TMON"):
                continue
            packet = decode(data)
            index = next((index for index in ids if self.targets[index].pid == packet.pid), None)
            if index is None:
                continue
            if old and (packet.session != old[index]) != changed:
                continue
            if not old or changed or index not in old:
                self.assertIn(packet.session, announcements, "announcement precedes the first tick")
            seen[index] = packet.session
            if set(seen) == set(ids):
                return seen
        self.fail("sampler did not send all target sessions")

    def test_one_process_keeps_unmodified_sessions_on_target_reload(self):
        self.configure([0, 1])
        first = self.collect_sessions([0, 1])
        self.assertEqual(len(set(first.values())), 2)
        self.assertEqual(len(list(Path(f"/proc/{self.sampler.pid}/task").iterdir())), 1)
        self.configure([1, 0, 2])
        after = self.collect_sessions([0, 1], first)
        self.assertEqual(after, first, "adding or reordering targets retains each session")
        self.collect_sessions([2])
        self.configure([0, 1, 2], rate=2)
        changed = self.collect_sessions([0, 1], first, changed=True)
        self.assertTrue(all(changed[index] != first[index] for index in first))
        self.targets[0].terminate()
        self.targets[0].wait(timeout=5)
        from wire import decode
        deadline = time.monotonic() + 5
        present = absent = False
        while time.monotonic() < deadline and not (present and absent):
            data = self.receiver.recv(1500)
            if data.startswith(b"TMON"):
                packet = decode(data)
                absent |= bool(packet.flags & 1)
                if packet.pid == self.targets[1].pid:
                    self.assertEqual(packet.session, changed[1], "another target exit keeps this session")
                    present = True
        self.assertTrue(present and absent)

    def test_heavy_scans_rotate_with_at_most_one_scan_per_tick(self):
        self.configure([0, 1], rate=5, heavy=True)
        from wire import decode
        scans = {}
        round_id = None
        sessions = set()
        deadline = time.monotonic() + 2.5
        while time.monotonic() < deadline:
            data = self.receiver.recv(1500)
            if data.startswith(b"TMON"):
                packet = decode(data)
                sessions.add(packet.session)
                if packet.pid == self.targets[0].pid:
                    round_id = packet.sequence
            elif data.startswith((b"TRES", b"TVMA")) and data[6] == 0:
                self.assertIsNotNone(round_id)
                self.assertNotIn(round_id, scans, "one heavy scan per sampler tick")
                scans[round_id] = (data[:4], struct.unpack_from("<Q", data, 8)[0])
        self.assertEqual(len(sessions), 2)
        self.assertEqual({kind for kind, _ in scans.values()}, {b"TRES", b"TVMA"})
        self.assertEqual({session for _, session in scans.values()}, sessions)
