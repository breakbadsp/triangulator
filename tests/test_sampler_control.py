import os
import json
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from wire import decode, receive_tick

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import sampler_control  # noqa: E402

NAMED = "import sys, time; open('/proc/self/comm', 'w').write(sys.argv[1]); time.sleep(60)"


def start_named(name):
    """A process whose comm is name, so name lookups see only test processes."""
    process = subprocess.Popen([sys.executable, "-c", NAMED, name])
    deadline = time.monotonic() + 5
    while Path(f"/proc/{process.pid}/comm").read_text().strip() != name:
        if time.monotonic() > deadline:
            raise AssertionError(f"process {process.pid} did not rename itself")
        time.sleep(0.01)
    return process


def stop(*processes):
    for process in processes:
        if process.poll() is None:
            process.terminate()
        process.wait(timeout=5)


class ConfigTextTests(unittest.TestCase):
    def test_replace_setting_keeps_position_comments_and_line_endings(self):
        pattern = re.compile(r"\s*target_(?:process|pid)\s*=")
        text = '# target\r\ntarget_process = "old"\r\n# target_pid = 1234\r\nrate_hz = 1\r\n'
        self.assertEqual(sampler_control.replace_setting(text, pattern, "target_pid = 7"),
                         '# target\r\ntarget_pid = 7\r\n# target_pid = 1234\r\nrate_hz = 1\r\n')
        # Duplicates go; a missing key is appended after the last line.
        self.assertEqual(sampler_control.replace_setting("target_pid = 1\nx = 2\ntarget_process = y", pattern,
                                                         "target_pid = 3"), "target_pid = 3\nx = 2\n")
        self.assertEqual(sampler_control.replace_setting("rate_hz = 1", pattern, "target_pid = 3"),
                         "rate_hz = 1\ntarget_pid = 3\n")

    def test_read_setting_follows_the_sampler_rules(self):
        text = '# collector = "1.1.1.1:1"\ncollector = "127.0.0.1:9#00" # note\ntarget_process = a\\q\n'
        self.assertEqual(sampler_control.read_setting(text, "collector"), "127.0.0.1:9#00")
        self.assertEqual(sampler_control.read_setting(text, "target_process"), "a\\q")
        self.assertIsNone(sampler_control.read_setting(text, "rate_hz"))


class TargetLookupTests(unittest.TestCase):
    def test_thread_ids_and_missing_pids_are_rejected(self):
        release = threading.Event()
        thread = threading.Thread(target=release.wait)
        thread.start()
        try:
            self.assertTrue(Path(f"/proc/{thread.native_id}/stat").exists())
            with self.assertRaisesRegex(sampler_control.ControlError, f"thread ID of process {os.getpid()}"):
                sampler_control.resolve_pid(str(thread.native_id))
        finally:
            release.set()
            thread.join()
        self.assertEqual(sampler_control.resolve_pid(str(os.getpid())), os.getpid())
        with self.assertRaisesRegex(sampler_control.ControlError, "no running process"):
            sampler_control.resolve_pid(str(2**31 - 1))

    def test_names_must_be_unique(self):
        name = f"tc-{os.getpid()}"
        first = start_named(name)
        try:
            self.assertEqual(sampler_control.resolve_pid(name), first.pid)
            second = start_named(name)
            try:
                with self.assertRaisesRegex(sampler_control.ControlError, str(sorted([first.pid, second.pid]))):
                    sampler_control.resolve_pid(name)
            finally:
                stop(second)
        finally:
            stop(first)


