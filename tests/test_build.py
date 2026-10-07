"""Check build option tracking without compiling."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class BuildOptionsTests(unittest.TestCase):
    def run_make(self, directory, *arguments, path=None):
        environment = os.environ.copy()
        environment.pop("MAKEFLAGS", None)
        environment.pop("MFLAGS", None)
        if path is not None:
            environment["PATH"] = str(path)
        return subprocess.run(
            [shutil.which("make"), "--no-print-directory", "build/build_options", *arguments],
            cwd=directory, env=environment, capture_output=True, text=True, timeout=10)

    def prepare(self, directory):
        shutil.copyfile(ROOT / "Makefile", Path(directory) / "Makefile")
        tools = Path(directory) / "tools"
        tools.mkdir()
        for name in ("mkdir", "mv", "rm", "true"):
            (tools / name).symlink_to(shutil.which(name))
        return tools

    def test_build_options_do_not_require_cmp(self):
        with tempfile.TemporaryDirectory() as directory:
            tools = self.prepare(directory)
            result = self.run_make(directory, path=tools)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((Path(directory) / "build/build_options").exists())

    def test_same_options_preserve_the_timestamp_and_new_options_replace_them(self):
        with tempfile.TemporaryDirectory() as directory:
            self.prepare(directory)
            first = self.run_make(directory, "CXXFLAGS=-O2")
            self.assertEqual(first.returncode, 0, first.stderr)
            options = Path(directory) / "build/build_options"
            before = options.stat().st_mtime_ns
            old_options = options.read_text()
            unchanged = self.run_make(directory, "CXXFLAGS=-O2")
            self.assertEqual(unchanged.returncode, 0, unchanged.stderr)
            self.assertEqual(options.stat().st_mtime_ns, before)
            changed = self.run_make(directory, "CXXFLAGS=-O3")
            self.assertEqual(changed.returncode, 0, changed.stderr)
            self.assertIn("-O3", options.read_text())
            self.assertNotEqual(options.read_text(), old_options)

    def test_build_options_ignore_a_failing_cmp(self):
        with tempfile.TemporaryDirectory() as directory:
            tools = self.prepare(directory)
            first = self.run_make(directory, "CXXFLAGS=-O2")
            self.assertEqual(first.returncode, 0, first.stderr)
            failing_cmp = tools / "cmp"
            failing_cmp.write_text("#!/bin/sh\nexit 2\n")
            failing_cmp.chmod(0o755)
            changed = self.run_make(directory, "CXXFLAGS=-O3", path=tools)
            self.assertEqual(changed.returncode, 0, changed.stderr)
            self.assertIn("-O3", (Path(directory) / "build/build_options").read_text())
