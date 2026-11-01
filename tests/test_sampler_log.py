"""Check the lines that the built sampler writes to its log (stderr)."""
import os
from pathlib import Path
import re
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

    def __init__(self, directory, target_pid):
        self.config = Path(directory) / "sampler.toml"
        self.config.write_text(
            f'target_pid = {target_pid}\nrate_hz = 5\n'
            'collector = "127.0.0.1:9"\nresource_interval_s = 0\nmemory_interval_s = 0\n')
        self.process = subprocess.Popen([str(SAMPLER), str(self.config)],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        os.set_blocking(self.process.stderr.fileno(), False)
        self.text = ""

    def wait_for(self, pattern, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            try:
                self.text += self.process.stderr.read() or ""
            except BlockingIOError:
                pass
            match = re.search(pattern, self.text, re.MULTILINE)
            if match:
                return match
            time.sleep(0.05)
        raise AssertionError(f"no line matches {pattern!r} in:\n{self.text}")

    def stop(self):
        self.process.send_signal(signal.SIGTERM)
        self.process.wait(timeout=10)
        self.process.stderr.close()


class SamplerLogTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.target = subprocess.Popen(["sleep", "60"])
        self.log = SamplerLog(self.directory.name, self.target.pid)

    def tearDown(self):
        self.log.stop()
        self.target.kill()
        self.target.wait()
        self.directory.cleanup()

    def test_start_and_reload_are_logged_with_version_and_target_count(self):
        self.log.wait_for(rf"^{TIME} triangulator: triangulator-sampler \S+ started; 1 targets$")
        self.log.process.send_signal(signal.SIGHUP)
        self.log.wait_for(rf"^{TIME} triangulator: configuration reloaded; 1 targets$")
        started = self.log.text.index("started;")
        self.assertLess(started, self.log.text.index("configuration reloaded"))


if __name__ == "__main__":
    unittest.main()
