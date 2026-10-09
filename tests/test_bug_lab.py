"""Check lab target selection and process cleanup with controlled programs."""
import os
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


class BugLabRunnerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="triangulator-lab-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "bug-lab").mkdir()
        (self.root / "scripts").mkdir()
        (self.root / "bin").mkdir()
        (self.root / "scratch").mkdir()
        source = Path(__file__).resolve().parents[1]
        shutil.copy(source / "bug-lab/run-lab.sh", self.root / "bug-lab/run-lab.sh")
        self.write_program("bench-template", """#!/usr/bin/env python3
import os, signal, time
from pathlib import Path
root = Path(os.environ['LAB_TEST_ROOT'])
(root / 'bench.pid').write_text(str(os.getpid()))
signal.signal(signal.SIGTERM, lambda *_: exit(0))
while True: time.sleep(.01)
""")
        self.write_program("bin/gcc", """#!/usr/bin/env python3
import os, shutil, sys
from pathlib import Path
shutil.copy(Path(os.environ['LAB_TEST_ROOT']) / 'bench-template', sys.argv[-1])
""")
        self.write_program("bin/node", """#!/usr/bin/env python3
import os, sys, time
from pathlib import Path
root = Path(os.environ['LAB_TEST_ROOT'])
(root / 'capture.pid').write_text(str(os.getpid()))
(root / 'capture-delay').write_text(sys.argv[3])
if os.environ.get('LAB_TEST_CAPTURE') == 'wait':
    while True: time.sleep(.01)
sys.exit(12 if os.environ.get('LAB_TEST_CAPTURE') == 'fail' else 0)
""")
        self.write_program("bin/sleep", "#!/usr/bin/env python3\nimport time\ntime.sleep(.05)\n")
        self.write_program("scripts/set-target.sh", """#!/usr/bin/env python3
import os, sys
from pathlib import Path
Path(os.environ['LAB_TEST_ROOT'], 'target.pid').write_text(sys.argv[1])
""")
        self.environment = {**os.environ, "PATH": str(self.root / "bin") + os.pathsep + os.environ["PATH"],
                            "LAB_TEST_ROOT": str(self.root), "TRIANGULATOR_HOME": str(self.root / "runtime"),
                            "BUGBENCH": str(self.root / "bench"), "OUT": str(self.root / "output"),
                            "TMPDIR": str(self.root / "scratch")}
        self.environment.pop("HOLD", None)

    def write_program(self, path, text):
        file = self.root / path
        file.write_text(text)
        file.chmod(0o755)

    def command(self, scenario):
        return ["bash", str(self.root / "bug-lab/run-lab.sh"), scenario]

    def assert_stopped(self, filename):
        pid = int((self.root / filename).read_text())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_default_capture_reaches_thread_growth_and_uses_bench_pid(self):
        result = subprocess.run(self.command("thread-leak"), env=self.environment,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "capture-delay").read_text(), "165")
        self.assertEqual((self.root / "target.pid").read_text(), (self.root / "bench.pid").read_text())
        self.assert_stopped("bench.pid")
        self.assertEqual(list((self.root / "scratch").iterdir()), [])

    def test_failed_capture_stops_scenario(self):
        environment = {**self.environment, "LAB_TEST_CAPTURE": "fail"}
        result = subprocess.run(self.command("healthy"), env=environment,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 12, result.stderr)
        self.assert_stopped("bench.pid")

    def test_interrupt_stops_capture_and_scenario(self):
        environment = {**self.environment, "LAB_TEST_CAPTURE": "wait"}
        process = subprocess.Popen(self.command("healthy"), env=environment,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 5
            while not (self.root / "capture.pid").exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue((self.root / "capture.pid").exists())
            process.send_signal(signal.SIGTERM)
            _, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 143, stderr)
            self.assert_stopped("capture.pid")
            self.assert_stopped("bench.pid")
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()

    def test_invalid_capture_delay_starts_no_scenario(self):
        for delay in ["20", "08", "", "99999999999999999999999999999999999"]:
            with self.subTest(delay=delay):
                result = subprocess.run(self.command("stopped"), env={**self.environment, "HOLD": delay},
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse((self.root / "bench.pid").exists())


if __name__ == "__main__":
    unittest.main()
