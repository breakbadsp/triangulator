"""Check the lines that the built sampler writes to its log (stderr)."""
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
SAMPLER = ROOT / "build/triangulator-sampler"
TIME = r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z"


class SamplerLog:
    """Runs the sampler on a pipe, so that each line is written at once."""

    def __init__(self, directory, target_setting):
        self.config = Path(directory) / "sampler.toml"
        self.write_config(target_setting)
        self.process = subprocess.Popen([str(SAMPLER), str(self.config)],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        os.set_blocking(self.process.stderr.fileno(), False)
        self.text = ""

    def write_config(self, target_setting, rate_hz=5):
        self.config.write_text(
            f'{target_setting}\nrate_hz = {rate_hz}\n'
            'collector = "127.0.0.1:9"\nresource_interval_s = 0\nmemory_interval_s = 0\n')

    def read(self):
        try:
            self.text += self.process.stderr.read() or ""
        except BlockingIOError:
            pass

    def count(self, pattern):
        self.read()
        return len(re.findall(pattern, self.text, re.MULTILINE))

    def wait_for_count(self, pattern, count, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if self.count(pattern) >= count:
                return
            time.sleep(0.05)
        raise AssertionError(f"fewer than {count} lines match {pattern!r} in:\n{self.text}")

    def wait_for(self, pattern, seconds=10):
        self.wait_for_count(pattern, 1, seconds)
        return re.search(pattern, self.text, re.MULTILINE)

    def assert_count_stays(self, pattern, count, seconds=1.0):
        """The count is exact: a duplicate line has time to appear first."""
        time.sleep(seconds)
        self.assertion.assertEqual(self.count(pattern), count, self.text)

    def stop(self):
        self.process.send_signal(signal.SIGTERM)
        self.process.wait(timeout=10)
        self.process.stderr.close()


MONITORING = rf"^{TIME} triangulator: target \S+: monitoring PID \d+ \(logtarget\)$"
ENDED = rf"^{TIME} triangulator: target \S+: PID \d+ ended$"
RELOADED = rf"^{TIME} triangulator: configuration reloaded; \d+ targets$"


class SamplerLogTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.targets = []
        self.log = None

    def tearDown(self):
        if self.log:
            self.log.stop()
        for target in self.targets:
            target.kill()
            target.wait()
        self.directory.cleanup()

    def start_target(self):
        """A process with its own name, so that only this test selects it."""
        program = Path(self.directory.name) / "logtarget"
        if not program.exists():
            shutil.copy(shutil.which("sleep"), program)
        target = subprocess.Popen([str(program), "60"])
        self.targets.append(target)
        return target

    def start_log(self, target_setting):
        self.log = SamplerLog(self.directory.name, target_setting)
        self.log.assertion = self

    def test_start_and_reload_are_logged_once_each(self):
        target = self.start_target()
        self.start_log(f"target_pid = {target.pid}")
        self.log.wait_for(rf"^{TIME} triangulator: triangulator-sampler \S+ started; 1 targets$")
        # The sampler reloads once at start, because the file is newer than the start.
        self.log.wait_for_count(RELOADED, 1)
        self.log.assert_count_stays(RELOADED, 1)
        self.log.process.send_signal(signal.SIGHUP)
        self.log.wait_for_count(RELOADED, 2)
        self.log.assert_count_stays(RELOADED, 2)
        started = self.log.text.index("started;")
        self.assertLess(started, self.log.text.index("configuration reloaded"))

    def test_reload_keeps_the_session_unless_the_rate_changes(self):
        target = self.start_target()
        self.start_log(f"target_pid = {target.pid}")
        self.log.wait_for_count(RELOADED, 1)
        self.log.wait_for_count(MONITORING, 1)
        self.log.process.send_signal(signal.SIGHUP)
        self.log.wait_for_count(RELOADED, 2)
        self.log.assert_count_stays(MONITORING, 1)
        self.log.write_config(f"target_pid = {target.pid}", rate_hz=4)
        self.log.process.send_signal(signal.SIGHUP)
        self.log.wait_for_count(RELOADED, 3)
        self.log.wait_for_count(MONITORING, 2)
        self.log.assert_count_stays(MONITORING, 2)
        self.assertEqual(self.log.count(ENDED), 0)

    def test_each_process_start_and_end_is_logged_once(self):
        # A named target, and a discovery slot that the sampler assigns again.
        for setting in ('target_process = "logtarget"', 'process_names = ["logtarget"]'):
            with self.subTest(setting=setting):
                self.log_restarts(setting)

    def log_restarts(self, setting):
        self.start_target()
        self.start_log(setting)
        self.log.wait_for(rf"^{TIME} triangulator: target \S+: monitoring PID {self.targets[-1].pid} \(logtarget\)$")
        restarts = 2
        for number in range(1, restarts + 1):
            ended = self.targets[-1]
            ended.kill()
            ended.wait()
            self.log.wait_for(rf"^{TIME} triangulator: target \S+: PID {ended.pid} ended$")
            self.start_target()
            self.log.wait_for_count(MONITORING, number + 1)
        self.log.assert_count_stays(MONITORING, restarts + 1)
        self.assertEqual(self.log.count(ENDED), restarts)
        self.log.stop()
        self.log = None
        self.targets[-1].kill()
        self.targets[-1].wait()


if __name__ == "__main__":
    unittest.main()
