import datetime
import json
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from wire import RESOURCE_SOCKETS, RESOURCE_SUMMARY, classify, decode, decode_resource, receive_tick


def wait_until_asleep(pid, timeout=5):
    # A process started a moment ago may still be running or loading its
    # program. Wait until it sleeps in nanosleep, so a test that classifies
    # its first sample doesn't race its startup.
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if "nanosleep" in Path(f"/proc/{pid}/wchan").read_text():
            return
        time.sleep(0.01)
    raise AssertionError(f"process {pid} did not reach nanosleep within {timeout} s")


class SamplerTests(unittest.TestCase):
    def test_real_proc_wire_format_reload_and_absent_heartbeat(self):
        binary = Path(__file__).resolve().parents[1] / "build/triangulator-sampler"
        with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
            receiver.bind(("127.0.0.1", 0))
            receiver.settimeout(3)
            target = subprocess.Popen(["sleep", "20"])
            wait_until_asleep(target.pid)
            config = Path(directory) / "sampler.toml"
            config.write_text(f'target_pid = {target.pid}\nrate_hz = 10\ncollector = "127.0.0.1:{receiver.getsockname()[1]}"\n')
            sampler = subprocess.Popen([str(binary), str(config)], stderr=subprocess.PIPE, text=True)
            try:
                first = decode(receive_tick(receiver))
                self.assertEqual(first.pid, target.pid)
                self.assertEqual(first.records[0].comm, "sleep")
                self.assertEqual(classify(first.records[0]), "sleep", first.records[0].wchan)
                self.assertFalse(first.records[0].flags & 1, "per-thread io must be readable as the same UID")
                self.assertEqual(first.interval_ms, 100)
                config.write_text(f'target_pid = {target.pid}\nrate_hz = 99\ncollector = "127.0.0.1:{receiver.getsockname()[1]}"\n')
                sampler.send_signal(signal.SIGHUP)
                for _ in range(3):
                    unchanged = decode(receive_tick(receiver))
                    self.assertEqual(unchanged.session, first.session)
                    self.assertEqual(unchanged.interval_ms, 100)
                self.assertIsNone(sampler.poll())
                config.write_text(f'target_pid = {target.pid}\nrate_hz = 5\nstatus_fallback = true\ncollector = "127.0.0.1:{receiver.getsockname()[1]}"\n')
                sampler.send_signal(signal.SIGHUP)
                for _ in range(10):
                    value = decode(receive_tick(receiver))
                    if value.session != first.session:
                        break
                self.assertEqual(value.interval_ms, 200)
                self.assertEqual(value.flags, 2)
                target.terminate()
                target.wait(timeout=3)
                for _ in range(10):
                    absent = decode(receive_tick(receiver))
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

    def test_check_config_uses_the_sampler_parser_and_does_not_sample(self):
        binary = Path(__file__).resolve().parents[1] / "build/triangulator-sampler"
        with tempfile.TemporaryDirectory() as directory, socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
            receiver.bind(("127.0.0.1", 0))
            receiver.settimeout(0.5)
            port = receiver.getsockname()[1]
            config = Path(directory) / "sampler.toml"

            def check(text):
                config.write_text(text)
                return subprocess.run([str(binary), "--check-config", str(config)],
                                      capture_output=True, text=True, timeout=5)

            # Valid for the sampler, though not TOML: unquoted values and a backslash.
            checked = check(f"target_process = a\\q\nrate_hz = 5\ncollector = 127.0.0.1:{port}\n")
            self.assertEqual(checked.returncode, 0, checked.stderr)
            self.assertIn("valid", checked.stdout)
            with self.assertRaises(TimeoutError):
                receiver.recv(1200)
            for text, error in (
                    (f'target_pid = 1\nrate_hz = 99\ncollector = "127.0.0.1:{port}"\n', "rate_hz"),
                    (f'target_pid = 1\ntarget_process = "x"\ncollector = "127.0.0.1:{port}"\n', "exactly one"),
                    (f'target_pid = 1\ncollector = "127.0.0.1:{port}"\n' + "#" * 16384 + "\n", "16 KiB")):
                checked = check(text)
                self.assertEqual(checked.returncode, 2, text[:80])
                self.assertIn(error, checked.stderr)
            usage = subprocess.run([str(binary), "--check", str(config)], capture_output=True, text=True, timeout=5)
            self.assertEqual(usage.returncode, 2)
            self.assertIn("usage", usage.stderr)

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
                    datagram = receive_tick(receiver)
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
                    value = decode(receive_tick(receiver))
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
                    value = decode(receive_tick(receiver))
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
CPP_COLLECTOR = [str(ROOT / "build/triangulator-collector")]

