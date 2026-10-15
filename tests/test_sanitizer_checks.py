"""Check that child sanitizer reports cannot produce a successful test run."""

from contextlib import redirect_stderr
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import run_checks


class SanitizerChecksTests(unittest.TestCase):
    def test_required_runtime_options_follow_caller_options(self):
        with patch.dict(os.environ, {"ASAN_OPTIONS": "detect_leaks=0:log_path=stderr"}):
            environment = run_checks.sanitizer_environment("address", Path("/tmp/reports"))
        self.assertTrue(environment["ASAN_OPTIONS"].endswith(
            "halt_on_error=1:log_path=/tmp/reports/ASAN_OPTIONS:detect_leaks=1"))
        self.assertIn("print_stacktrace=1", environment["UBSAN_OPTIONS"])
        self.assertIn("halt_on_error=1", environment["TSAN_OPTIONS"])

    def test_discarded_child_report_fails_an_otherwise_successful_suite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def run(command, *, cwd, env, check):
                # Simulate a passing test that discards a child's stderr.
                options = dict(option.split("=", 1) for option in
                               env["TSAN_OPTIONS"].split(":") if "=" in option)
                prefix = options["log_path"]
                Path(prefix + ".123").write_text("WARNING: ThreadSanitizer: data race\n")
                return subprocess.CompletedProcess(command, 0)

            errors = io.StringIO()
            with patch.object(run_checks, "ROOT", root), \
                    patch.dict(os.environ, {"SANITIZER": "thread"}), \
                    patch("sys.argv", ["run_checks.py"]), \
                    patch.object(run_checks.subprocess, "run", side_effect=run), \
                    redirect_stderr(errors):
                status = run_checks.main()
            self.assertEqual(status, 1)
            self.assertIn("data race", errors.getvalue())
            self.assertTrue(list(root.glob("build/sanitizer-reports/thread/run-*/TSAN_OPTIONS.123")))

    def test_empty_report_directory_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "ASAN_OPTIONS.123").touch()
            self.assertFalse(run_checks.check_reports(Path(directory)))

    def test_native_test_failure_stops_the_suite(self):
        with patch.dict(os.environ, {"SANITIZER": ""}), \
                patch("sys.argv", ["run_checks.py", "build/wire-test"]), \
                patch.object(run_checks.subprocess, "run",
                             return_value=subprocess.CompletedProcess([], 1)) as run:
            self.assertEqual(run_checks.main(), 1)
        self.assertEqual(run.call_count, 1)
