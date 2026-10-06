import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from wire import decode

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import sampler_control  # noqa: E402

NAMED = "import os, sys, time; open('/proc/self/comm', 'wb').write(os.fsencode(sys.argv[1])); time.sleep(60)"


def start_named(name):
    """A process whose comm is name, so name lookups see only test processes."""
    process = subprocess.Popen([sys.executable, "-c", NAMED, os.fsencode(name)])
    deadline = time.monotonic() + 5
    while Path(f"/proc/{process.pid}/comm").read_bytes().rstrip(b"\n") != os.fsencode(name):
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
        pattern = sampler_control.TARGET_LINE
        text = '# target\r\ntarget_process = "old"\r\n# target_pid = 1234\r\nrate_hz = 1\r\n'
        self.assertEqual(sampler_control.replace_setting(text, pattern, "target_pid = 7"),
                         '# target\r\ntarget_pid = 7\r\n# target_pid = 1234\r\nrate_hz = 1\r\n')
        # Duplicates go; a missing key is appended after the last line.
        self.assertEqual(sampler_control.replace_setting("target_pid = 1\nx = 2\ntarget_process = y", pattern,
                                                         "target_pid = 3"), "target_pid = 3\nx = 2\n")
        self.assertEqual(sampler_control.replace_setting("rate_hz = 1", pattern, "target_pid = 3"),
                         "rate_hz = 1\ntarget_pid = 3\n")

    def test_lines_split_only_at_newline_like_the_sampler(self):
        # \f, \v and \x85 don't end a line for the sampler, so the text after
        # them is still part of the comment, not a setting.
        for separator in ("\f", "\v", "\x85", "\u2028"):
            text = f"# old{separator}rate_hz = 2\nrate_hz = 10\n"
            self.assertEqual(sampler_control.replace_setting(text, sampler_control.RATE_LINE, "rate_hz = 5.0"),
                             f"# old{separator}rate_hz = 2\nrate_hz = 5.0\n")
        self.assertIsNone(sampler_control.RATE_LINE.match("\frate_hz = 1"))

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
            value = decode(self.receiver.recv(1200))
            if predicate(value):
                return value
        self.fail("the sampler did not apply the reload")

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

    def test_bytes_and_line_endings_are_kept(self):
        config = self.real / "config/local/sampler.toml"
        # A latin-1 comment, CRLF endings and a form feed inside a comment.
        original = (b"# caf\xe9\r\ntarget_pid = %d\r\nrate_hz = 10\r\n# old\x0crate_hz = 2\r\n"
                    b"collector = 127.0.0.1:%d\r\n" % (self.target.pid, self.port))
        config.write_bytes(original)
        self.start_sampler(config)
        self.receive_until(lambda value: value.pid == self.target.pid)
        changed = self.run_script("set-rate.sh", "5")
        self.assertEqual(changed.returncode, 0, changed.stderr)
        self.assertEqual(config.read_bytes(), original.replace(b"rate_hz = 10\r", b"rate_hz = 5.0\r"))
        self.receive_until(lambda value: value.interval_ms == 200)

        # The sampler compares names as bytes, so a non-UTF-8 name must be
        # written as the same bytes.
        name = os.fsdecode(b"tc\xe9%d" % os.getpid())
        named = start_named(name)
        self.addCleanup(stop, named)
        self.assertEqual(sampler_control.resolve_pid(str(named.pid)), named.pid)
        changed = subprocess.run([self.link / "scripts/set-target.sh", os.fsencode(name)],
                                 capture_output=True, timeout=15)
        self.assertEqual(changed.returncode, 0, changed.stderr)
        self.assertIn(b'\ntarget_process = "' + os.fsencode(name) + b'"\r\n', config.read_bytes())
        self.receive_until(lambda value: value.pid == named.pid)

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