# A target with a listener and a connection whose received bytes it never
# reads, so its sockets have something to report.
SOCKET_TARGET = """
import socket, sys, time
listener = socket.socket()
listener.bind(("127.0.0.1", 0))
listener.listen(8)
client = socket.create_connection(listener.getsockname())
server, _ = listener.accept()
client.sendall(b"x" * 4096)
print(listener.getsockname()[1], server.fileno(), flush=True)
time.sleep(60)
"""


class ResourceSampleTests(unittest.TestCase):
    """The sampler's resource datagrams, read from a real sampler."""

    def run_sampler(self, extra):
        receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.addCleanup(receiver.close)
        receiver.bind(("127.0.0.1", 0))
        receiver.settimeout(3)
        # /dev/null for the inherited descriptors, so the target's own sockets
        # are the only ones it has.
        target = subprocess.Popen([sys.executable, "-c", SOCKET_TARGET], stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        self.addCleanup(lambda: (target.terminate(), target.wait(timeout=5)))
        port, server_fd = (int(value) for value in target.stdout.readline().split())
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        config = Path(directory.name) / "sampler.toml"
        config.write_text(f'target_pid = {target.pid}\nrate_hz = 10\n'
                          f'collector = "127.0.0.1:{receiver.getsockname()[1]}"\n{extra}')
        sampler = subprocess.Popen([str(ROOT / "build/triangulator-sampler"), str(config)],
                                   stderr=subprocess.PIPE, text=True)
        self.addCleanup(lambda: (sampler.terminate(), sampler.communicate(timeout=5)))
        return receiver, target, port, server_fd

    def test_resource_sample_describes_the_target(self):
        receiver, target, port, server_fd = self.run_sampler("resource_interval_s = 1\n")
        parts, ticks = {}, set()
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            data = receiver.recv(1500)
            if not data.startswith(b"TRES"):
                ticks.add(decode(data).session)
                continue
            self.assertLessEqual(len(data), 1400)
            part = decode_resource(data)
            parts.setdefault(part.sequence, {})[part.part] = (part, data)
            if len(parts) >= 2 and len(parts[min(parts)]) == part.parts:
                break
        summary = parts[min(parts)][0][0]
        self.assertEqual(summary.kind, RESOURCE_SUMMARY)
        self.assertEqual(summary.pid, target.pid)
        self.assertEqual(summary.interval_ms, 1000)
        self.assertEqual(ticks, {summary.session}, "resource samples share the thread session")
        self.assertEqual(summary.flags, 0, "nothing is hidden from the target's own user")
        values = summary.values
        self.assertEqual(values["fd_sockets"], 3)
        self.assertEqual(values["sockets_matched"], 3)
        self.assertEqual(values["tcp_listen"], 1)
        self.assertEqual(values["tcp_established"], 2)
        self.assertEqual(values["tcp_rx_queue"], 4096)
        self.assertGreaterEqual(values["fd_soft_limit"], values["fd_open"])
        self.assertIsNotNone(values["net_tcp_active_opens"])
        if "0::/" in Path(f"/proc/{target.pid}/cgroup").read_text():
            self.assertTrue(summary.cgroup.startswith("/"))
        sockets = [decode_resource(data) for part, data in parts[min(parts)].values() if part.kind == RESOURCE_SOCKETS]
        self.assertEqual(summary.parts, 2)
        self.assertEqual(len(sockets), 1)
        self.assertEqual(sockets[0].count, 3)
        # Samples follow the configured interval, not the 10 Hz thread ticks.
        first, second = sorted(parts)[:2]
        gap = parts[second][0][0].monotonic_ns - parts[first][0][0].monotonic_ns
        self.assertAlmostEqual(gap / 1e9, 1, delta=0.15)

    def test_resource_samples_can_be_turned_off(self):
        receiver, *_ = self.run_sampler("resource_interval_s = 0\n")
        for _ in range(25):
            self.assertFalse(receiver.recv(1500).startswith(b"TRES"))



def free_port(kind):
    with socket.socket(socket.AF_INET, kind) as reservation:
        reservation.bind(("127.0.0.1", 0))
        return reservation.getsockname()[1]


class CppCollectorIntegrationTests(unittest.TestCase):
    """The C++ core collector: live data, history and no alerting."""

    def test_sampler_cpp_collector_dashboard_and_history_without_alerting(self):
        with tempfile.TemporaryDirectory() as directory:
            udp_port, http_port = free_port(socket.SOCK_DGRAM), free_port(socket.SOCK_STREAM)
            collector_config = Path(directory) / "collector.toml"
            # Alert settings are accepted and ignored: they are for the alerting module.
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
                # The process overview is computed in the page from /api/live;
                # check the served binary carries it, not just the source file.
                self.assertIn(b'id="overview"', page)
                self.assertIn(b"function updateLoadAverage", page)
                self.assertIn(b'data-activity="idle"', page)
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


    def test_unusable_data_dir_stops_at_startup(self):
        # data_dir sits under a regular file, so it can't be created. The
        # collector must report that and exit 1, not crash or carry on.
        with tempfile.TemporaryDirectory() as directory:
            blocker = Path(directory) / "file"
            blocker.write_text("")
            config = Path(directory) / "collector.toml"
            config.write_text(f'udp_host="127.0.0.1"\nudp_port={free_port(socket.SOCK_DGRAM)}\n'
                              f'http_port={free_port(socket.SOCK_STREAM)}\ndata_dir="{blocker}/data"\n')
            result = subprocess.run([*CPP_COLLECTOR, str(config)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn("Collector stopped: cannot create", result.stderr)

    def test_http_port_in_use_stops_at_startup(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as taken:
            taken.bind(("127.0.0.1", 0))
            taken.listen()
            http_port = taken.getsockname()[1]
            config = Path(directory) / "collector.toml"
            config.write_text(f'udp_host="127.0.0.1"\nudp_port={free_port(socket.SOCK_DGRAM)}\n'
                              f'http_host="127.0.0.1"\nhttp_port={http_port}\ndata_dir="{directory}/data"\n')
            result = subprocess.run([*CPP_COLLECTOR, str(config)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertIn(f"Collector stopped: bind 127.0.0.1:{http_port}: Address already in use", result.stderr)

    def test_storage_write_failure_stops_the_collector(self):
        # Day files that aren't SQLite databases make the first write fail.
        # The collector must stop with the SQLite error instead of dropping
        # rows silently. store_raw writes a row per sample, so the write
        # happens on the first datagram.
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / "data"
            data.mkdir()
            today = datetime.datetime.now(datetime.timezone.utc).date()
            for day in (today - datetime.timedelta(days=1), today, today + datetime.timedelta(days=1)):
                (data / f"{day.isoformat()}.sqlite3").write_bytes(b"not a database" * 100)
            udp_port = free_port(socket.SOCK_DGRAM)
            config = Path(directory) / "collector.toml"
            config.write_text(f'udp_host="127.0.0.1"\nudp_port={udp_port}\n'
                              f'http_port={free_port(socket.SOCK_STREAM)}\ndata_dir="{data}"\nstore_raw=true\n')
            target = subprocess.Popen(["sleep", "30"])
            sampler_config = Path(directory) / "sampler.toml"
            sampler_config.write_text(f'target_pid={target.pid}\nrate_hz=10\ncollector="127.0.0.1:{udp_port}"\n')
            collector = subprocess.Popen([*CPP_COLLECTOR, str(config)], stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, text=True)
            sampler = subprocess.Popen([str(ROOT / "build/triangulator-sampler"), str(sampler_config)],
                                       stderr=subprocess.PIPE, text=True)
            try:
                stderr = collector.communicate(timeout=10)[1]
            finally:
                for process in (sampler, collector, target):
                    if process.poll() is None:
                        process.terminate()
                sampler.communicate(timeout=8)
                target.wait(timeout=8)
            self.assertEqual(collector.returncode, 1, stderr)
            self.assertIn("Collector stopped: file is not a database", stderr)


if __name__ == "__main__":
    unittest.main()
