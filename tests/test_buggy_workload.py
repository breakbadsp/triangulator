"""Check safe paths, workload selection, and process cleanup in the example."""
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "examples/buggy-workload"
WORKLOAD = ROOT / "build/buggy-workload"


class BuggyWorkloadTests(unittest.TestCase):
    def test_bad_duration_does_not_run_forever(self):
        for duration in ("bad", "-1", "1extra", "2147483648"):
            result = subprocess.run([WORKLOAD, "idle-baseline", duration],
                                    capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 2)

    def test_storage_preserves_base_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            sentinel = base / "journal-0"
            sentinel.write_text("keep this file")
            result = subprocess.run([WORKLOAD, "sync-storm", "1"],
                                    env={**os.environ, "BUGGY_IO_DIR": directory},
                                    capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(sentinel.read_text(), "keep this file")
            self.assertEqual(list(base.iterdir()), [sentinel])

    def wait_for_run(self, base, runner):
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            self.assertIsNone(runner.poll(), "runner exited before startup")
            configs = list(base.glob("buggy-triangulator.*/sampler.toml"))
            if configs and "target_pid = " in configs[0].read_text():
                return configs[0].parent
            time.sleep(0.05)
        self.fail("runner did not start the sampler")

    def stop(self, runner):
        runner.terminate()
        try:
            return runner.wait(timeout=6)
        finally:
            # Also stop orphaned processes if a cleanup regression breaks the test.
            try:
                os.killpg(runner.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            runner.wait()

    def test_runner_preserves_base_and_selects_its_pid(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            sentinel = base / "keep.txt"
            sentinel.write_text("keep")
            runner = subprocess.Popen([EXAMPLE / "run-scenario.sh", "idle-baseline"],
                                      env={**os.environ, "BUGGY_HOME": directory},
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                      start_new_session=True)
            try:
                run = self.wait_for_run(base, runner)
                workload_pid = int((run / "workload.pid").read_text())
                self.assertIn(f"target_pid = {workload_pid}",
                              (run / "sampler.toml").read_text())
                children = Path(f"/proc/{runner.pid}/task/{runner.pid}/children")
                child_pids = [int(value) for value in children.read_text().split()]
            finally:
                status = self.stop(runner)
            self.assertEqual(status, 143)
            self.assertEqual(sentinel.read_text(), "keep")
            for pid in child_pids:
                self.assertFalse(Path(f"/proc/{pid}").exists(), f"child {pid} survived")

    def test_capture_interrupt_stops_the_scenario(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            runner = subprocess.Popen(
                [EXAMPLE / "capture-screenshots.sh", base / "output", "idle-baseline"],
                env={**os.environ, "BUGGY_HOME": directory},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True)
            try:
                run = self.wait_for_run(base, runner)
                workload_pid = int((run / "workload.pid").read_text())
            finally:
                status = self.stop(runner)
            self.assertEqual(status, 143)
            self.assertFalse(Path(f"/proc/{workload_pid}").exists())

    def test_capture_interrupt_stops_browser_and_removes_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            helpers = base / "bin"
            helpers.mkdir()
            marker = base / "browser.txt"
            chromium = helpers / "chromium"
            chromium.write_text(
                "#!/usr/bin/env python3\n"
                "import os, sys, time\n"
                "profile = next(arg.split('=', 1)[1] for arg in sys.argv "
                "if arg.startswith('--user-data-dir='))\n"
                "with open(os.environ['BROWSER_MARKER'], 'w') as marker:\n"
                "    marker.write(str(os.getpid()) + '\\n' + profile)\n"
                "while True: time.sleep(1)\n")
            chromium.chmod(0o755)
            runner = subprocess.Popen(
                [EXAMPLE / "capture-screenshots.sh", base / "output", "idle-baseline"],
                env={**os.environ, "BUGGY_HOME": directory,
                     "BROWSER_MARKER": str(marker),
                     "PATH": str(helpers) + os.pathsep + os.environ["PATH"]},
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True)
            try:
                self.wait_for_run(base, runner)
                deadline = time.monotonic() + 20
                while not marker.exists() and time.monotonic() < deadline:
                    self.assertIsNone(runner.poll())
                    time.sleep(0.05)
                self.assertTrue(marker.exists(), "capture did not start the browser")
                browser_pid, profile = marker.read_text().splitlines()
            finally:
                status = self.stop(runner)
            self.assertEqual(status, 143)
            # A killed grandchild can remain a zombie until its parent reaps it.
            process = Path(f"/proc/{browser_pid}/stat")
            if process.exists():
                self.assertEqual(process.read_text().split()[2], "Z")
            self.assertFalse(Path(profile).exists())

    def test_deadlock_reaches_both_lock_waits(self):
        workload = subprocess.Popen([WORKLOAD, "deadlock", "3"],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline:
                wait_channels = {}
                for task in Path(f"/proc/{workload.pid}/task").iterdir():
                    name = (task / "comm").read_text().strip()
                    if name in ("worker-a", "worker-b"):
                        wait_channels[name] = (task / "wchan").read_text().strip()
                if len(wait_channels) == 2 and all(
                        "futex" in channel for channel in wait_channels.values()):
                    break
                time.sleep(0.05)
            else:
                self.fail("both deadlock workers did not reach a futex wait")
        finally:
            workload.terminate()
            workload.wait(timeout=3)
