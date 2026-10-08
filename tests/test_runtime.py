"""Check the home runtime layout with real binaries and isolated homes."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request


ROOT = Path(__file__).resolve().parents[1]


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / "home with spaces"
        self.source = Path(temporary.name) / "source"
        for name in ("build", "scripts", "config", "deploy"):
            (self.source / name).mkdir(parents=True)
        self.home.mkdir()
        self.runtime = self.home / "triangulator"
        self.environment = {**os.environ, "HOME": str(self.home)}
        self.environment.pop("TRIANGULATOR_HOME", None)
        for name in ("triangulator-sampler", "triangulator-collector", "triangulator-socket-report"):
            shutil.copy2(ROOT / "build" / name, self.source / "build" / name)
        for name in ("start.sh", "stop.sh", "restart.sh", "runtime.sh", "set-rate.sh",
                     "set-target.sh", "watch-sockets.sh", "sampler_control.py"):
            shutil.copy2(ROOT / "scripts" / name, self.source / "scripts" / name)
        for name in ("triangulator-sampler.service", "triangulator-collector.service"):
            shutil.copy2(ROOT / "deploy" / name, self.source / "deploy" / name)
        (self.source / "Makefile").write_text(".PHONY: all\nall:\n\t@true\n")
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as udp, socket.socket() as http:
            udp.bind(("127.0.0.1", 0))
            http.bind(("127.0.0.1", 0))
            self.udp_port = udp.getsockname()[1]
            self.http_port = http.getsockname()[1]
        self.target = subprocess.Popen(["sleep", "60"])
        self.addCleanup(self.stop_target)
        (self.source / "config/sampler.toml").write_text(
            f'target_pid={self.target.pid}\ncollector="127.0.0.1:{self.udp_port}"\n'
            'resource_interval_s=1\nmemory_interval_s=1\n')
        (self.source / "config/collector.toml").write_text(
            f'udp_host="127.0.0.1"\nudp_port={self.udp_port}\n'
            f'http_host="127.0.0.1"\nhttp_port={self.http_port}\n'
            'data_dir="./data"\nstore_raw=false\nreplay_interval_s=1\n')
        self.addCleanup(self.stop_runtime)

    def stop_target(self):
        self.target.terminate()
        self.target.wait(timeout=5)

    def command(self, script, *arguments):
        return subprocess.run([str(self.source / "scripts" / script), *arguments],
                              env=self.environment, capture_output=True, text=True, timeout=20)

    def stop_runtime(self):
        self.command("stop.sh")

    def start(self):
        result = self.command("start.sh")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for _ in range(30):
            with urllib.request.urlopen(f"http://127.0.0.1:{self.http_port}/api/live", timeout=2) as response:
                live = json.load(response)
            if live.get("memory", {}).get("available"):
                return
            time.sleep(0.1)
        self.fail("memory samples did not arrive")

    def test_default_layout_preserves_configs_and_controls_installed_sampler(self):
        self.start()
        for path in ("config/sampler.toml", "config/collector.toml", "bin/triangulator-sampler",
                     "bin/triangulator-collector", "bin/triangulator-socket-report",
                     "logs/sampler.log", "logs/collector.log", "run/sampler.pid", "run/collector.pid"):
            self.assertTrue((self.runtime / path).exists(), path)
        self.assertFalse((self.source / ".run").exists())
        self.assertTrue(list((self.runtime / "data").glob("*.sqlite3")))
        self.assertFalse((self.source / "data").exists())
        for app in ("sampler", "collector"):
            pid = (self.runtime / f"run/{app}.pid").read_text().strip()
            self.assertEqual(Path(os.readlink(f"/proc/{pid}/exe")), self.runtime / f"bin/triangulator-{app}")
        changed = self.command("set-rate.sh", "2")
        self.assertEqual(changed.returncode, 0, changed.stderr)
        config = self.runtime / "config/sampler.toml"
        before = config.read_text()
        result = self.command("start.sh")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(config.read_text(), before)
        helper = subprocess.run(
            ["python3", str(self.runtime / "scripts/sampler_control.py"), "collector"],
            env=self.environment, capture_output=True, text=True, timeout=5)
        self.assertEqual(helper.returncode, 0, helper.stderr)
        self.assertEqual(helper.stdout, f"127.0.0.1:{self.udp_port}\n")
        restarted = subprocess.run([str(self.runtime / "scripts/restart.sh"), "all"],
                                   env=self.environment, capture_output=True, text=True, timeout=20)
        self.assertEqual(restarted.returncode, 0, restarted.stdout + restarted.stderr)
        self.assertEqual(config.read_text(), before)

    def test_override_keeps_runtime_files_inside_the_selected_directory(self):
        self.runtime = self.home / "custom runtime"
        self.environment["TRIANGULATOR_HOME"] = str(self.runtime)
        self.start()
        self.assertTrue((self.runtime / "config/sampler.toml").is_file())
        self.assertFalse((self.home / "triangulator").exists())


if __name__ == "__main__":
    unittest.main()