class ScriptTests(unittest.TestCase):
    """Runs the scripts from a copy of the repo reached through a symlink."""

    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.real = Path(directory.name) / "real"
        for part in ("build", "scripts", "config/local", ".run"):
            (self.real / part).mkdir(parents=True)
        shutil.copy2(ROOT / "build/triangulator-sampler", self.real / "build")
        for script in ("sampler_control.py", "set-target.sh", "set-rate.sh"):
            shutil.copy2(ROOT / "scripts" / script, self.real / "scripts")
        self.link = Path(directory.name) / "link"
        self.link.symlink_to(self.real)
        self.receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.addCleanup(self.receiver.close)
        self.receiver.bind(("127.0.0.1", 0))
        self.receiver.settimeout(3)
        self.port = self.receiver.getsockname()[1]
        self.target = subprocess.Popen(["sleep", "60"])
        self.addCleanup(stop, self.target)

    def start_sampler(self, config):
        # Like scripts/start.sh run through the symlink: the kernel still
        # reports the resolved executable path.
        sampler = subprocess.Popen([str(self.link / "build/triangulator-sampler"), str(config)],
                                   stderr=subprocess.DEVNULL)
        self.addCleanup(stop, sampler)
        (self.real / ".run/sampler.pid").write_text(f"{sampler.pid}\n")
        return sampler

    def run_script(self, *arguments):
        return subprocess.run([str(self.link / "scripts" / arguments[0]), *arguments[1:]],
                              capture_output=True, text=True, timeout=15)

    def receive_until(self, predicate):
        for _ in range(30):
            value = decode(receive_tick(self.receiver))
            if predicate(value):
                return value
        self.fail("the sampler did not apply the reload")

    def start_dashboard(self, http_host="127.0.0.1", udp_host="127.0.0.1"):
        shutil.copy2(ROOT / "build/triangulator-collector", self.real / "build")
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        config = self.real / "config/local/collector.toml"
        # The integration tests receive through the collector instead.
        self.receiver.close()
        config.write_text(f'udp_host = "{udp_host}"\nudp_port = {self.port}\n'
                          f'http_host = "{http_host}"\nhttp_port = {port}\n'
                          f'data_dir = "{self.real / "data"}"\n')
        collector = subprocess.Popen([str(self.real / "build/triangulator-collector"), str(config)],
                                     stderr=subprocess.DEVNULL)
        self.addCleanup(stop, collector)
        self.dashboard = f"http://127.0.0.1:{port}"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                self.api("/api/live")
                return
            except OSError:
                self.assertIsNone(collector.poll(), "collector exited")
                time.sleep(0.02)
        self.fail("dashboard did not start")

    def api(self, path, body=None, headers=None):
        request = urllib.request.Request(self.dashboard + path,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers=headers or {})
        try:
            response = urllib.request.urlopen(request, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def wait_live(self, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _, live = self.api("/api/live")
            if predicate(live.get("health", {})):
                return live["health"]
            time.sleep(0.05)
        self.fail("dashboard did not report the new target")

    def test_dashboard_changes_ipv4_sampler_target_on_dual_stack_collector(self):
        # IPv4 samples and target control both work through an IPv6 wildcard listener.
        self.start_dashboard(udp_host="::")
        config = self.real / "config/local/sampler.toml"
        config.write_text(f'target_pid = {self.target.pid}\nrate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n')
        self.start_sampler(config)
        self.wait_live(lambda health: health.get("pid") == self.target.pid)
        status, data = self.api("/api/target")
        self.assertEqual(status, 200)
        self.assertEqual(data, {"enabled": True, "target": str(self.target.pid)})
        other = subprocess.Popen(["sleep", "60"])
        self.addCleanup(stop, other)
        status, data = self.api("/api/target", {"target": str(other.pid)}, {"X-Triangulator": "1"})
        self.assertEqual(status, 200, data)
        self.wait_live(lambda health: health.get("pid") == other.pid)

    def test_dashboard_changes_pid_name_and_absent_target(self):
        self.start_dashboard()
        config = self.real / "config/local/sampler.toml"
        config.write_text(f'target_pid = {self.target.pid}\nrate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n')
        self.start_sampler(config)
        initial = self.wait_live(lambda health: health.get("pid") == self.target.pid)
        status, data = self.api("/api/target")
        self.assertEqual(status, 200)
        self.assertEqual(data, {"enabled": True, "target": str(self.target.pid)})
        headers = {"Content-Type": "application/json", "X-Triangulator": "1"}
        original = config.read_text()
        for target in ("0", str(2**31 - 1), 'a"b', "too-long-process-name", "a\u0000b"):
            status, data = self.api("/api/target", {"target": target}, headers)
            self.assertEqual(status, 400, data)
            self.assertIn("error", data)
            self.assertEqual(config.read_text(), original)

        name = f"ui-{os.getpid()}"
        other = start_named(name)
        self.addCleanup(stop, other)
        duplicate = start_named(name)
        self.addCleanup(stop, duplicate)
        status, data = self.api("/api/target", {"target": name}, headers)
        self.assertEqual(status, 400)
        self.assertIn("multiple processes", data["error"])
        self.assertEqual(config.read_text(), original)
        stop(duplicate)
        status, data = self.api("/api/target", {"target": name}, headers)
        self.assertEqual(status, 200, data)
        self.assertEqual(data["target"], name)
        changed = self.wait_live(lambda health: health.get("pid") == other.pid)
        self.assertNotEqual(changed["session"], initial["session"])
        self.assertIn(f'target_process = "{name}"', config.read_text())

        status, data = self.api("/api/target", {"target": str(self.target.pid)}, headers)
        self.assertEqual(status, 200, data)
        self.wait_live(lambda health: health.get("pid") == self.target.pid)
        status, data = self.api("/api/target", {"target": "ui-absent-name"}, headers)
        self.assertEqual(status, 200, data)
        self.assertIn("Waiting", data["message"])
        self.wait_live(lambda health: health.get("target_absent") is True)

    def test_dashboard_named_target_follows_restart_and_survives_reopening(self):
        self.start_dashboard()
        config = self.real / "config/local/sampler.toml"
        config.write_text(f'target_pid = {self.target.pid}\nrate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n')
        sampler = self.start_sampler(config)
        name = f"uir-{os.getpid()}"
        first = start_named(name)
        self.addCleanup(stop, first)
        status, data = self.api("/api/target", {"target": name}, {"X-Triangulator": "1"})
        self.assertEqual(status, 200, data)
        self.wait_live(lambda health: health.get("pid") == first.pid)
        stop(first)
        self.wait_live(lambda health: health.get("target_absent") is True)
        second = start_named(name)
        self.addCleanup(stop, second)
        self.assertNotEqual(first.pid, second.pid)
        self.wait_live(lambda health: health.get("pid") == second.pid)
        # Reopening the form (including after a page reload) reads the selector
        # from disk, rather than replacing the name with the current PID.
        status, data = self.api("/api/target")
        self.assertEqual(status, 200)
        self.assertEqual(data["target"], name)
        self.assertIn(f'target_process = "{name}"', config.read_text())
        stop(sampler)
        original = config.read_text()
        status, data = self.api("/api/target", {"target": str(self.target.pid)},
                                {"X-Triangulator": "1"})
        self.assertEqual(status, 400)
        self.assertIn("not running", data["error"])
        self.assertEqual(config.read_text(), original)

    def test_dashboard_control_is_hidden_without_the_optional_helper(self):
        self.start_dashboard()
        (self.real / "scripts/sampler_control.py").unlink()
        status, data = self.api("/api/target")
        self.assertEqual(status, 200)
        self.assertFalse(data["enabled"])
        status, _ = self.api("/api/target", {"target": "x"}, {"X-Triangulator": "1"})
        self.assertEqual(status, 403)

    def test_dashboard_requires_local_same_origin_write_and_live_sampler(self):
        self.start_dashboard()
        status, data = self.api("/api/target")
        self.assertEqual(status, 200)
        self.assertTrue(data["enabled"])
        self.assertIn("not running", data["error"])
        config = self.real / "config/local/sampler.toml"
        original = f'target_pid = {self.target.pid}\nrate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n'
        config.write_text(original)
        self.start_sampler(config)
        for headers in ({}, {"X-Triangulator": "1", "Origin": "https://other.example"}):
            status, _ = self.api("/api/target", {"target": "ui-absent-name"}, headers)
            self.assertEqual(status, 403)
            self.assertEqual(config.read_text(), original)
        headers = {"X-Triangulator": "1", "Origin": self.dashboard}
        for body in ({}, {"target": 123}, {"target": ""}, {"target": "x" * 65}):
            status, _ = self.api("/api/target", body, headers)
            self.assertEqual(status, 400)
            self.assertEqual(config.read_text(), original)
        # A pidfile can exist for a sampler sending to another collector.
        config.write_text(original.replace(str(self.port), str(self.port + 1)))
        status, data = self.api("/api/target", {"target": "ui-absent-name"}, headers)
        self.assertEqual(status, 400)
        self.assertIn("different collector", data["error"])
        self.assertEqual(config.read_text(), original.replace(str(self.port), str(self.port + 1)))

    def test_dashboard_control_is_disabled_on_public_listener(self):
        self.start_dashboard(http_host="0.0.0.0")
        status, data = self.api("/api/target")
        self.assertEqual(status, 200)
        self.assertFalse(data["enabled"])
        status, _ = self.api("/api/target", {"target": "x"}, {"X-Triangulator": "1"})
        self.assertEqual(status, 403)

    def test_dashboard_reads_split_body_and_rejects_oversized_requests(self):
        self.start_dashboard()
        config = self.real / "config/local/sampler.toml"
        config.write_text(f'target_pid = {self.target.pid}\nrate_hz = 10\ncollector = "127.0.0.1:{self.port}"\n')
        self.start_sampler(config)
        port = int(self.dashboard.rsplit(":", 1)[1])
        # A speculative browser connection sends no request; close it silently.
        with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
            connection.shutdown(socket.SHUT_WR)
            self.assertEqual(connection.recv(4096), b"")

        def raw_request(headers, body=b""):
            with socket.create_connection(("127.0.0.1", port), timeout=5) as connection:
                connection.sendall(b"POST /api/target HTTP/1.0\r\nX-Triangulator: 1\r\n" +
                                   headers + b"\r\n\r\n")
                if body:
                    # Separate network writes exercise the HTTP body reader.
                    time.sleep(0.02)
                    connection.sendall(body[:4])
                    time.sleep(0.02)
                    connection.sendall(body[4:])
                response = b""
                while chunk := connection.recv(4096):
                    response += chunk
            status = int(response.split(b" ", 2)[1])
            return status, json.loads(response.split(b"\r\n\r\n", 1)[1])

        original = config.read_text()
        for headers in (b"Content-Length: 1025", b"Content-Length: -1",
                        b"Content-Length: 3\r\nContent-Length: 3", b"Transfer-Encoding: chunked"):
            status, _ = raw_request(headers)
            self.assertEqual(status, 400)
            self.assertEqual(config.read_text(), original)
        body = json.dumps({"target": "ui-split-body"}).encode()
        status, data = raw_request(f"Content-Length: {len(body)}".encode(), body)
        self.assertEqual(status, 200, data)
        self.assertIn('target_process = "ui-split-body"', config.read_text())

    def test_rate_and_target_reload_in_place(self):
        config = self.real / "config/local/sampler.toml"
        # Unquoted collector: valid for the sampler, invalid TOML.
        original = (f"# Process to sample.\ntarget_pid = {self.target.pid}\n# target_process = \"x\"\n"
                    f"# Samples per second.\nrate_hz = 10\ncollector = 127.0.0.1:{self.port}\n")
        config.write_text(original)
        self.start_sampler(self.link / "config/local/sampler.toml")
        first = self.receive_until(lambda value: value.pid == self.target.pid)
        self.assertEqual(first.interval_ms, 100)

        changed = self.run_script("set-rate.sh", "5")
        self.assertEqual(changed.returncode, 0, changed.stderr)
        self.assertEqual(config.read_text(), original.replace("rate_hz = 10", "rate_hz = 5.0"))
        self.receive_until(lambda value: value.interval_ms == 200)

        other = subprocess.Popen(["sleep", "60"])
        self.addCleanup(stop, other)
        changed = self.run_script("set-target.sh", str(other.pid))
        self.assertEqual(changed.returncode, 0, changed.stderr)
        self.assertIn(f"\ntarget_pid = {other.pid}\n# target_process", config.read_text())
        self.receive_until(lambda value: value.pid == other.pid)

        # A name with a backslash is fine for the sampler, though not for TOML.
        changed = self.run_script("set-target.sh", "a\\q")
        self.assertEqual(changed.returncode, 0, changed.stderr)
        self.assertIn("No process named a\\q is running", changed.stdout)
        self.assertIn('\ntarget_process = "a\\q"\n# target_process', config.read_text())
        self.assertNotIn("target_pid", config.read_text())
        self.receive_until(lambda value: value.flags & 1)

    def test_rejected_changes_leave_the_config_unchanged(self):
        config = self.real / "config/local/sampler.toml"
        # Just under the sampler's 16 KiB limit (with lines under its 1023-byte limit).
        original = f"target_pid = {self.target.pid}\ncollector = \"127.0.0.1:{self.port}\"\n"
        padding = 16383 - len(original) - 10
        original += ("#" * 99 + "\n") * (padding // 100) + "#" * (padding % 100) + "\n"
        config.write_text(original)
        self.start_sampler(config)
        self.receive_until(lambda value: value.pid == self.target.pid)

        name = f"tc-{os.getpid()}"
        first, second = start_named(name), start_named(name)
        self.addCleanup(stop, first, second)
        release = threading.Event()
        thread = threading.Thread(target=release.wait)
        thread.start()
        try:
            for arguments, error in ((("set-target.sh", name), "multiple processes"),
                                     (("set-target.sh", str(thread.native_id)), "thread ID"),
                                     (("set-target.sh", 'a"b'), "quotes"),
                                     (("set-rate.sh", "99"), "between 0.2 and 10"),
                                     (("set-rate.sh", "nan"), "between 0.2 and 10"),
                                     # Adds a key past the 16 KiB limit.
                                     (("set-rate.sh", "0.30000000000000004"), "16 KiB")):
                changed = self.run_script(*arguments)
                self.assertEqual(changed.returncode, 1, arguments)
                self.assertIn(error, changed.stderr)
                self.assertEqual(config.read_text(), original)
        finally:
            release.set()
            thread.join()
        self.assertEqual(sorted(path.name for path in config.parent.iterdir()), ["sampler.toml"])

    def test_tracked_example_config_is_not_edited(self):
        config = self.real / "config/sampler.toml"
        original = f"target_pid = {self.target.pid}\nrate_hz = 1.0\ncollector = \"127.0.0.1:{self.port}\"\n"
        config.write_text(original)
        self.start_sampler(config)
        changed = self.run_script("set-rate.sh", "5")
        self.assertEqual(changed.returncode, 1)
        self.assertIn("tracked example file", changed.stderr)
        self.assertEqual(config.read_text(), original)

    def test_stale_pidfile_and_other_programs_are_refused(self):
        changed = self.run_script("set-rate.sh", "5")
        self.assertIn("not running", changed.stderr)
        (self.real / ".run/sampler.pid").write_text(f"{self.target.pid}\n")
        changed = self.run_script("set-rate.sh", "5")
        self.assertEqual(changed.returncode, 1)
        self.assertIn("not this repo's sampler", changed.stderr)
        self.assertIsNone(self.target.poll(), "the other program must not be signalled")

    def test_collector_follows_the_running_sampler(self):
        (self.real / "config/local/sampler.toml").write_text(
            f"target_pid = {self.target.pid}\ncollector = \"10.0.0.5:9400\"\n")
        custom = self.real / "custom.toml"
        custom.write_text(f"target_pid = {self.target.pid}\ncollector = 127.0.0.1:{self.port}\n")
        command = [sys.executable, str(self.link / "scripts/sampler_control.py"), "collector"]
        found = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(found.returncode, 0, found.stderr)
        self.assertEqual(found.stdout, "10.0.0.5:9400\n", found.stderr)
        sampler = self.start_sampler(custom)
        found = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(found.returncode, 0, found.stderr)
        self.assertEqual(found.stdout, f"127.0.0.1:{self.port}\n", found.stderr)
        stop(sampler)
        found = subprocess.run(command, capture_output=True, text=True, timeout=5)
        self.assertEqual(found.returncode, 0, found.stderr)
        self.assertEqual(found.stdout, "10.0.0.5:9400\n", found.stderr)

    def test_collector_does_not_fall_back_when_running_config_disappears(self):
        # A live sampler keeps its loaded endpoint even after its file is removed.
        (self.real / "config/local/sampler.toml").write_text(
            f"target_pid = {self.target.pid}\ncollector = \"10.0.0.5:9400\"\n")
        custom = self.real / "custom.toml"
        custom.write_text(f"target_pid = {self.target.pid}\ncollector = 127.0.0.1:{self.port}\n")
        sampler = self.start_sampler(custom)
        self.receive_until(lambda value: value.pid == self.target.pid)
        custom.unlink()

        found = subprocess.run(
            [sys.executable, str(self.link / "scripts/sampler_control.py"), "collector"],
            capture_output=True, text=True, timeout=5)
        self.assertIsNone(sampler.poll())
        self.assertEqual(found.returncode, 1)
        self.assertEqual(found.stdout, "")
        self.assertIn(str(custom), found.stderr)
        self.assertIn("pass --collector IP:PORT", found.stderr)

    def test_collector_does_not_fall_back_when_pidfile_points_to_another_program(self):
        (self.real / "config/local/sampler.toml").write_text(
            f"target_pid = {self.target.pid}\ncollector = \"10.0.0.5:9400\"\n")
        (self.real / ".run/sampler.pid").write_text(f"{self.target.pid}\n")
        found = subprocess.run(
            [sys.executable, str(self.link / "scripts/sampler_control.py"), "collector"],
            capture_output=True, text=True, timeout=5)
        self.assertEqual(found.returncode, 1)
        self.assertEqual(found.stdout, "")
        self.assertIn("not this repo's sampler", found.stderr)
        self.assertIn("pass --collector IP:PORT", found.stderr)


if __name__ == "__main__":
    unittest.main()
