"""The sampler's memory-map thread against a real process: it stays silent
without a request, answers a signed watch with TVMA datagrams, reads the pages
of one selected VMA, stops when the lease ends and ignores forged or repeated
requests. See docs/process-memory-map-design.md."""
import json
import os
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from wire import MEMORY_DETAIL_PART, MEMORY_SUMMARY, MEMORY_VMAS, decode, decode_memory, memory_request, receive_tick

BINARY = Path(__file__).resolve().parents[1] / "build/triangulator-sampler"
TOKEN = b"memory-map-test-token-0123456789abcdef"


def free_udp_port():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def memory_parts(receiver, seconds):
    """Every TVMA datagram that arrives within the given time."""
    parts = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        receiver.settimeout(max(0.01, deadline - time.monotonic()))
        try:
            data = receiver.recv(2048)
        except socket.timeout:
            break
        if data.startswith(b"TVMA"):
            parts.append(decode_memory(data))
    return parts


def wait_for(receiver, predicate, seconds=5):
    """TVMA parts until one matches, or an assertion error."""
    seen = []
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        for part in memory_parts(receiver, 0.2):
            seen.append(part)
            if predicate(part):
                return seen
    raise AssertionError(f"no matching memory-map datagram in {seconds} s ({len(seen)} others)")


class MemoryMapSamplerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.addCleanup(self.receiver.close)
        self.receiver.bind(("127.0.0.1", 0))
        self.control_port = free_udp_port()
        self.token = Path(self.directory.name) / "token"
        self.token.write_bytes(TOKEN + b"\n")
        self.token.chmod(0o600)
        self.target = subprocess.Popen(["sleep", "60"])
        self.addCleanup(self.target.wait)
        self.addCleanup(self.target.kill)
        self.config = Path(self.directory.name) / "sampler.toml"
        self.write_config()
        self.counter = time.time_ns()

    def write_config(self, extra=""):
        self.config.write_text(
            f'target_pid = {self.target.pid}\nrate_hz = 2\nresource_interval_s = 0\n'
            f'collector = "127.0.0.1:{self.receiver.getsockname()[1]}"\n'
            f'memory_map_enabled = true\nmemory_map_listen = "127.0.0.1:{self.control_port}"\n'
            f'memory_map_token_file = "{self.token}"\nmemory_map_interval_s = 1\n'
            f'memory_map_keyframe_s = 5\n{extra}')

    def start_sampler(self):
        sampler = subprocess.Popen([str(BINARY), str(self.config)], stderr=subprocess.PIPE, text=True)

        def stop():
            if sampler.poll() is None:
                sampler.terminate()
                sampler.wait(timeout=5)
            sampler.stderr.close()
        self.addCleanup(stop)
        decode(receive_tick(self.receiver))  # running
        return sampler

    def send(self, token=TOKEN, counter=None, **fields):
        if counter is None:
            self.counter += 1
            counter = self.counter
        data = memory_request(token, counter, **fields)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender:
            sender.sendto(data, ("127.0.0.1", self.control_port))
        return data

    def test_watch_detail_lease_and_forged_requests(self):
        self.start_sampler()
        self.assertEqual(memory_parts(self.receiver, 1.5), [], "no request, no reads")

        self.send(token=b"not-the-token-but-long-enough-0123456789")
        self.assertEqual(memory_parts(self.receiver, 1.0), [], "a request with another token is ignored")

        self.send(lease_s=4)
        seen = wait_for(self.receiver, lambda part: part.kind == MEMORY_VMAS and part.part == part.layout_parts)
        summary = next(part for part in seen if part.kind == MEMORY_SUMMARY and part.sequence == seen[-1].sequence)
        self.assertEqual(summary.pid, self.target.pid)
        self.assertGreater(summary.values["vma_count"], 5)
        self.assertGreater(summary.values["vm_rss_bytes"], 0)
        self.assertGreater(summary.values["page_size_bytes"], 0)
        self.assertIsNotNone(summary.values["read_ns_total"])
        layout = [part for part in seen if part.kind == MEMORY_VMAS and part.sequence == summary.sequence]
        self.assertEqual(len(layout), summary.layout_parts)
        vmas = [vma for part in sorted(layout, key=lambda item: item.part) for vma in part.vmas]
        self.assertEqual(len(vmas), summary.values["vmas_sent"])
        self.assertEqual(vmas, sorted(vmas, key=lambda vma: vma.start), "sorted by address")
        stack = next(vma for vma in vmas if vma.kind == "stack")
        self.assertEqual(stack.name, "[stack]")
        # The program file, by its real path: on some systems `sleep` runs
        # from another binary, such as a multi-call coreutils.
        program = os.path.realpath(f"/proc/{self.target.pid}/exe")[-48:]
        self.assertTrue(any(vma.kind == "file" and vma.name == program for vma in vmas))
        self.assertEqual(summary.values["stack_end"], stack.end)

        # The layout of a sleeping process does not change, so the next
        # cycle sends the summary only.
        later = wait_for(self.receiver, lambda part: part.kind == MEMORY_SUMMARY and part.sequence > summary.sequence)
        self.assertEqual(later[-1].layout_parts, 0)
        self.assertEqual(later[-1].generation, summary.generation)

        self.send(lease_s=4, tier=2, vma_start=stack.start)
        seen = wait_for(self.receiver, lambda part: part.kind == MEMORY_DETAIL_PART)
        detail = seen[-1].detail
        self.assertEqual(detail["vma_start"], stack.start)
        self.assertEqual(detail["vma_end"], stack.end)
        self.assertEqual(detail["status"], 2, "a small VMA is read in one pass")
        self.assertGreater(detail["resident_pages"], 0, "the stack has resident pages")
        self.assertTrue(all(value <= 254 for cell in seen[-1].cells for value in cell))

        self.send(lease_s=4, tier=2, vma_start=1)
        seen = wait_for(self.receiver, lambda part: part.kind == MEMORY_DETAIL_PART and part.detail["vma_start"] == 1)
        self.assertEqual(seen[-1].detail["status"], 3, "no VMA starts there")

        replay = self.send(lease_s=1)
        time.sleep(2.5)
        memory_parts(self.receiver, 0.2)
        self.assertEqual(memory_parts(self.receiver, 2.0), [], "the lease ended")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sender:
            sender.sendto(replay, ("127.0.0.1", self.control_port))
        self.assertEqual(memory_parts(self.receiver, 1.5), [], "a repeated request is ignored")

        self.send(action=2)
        self.send(lease_s=4)
        wait_for(self.receiver, lambda part: part.kind == MEMORY_SUMMARY)
        self.send(action=2)
        time.sleep(1.2)
        memory_parts(self.receiver, 0.2)
        self.assertEqual(memory_parts(self.receiver, 1.5), [], "stop ends the lease at once")

    def test_reload_of_memory_keys_keeps_the_session(self):
        sampler = self.start_sampler()
        first = decode(receive_tick(self.receiver))
        self.write_config("memory_map_max_vmas = 300\n")
        sampler.send_signal(signal.SIGHUP)
        time.sleep(0.6)
        for _ in range(4):
            self.assertEqual(decode(receive_tick(self.receiver)).session, first.session)
        self.send(lease_s=3)
        summary = wait_for(self.receiver, lambda part: part.kind == MEMORY_SUMMARY)[-1]
        self.assertEqual(summary.session, first.session, "TVMA shares the thread ticks' session")
        self.assertIsNone(sampler.poll())

    def test_check_config_rules(self):
        def check():
            return subprocess.run([str(BINARY), "--check-config", str(self.config)], capture_output=True, text=True)

        self.assertEqual(check().returncode, 0, check().stderr)
        self.token.chmod(0o644)
        result = check()
        self.assertEqual(result.returncode, 2)
        self.assertIn("0600", result.stderr)
        self.token.chmod(0o600)
        self.token.write_bytes(b"short\n")
        self.assertIn("at least 32", check().stderr)
        self.config.write_text(f'target_pid = 1\ncollector = "127.0.0.1:9400"\nmemory_map_enabled = true\n')
        self.assertIn("memory_map_token_file", check().stderr)
        self.config.write_text(f'target_pid = 1\ncollector = "127.0.0.1:9400"\nmemory_map_interval_s = 10\n'
                               'memory_map_keyframe_s = 5\n')
        self.assertIn("memory_map_keyframe_s", check().stderr)

    def test_port_in_use_stops_the_sampler_at_startup(self):
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as holder:
            holder.bind(("127.0.0.1", self.control_port))
            result = subprocess.run([str(BINARY), str(self.config)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertIn("memory_map_listen", result.stderr)



ROOT = Path(__file__).resolve().parents[1]


def free_tcp_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


class MemoryMapCollectorTests(unittest.TestCase):
    """The real collector and sampler: the dashboard's watch request goes to the
    sampler, and the TVMA stream comes back as /api/memory-map."""

    def start(self, collector_extra, sampler_extra):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.directory = Path(directory.name)
        token = self.directory / "token"
        token.write_bytes(TOKEN + b"\n")
        token.chmod(0o600)
        udp_port, self.http_port, control_port = free_udp_port(), free_tcp_port(), free_udp_port()
        collector_config = self.directory / "collector.toml"
        collector_config.write_text(
            f'udp_host="127.0.0.1"\nudp_port={udp_port}\nhttp_port={self.http_port}\n'
            f'data_dir="{self.directory}/data"\n' + collector_extra.format(port=control_port, token=token))
        target = subprocess.Popen(["sleep", "60"])
        self.addCleanup(target.wait)
        self.addCleanup(target.kill)
        self.target = target
        sampler_config = self.directory / "sampler.toml"
        sampler_config.write_text(
            f'target_pid={target.pid}\nrate_hz=2\ncollector="127.0.0.1:{udp_port}"\nresource_interval_s=0\n'
            + sampler_extra.format(port=control_port, token=token))
        for command in ([str(ROOT / "build/triangulator-collector"), str(collector_config)],
                        [str(BINARY), str(sampler_config)]):
            process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            self.addCleanup(process.wait, 5)
            self.addCleanup(process.terminate)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                self.fetch("/api/live")
                return
            except OSError:
                time.sleep(0.1)
        self.fail("the collector did not start")

    def fetch(self, path, body=None, headers=None):
        request = urllib.request.Request(f"http://127.0.0.1:{self.http_port}{path}",
                                         data=None if body is None else json.dumps(body).encode(),
                                         headers=headers or {}, method="GET" if body is None else "POST")
        try:
            with urllib.request.urlopen(request, timeout=3) as response:
                return response.status, json.loads(response.read() or b"null")
        except urllib.error.HTTPError as error:
            with error:
                text = error.read()
                try:
                    return error.code, json.loads(text)
                except ValueError:
                    return error.code, text.decode()

    def watch(self, vma_start=None):
        return self.fetch("/api/memory-map/watch", {"vma_start": vma_start}, {"X-Triangulator": "1"})

    def test_watch_layout_and_detail_through_the_collector(self):
        self.start('[memory_map]\nenabled=true\nsampler_control="127.0.0.1:{port}"\ntoken_file="{token}"\n',
                   'memory_map_enabled=true\nmemory_map_listen="127.0.0.1:{port}"\n'
                   'memory_map_token_file="{token}"\nmemory_map_interval_s=1\n')
        status, view = self.fetch("/api/memory-map")
        self.assertEqual((status, view["state"]), (200, "waiting"))
        self.assertEqual(self.fetch("/api/memory-map/watch", {})[0], 403, "the dashboard header is required")
        self.assertEqual(self.watch(), (200, {"sent": True}))
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and not (view.get("layout") and view["state"] == "live"):
            time.sleep(0.2)
            view = self.fetch("/api/memory-map")[1]
        self.assertEqual(view["state"], "live")
        self.assertEqual(view["summary"]["pid"], self.target.pid)
        columns = view["layout"]["columns"]
        rows = [dict(zip(columns, row)) for row in view["layout"]["rows"]]
        stack = next(row for row in rows if row["kind"] == "stack")
        self.assertEqual(int(stack["end"], 16) - int(stack["start"], 16), stack["size"])
        self.assertEqual(view["summary"]["values"]["stack_end"], stack["end"])

        time.sleep(0.3)  # the collector sends at most one request each 250 ms
        self.assertEqual(self.watch(stack["start"])[0], 200)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and not view.get("detail"):
            time.sleep(0.2)
            view = self.fetch("/api/memory-map")[1]
        self.assertEqual(view["detail"]["vma_start"], stack["start"])
        self.assertEqual(view["detail"]["status"], "complete")
        self.assertGreater(view["detail"]["resident_pages"], 0)
        time.sleep(0.3)
        self.assertEqual(self.watch("not hex")[0], 400)

        # The first list of the watch is stored at once; summaries each minute.
        day = next((self.directory / "data").glob("*.sqlite3"))
        deadline = time.monotonic() + 5
        count = 0
        while time.monotonic() < deadline and not count:
            time.sleep(0.5)
            with sqlite3.connect(f"file:{day}?mode=ro", uri=True) as database:
                count = database.execute("SELECT count(*) FROM vm_snapshot").fetchone()[0]
        self.assertEqual(count, 1)

        # Replay: the stored summary and list, shaped like the live view.
        status, replay = self.fetch(f"/api/memory-map/replay?at={time.time() + 2}")
        self.assertEqual((status, replay["state"]), (200, "replay"))
        self.assertEqual(replay["summary"]["pid"], self.target.pid)
        self.assertEqual(replay["layout"]["columns"], columns)
        stored = [dict(zip(columns, row)) for row in replay["layout"]["rows"]]
        self.assertTrue(any(row["kind"] == "stack" for row in stored))
        self.assertTrue(replay["history"] and replay["history"][0]["stack"] > 0)
        self.assertFalse(replay["replay"]["read_error"])
        # Before the first record there is nothing: null, never an empty map.
        nothing = self.fetch("/api/memory-map/replay?at=1")[1]
        self.assertEqual((nothing["summary"], nothing["layout"]), (None, None))
        self.assertEqual(self.fetch("/api/memory-map/replay")[0], 400)
        self.assertEqual(self.fetch("/api/memory-map/replay?at=-1")[0], 400)

        # The findings come from the helper program, through the bridge.
        report = {"loading": True}
        deadline = time.monotonic() + 8
        while report.get("loading") and time.monotonic() < deadline:
            report = self.fetch("/api/memory-map/report")[1]
            time.sleep(0.1)
        self.assertTrue(report["available"], report)
        self.assertEqual(report["pid"], self.target.pid)
        self.assertIsInstance(report["findings"], list)
        self.assertIsNotNone(report["sources"]["summary_age_s"])
        self.assertIsNotNone(report["sources"]["snapshot_age_s"])
        self.assertFalse(report["read_error"])
        self.assertEqual(self.fetch("/api/memory-map/report?pid=x")[0], 400)

    def test_disabled_collector_has_no_memory_map(self):
        self.start("", "")
        self.assertEqual(self.fetch("/api/memory-map")[0], 404)
        for path in ("/api/memory-map/report", "/api/memory-map/replay?at=5"):
            self.assertEqual(self.fetch(path)[0], 404)
        self.assertEqual(self.watch()[0], 404)
        time.sleep(1.5)
        for day in (self.directory / "data").glob("*.sqlite3"):
            with sqlite3.connect(f"file:{day}?mode=ro", uri=True) as database:
                tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master")}
            self.assertFalse({"vm_summary", "vm_snapshot"} & tables)


if __name__ == "__main__":
    unittest.main()
