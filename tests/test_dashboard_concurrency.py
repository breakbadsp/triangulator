"""Check independent HTTP clients and conditional settings writes with real sockets."""

import concurrent.futures
from contextlib import ExitStack
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]


class DashboardConcurrencyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        with socket.socket() as http, socket.socket(type=socket.SOCK_DGRAM) as udp:
            http.bind(("127.0.0.1", 0))
            udp.bind(("127.0.0.1", 0))
            self.port = http.getsockname()[1]
            udp_port = udp.getsockname()[1]
        self.base = f"http://127.0.0.1:{self.port}"
        self.config = self.directory / "collector.toml"
        self.config.write_text(
            f'udp_host="127.0.0.1"\nudp_port={udp_port}\nhttp_port={self.port}\n'
            f'data_dir="{self.directory}/data"\nmax_live_samples=1000\n')
        self.process = None
        self.addCleanup(self.stop)
        self.start()

    def start(self):
        self.process = subprocess.Popen(
            [str(ROOT / "build/triangulator-collector"), str(self.config)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                self.request()
                return
            except OSError:
                self.assertIsNone(self.process.poll(), "collector exited")
                time.sleep(0.02)
        self.fail("collector did not start")

    def stop(self):
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
            self.process.communicate(timeout=15)
            self.process = None

    def request(self, path="/api/live", body=None, revision=None, timeout=2):
        headers = {"X-Triangulator": "1", "Content-Type": "application/json"}
        if revision is not None:
            headers["If-Match"] = '"' + revision + '"'
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.base + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.load(error)

    def test_twenty_viewers_continue_with_idle_and_partial_connections(self):
        # Forty speculative or incomplete connections must not block twenty
        # viewers that read live data, stored resources and replay bounds.
        with ExitStack() as sockets:
            for index in range(40):
                connection = sockets.enter_context(socket.create_connection(("127.0.0.1", self.port)))
                if index % 2:
                    connection.sendall(b"GET /api/live HTTP/1.0\r\nX-Incomplete: ")
            barrier = threading.Barrier(20)

            def viewer(index):
                barrier.wait(timeout=5)
                return [self.request(path)[0] for path in
                        ("/api/live", "/api/resources", "/api/replay")]

            with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
                responses = list(pool.map(viewer, range(20)))
            self.assertEqual(responses, [[200, 200, 200]] * 20)

    def test_request_deadline_covers_trickled_headers_and_body(self):
        # Progress before each socket timeout must not extend the total read
        # deadline. Both header and body reads share the same deadline.
        for body in (False, True):
            with self.subTest(body=body), socket.create_connection(("127.0.0.1", self.port)) as slow:
                headers = b"POST /api/watches HTTP/1.0\r\nContent-Length: 100\r\n"
                slow.sendall(headers + (b"\r\n{" if body else b"X-Slow: "))
                finished = threading.Event()

                def drip():
                    while not finished.wait(0.2):
                        try:
                            slow.sendall(b"x")
                        except OSError:
                            return

                thread = threading.Thread(target=drip)
                thread.start()
                started = time.monotonic()
                try:
                    slow.settimeout(7)
                    response = slow.recv(4096)
                    self.assertIn(b"400 Bad Request", response)
                    self.assertLess(time.monotonic() - started, 6.5)
                finally:
                    finished.set()
                    thread.join(timeout=1)

    def test_shutdown_interrupts_pending_connections(self):
        # Stop must cancel waiting network operations instead of waiting for
        # every five-second read deadline.
        with ExitStack() as sockets:
            for _ in range(20):
                sockets.enter_context(socket.create_connection(("127.0.0.1", self.port)))
            self.assertEqual(self.request()[0], 200)
            self.process.terminate()
            self.process.communicate(timeout=2)

    def test_connection_limit_refuses_overload_and_recovers(self):
        # Excess connections must be refused instead of creating unbounded
        # threads. Closing idle clients must make their slots available again.
        with ExitStack() as sockets:
            for _ in range(64):
                sockets.enter_context(socket.create_connection(("127.0.0.1", self.port)))
            with self.assertRaises(urllib.error.HTTPError) as rejected:
                urllib.request.urlopen(self.base + "/api/live", timeout=2)
            self.assertEqual(rejected.exception.code, 503)
            rejected.exception.close()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            try:
                if self.request()[0] == 200:
                    return
            except (OSError, ValueError):
                pass
            time.sleep(0.02)
        self.fail("connection slots were not released")

    def test_only_one_editor_can_save_a_revision(self):
        # Concurrent writers must compare and publish atomically. Losing
        # saves and resets must leave the winner's disk and live rules intact.
        original = self.request("/api/watches")[1]
        revision = original["revision"]
        barrier = threading.Barrier(20)

        def save(index):
            rules = {"rules": [{"prefix": f"worker-{index}", "wake_ms": 500}]}
            barrier.wait(timeout=5)
            return rules, self.request("/api/watches", rules, revision)

        with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            responses = list(pool.map(save, range(20)))
        winners = [(rules, result) for rules, result in responses if result[0] == 200]
        self.assertEqual(len(winners), 1)
        self.assertEqual(sum(result[0] == 409 for _, result in responses), 19)
        rules, (_, saved) = winners[0]
        self.assertEqual(saved["rules"], rules["rules"])
        self.assertNotEqual(saved["revision"], revision)
        self.assertEqual(self.request("/api/watches")[1], saved)
        file = self.directory / "data/watch-rules.json"
        self.assertEqual(json.loads(file.read_text()), rules)
        self.assertEqual(self.request("/api/watches/reset", {}, revision)[0], 409)
        self.assertEqual(self.request("/api/watches", {"rules": []})[0], 428)
        self.assertEqual(self.request("/api/watches/reset", {})[0], 428)
        self.assertEqual(json.loads(file.read_text()), rules)
        # Restart must invalidate old drafts even when the rules stay the same.
        self.stop()
        self.start()
        self.assertEqual(self.request("/api/watches", {"rules": []}, saved["revision"])[0], 409)
        current = self.request("/api/watches")[1]
        self.assertEqual(current["rules"], rules["rules"])
        status, reset = self.request("/api/watches/reset", {}, current["revision"])
        self.assertEqual(status, 200)
        self.assertEqual(reset["rules"], original["rules"])
        self.assertNotEqual(reset["revision"], current["revision"])
        self.assertFalse(file.exists())


    def raw(self, request, address="127.0.0.1"):
        with socket.create_connection((address, self.port), timeout=3) as connection:
            connection.sendall(request)
            reply = b""
            while chunk := connection.recv(65536):
                reply += chunk
        head, _, body = reply.partition(b"\r\n\r\n")
        return int(head.split()[1]), json.loads(body)

    def test_query_keeps_first_non_blank_value_percent_decoding_and_plus(self):
        # start is "100 " (blank first value skipped, + as space) and end is
        # "5000" in percent encoding, so the 4,900 s range gives 5 s buckets.
        # Each rule broken alone makes the range invalid (400).
        status, data = self.raw(
            b"GET /api/resources?start=&start=100+&end=%35%30%30%30 HTTP/1.0\r\n\r\n")
        self.assertEqual((status, data["bucket_s"]), (200, 5))

    def test_target_control_uses_the_socket_peer_not_forwarded_headers(self):
        # A forwarded address must neither grant control to another host nor
        # take it from a loopback client.
        forwarded = (b"X-Forwarded-For: {}\r\nX-Real-IP: {}\r\nForwarded: for={}\r\n")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            try:
                probe.connect(("192.0.2.1", 9))
                local = probe.getsockname()[0]
            except OSError:
                local = None
        self.stop()
        self.config.write_text(self.config.read_text() + 'http_host="0.0.0.0"\n')
        self.start()
        request = b"GET /api/target HTTP/1.0\r\n" + forwarded.replace(b"{}", b"10.1.2.3") + b"\r\n"
        status, data = self.raw(request)
        self.assertEqual(status, 200)
        self.assertNotIn("Target changes from other hosts are off", data.get("error", ""))
        if local is None or local.startswith("127."):
            self.skipTest("no non-loopback address on this host")
        request = b"GET /api/target HTTP/1.0\r\n" + forwarded.replace(b"{}", b"127.0.0.1") + b"\r\n"
        status, data = self.raw(request, local)
        self.assertEqual((status, data["enabled"]), (200, False))
        self.assertIn("Target changes from other hosts are off", data["error"])

if __name__ == "__main__":
    unittest.main()
