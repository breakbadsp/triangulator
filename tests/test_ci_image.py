"""Check prepared CI image reuse, invalidation, and concurrent runner slots."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class CIImageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="triangulator-ci-image-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        for name in ("almalinux-image.sh", "almalinux-ci.Dockerfile", "almalinux-toolchain.sh", "install-node.sh"):
            shutil.copyfile(ROOT / ".github/scripts" / name, self.directory / name)
        docker = self.directory / "docker"
        docker.write_text('''#!/usr/bin/env python3
import os
from pathlib import Path
import sys
import time
root = Path(os.environ["IMAGE_TEST_ROOT"])
args = sys.argv[1:]
if args[:2] == ["image", "inspect"]:
    sys.exit(0 if (root / args[2].split(":")[-1]).exists() else 1)
with (root / "calls").open("a") as output:
    output.write(" ".join(args) + "\\n")
if args[0] == "build":
    time.sleep(0.1)
    (root / args[args.index("-t") + 1].split(":")[-1]).touch()
''')
        docker.chmod(0o755)
        self.environment = {**os.environ, "PATH": f"{self.directory}:{os.environ['PATH']}",
                            "IMAGE_TEST_ROOT": str(self.directory),
                            "XDG_CACHE_HOME": str(self.directory / "cache"),
                            "ALMA_VERSION": "8", "LEAN_PR": "1"}
        self.command = ["bash", str(self.directory / "almalinux-image.sh")]

    def run_image(self):
        return subprocess.run(self.command, env=self.environment, check=True,
                              capture_output=True, text=True, timeout=10).stdout.strip()

    def test_warm_image_is_reused_and_toolchain_changes_invalidate_it(self):
        first = self.run_image()
        self.assertEqual(self.run_image(), first)
        self.assertEqual(len((self.directory / "calls").read_text().splitlines()), 1)
        for name in ("almalinux-toolchain.sh", "almalinux-ci.Dockerfile", "install-node.sh"):
            with self.subTest(name=name):
                with (self.directory / name).open("a") as output:
                    output.write("\n# Changed toolchain\n")
                following = self.run_image()
                self.assertNotEqual(following, first)
                first = following
        self.environment["ALMA_VERSION"] = "9"
        self.assertNotEqual(self.run_image(), first)
        calls = (self.directory / "calls").read_text()
        self.assertEqual(calls.count("build --build-arg"), 5)
        self.assertNotIn("pull", calls)

    def test_full_installation_uses_a_fresh_base_image(self):
        self.environment["LEAN_PR"] = "0"
        self.assertEqual(self.run_image(), "almalinux:8")
        self.assertEqual((self.directory / "calls").read_text(), "pull almalinux:8\n")

    def test_runner_slots_build_one_shared_image(self):
        processes = [subprocess.Popen(self.command, env=self.environment,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                     for _ in range(3)]
        try:
            outputs = [process.communicate(timeout=10) for process in processes]
            self.assertEqual([process.returncode for process in processes], [0, 0, 0], outputs)
            self.assertEqual(len({output[0] for output in outputs}), 1)
            self.assertEqual(len((self.directory / "calls").read_text().splitlines()), 1)
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.communicate()
