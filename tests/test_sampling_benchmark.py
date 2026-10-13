"""Check direct sampling, percentile ranks, and baseline comparisons."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import benchmark_sampling


class SamplingBenchmarkTests(unittest.TestCase):
    def test_real_sampler_functions_at_all_thread_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "results.json"
            result = subprocess.run(
                [sys.executable, str(Path(benchmark_sampling.__file__)),
                 "--iterations", "100", "--warmup", "0.1", "--repeats", "1",
                 "--output", str(output)], capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text())
            self.assertTrue(report["complete"])
            self.assertEqual([row["threads"] for row in report["summary"]], [1, 100, 200, 300, 500])
            for row in report["summary"]:
                self.assertEqual(row["ticks"], 100)
                self.assertEqual(row["thread_records"], row["threads"] * 100)
                self.assertGreater(row["throughput_threads_s"], 0)
                self.assertGreater(row["mean_thread_us"], 0)
                self.assertLessEqual(row["p50_tick_us"], row["p90_tick_us"])
                self.assertLessEqual(row["p90_tick_us"], row["p99_tick_us"])
                self.assertLessEqual(row["p99_tick_us"], row["p100_tick_us"])
                self.assertIn(f"| {row['threads']} |", result.stdout)
            self.assertTrue(all(all(row[key + "_change_percent"] == 0
                                         for key in benchmark_sampling.METRICS)
                                for row in benchmark_sampling.compare(report, report)))
            compared = Path(directory) / "comparison.json"
            comparison = subprocess.run(
                [sys.executable, str(Path(benchmark_sampling.__file__)),
                 "--iterations", "100", "--warmup", "0.1", "--repeats", "1",
                 "--compare", str(output), "--output", str(compared)],
                capture_output=True, text=True, timeout=30)
            self.assertEqual(comparison.returncode, 0, comparison.stderr)
            self.assertIn("Change from baseline", comparison.stdout)
            self.assertEqual(len(json.loads(compared.read_text())["comparison"]), 5)

    def test_known_percentiles_and_throughput(self):
        row = benchmark_sampling.summarize(list(range(1000, 101000, 1000)), 5)
        self.assertEqual(row["p50_tick_us"], 50)
        self.assertEqual(row["p90_tick_us"], 90)
        self.assertEqual(row["p99_tick_us"], 99)
        self.assertEqual(row["p100_tick_us"], 100)
        self.assertEqual(row["mean_thread_us"], 10.1)
        self.assertAlmostEqual(row["throughput_threads_s"], 500 / 0.00505)
        with self.assertRaises(ValueError):
            benchmark_sampling.summarize([0], 1)

    def test_comparison_rejects_incomplete_or_different_settings(self):
        old = {"complete": True, "iterations": 100,
               "summary": [benchmark_sampling.summarize([1000], 1)]}
        current = {**old, "summary": [benchmark_sampling.summarize([2000], 1)]}
        difference = benchmark_sampling.compare(old, current)[0]
        self.assertEqual(difference["throughput_threads_s_change_percent"], -50)
        self.assertEqual(difference["mean_tick_us_change_percent"], 100)
        with self.assertRaisesRegex(ValueError, "iterations"):
            benchmark_sampling.compare(old, {**current, "iterations": 200})
        with self.assertRaisesRegex(ValueError, "complete"):
            benchmark_sampling.compare(old, {**current, "complete": False})
