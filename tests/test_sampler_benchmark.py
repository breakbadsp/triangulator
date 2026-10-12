"""Check that the benchmark measures real sampler output at all four rates."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import benchmark_sampler


class SamplerBenchmarkTests(unittest.TestCase):
    def test_real_busy_target_and_all_rates(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "results.json"
            result = subprocess.run(
                [sys.executable, str(Path(benchmark_sampler.__file__)),
                 "--duration", "2", "--warmup", "0.2", "--repeats", "1",
                 "--output", str(output)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text())
            self.assertEqual(report["target_threads"], 500)
            self.assertEqual(report["busy_threads"], 1)
            self.assertEqual(report["sleeping_threads"], 499)
            self.assertEqual([run["rate_hz"] for run in report["runs"]], [1, 2, 5, 10])
            for run in report["runs"]:
                self.assertGreater(run["sampler_cpu_percent"], 0)
                self.assertGreater(run["workload_cpu_percent"], 0)
                self.assertGreater(run["sampler_rss_mean_mib"], 0)
                self.assertGreaterEqual(run["sampler_rss_max_mib"], run["sampler_rss_mean_mib"])
                self.assertGreaterEqual(run["rss_observations"], 3)
                self.assertGreaterEqual(run["thread_ticks"], 2)
                self.assertAlmostEqual(run["observed_rate_hz"], run["rate_hz"], delta=0.1 * run["rate_hz"])
                self.assertIn(f"| {run['rate_hz']} Hz |", result.stdout)

    def test_failed_sampler_stops_the_workload(self):
        # The trial context must reap its workload even when sampling fails.
        children = Path("/proc/self/task") / str(os.getpid()) / "children"
        before = children.read_text()
        with self.assertRaisesRegex(RuntimeError, "exited before the first sample"):
            benchmark_sampler.trial(Path("/bin/false"), 1, 2, 0)
        self.assertEqual(children.read_text(), before)

    def test_nonfinite_duration_is_rejected(self):
        result = subprocess.run(
            [sys.executable, str(Path(benchmark_sampler.__file__)), "--duration", "nan"],
            capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertIn("duration must be at least 2", result.stderr)
