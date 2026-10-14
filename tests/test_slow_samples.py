"""Check that the slow-sample benchmark times the real resource and memory probes."""

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import benchmark_slow_samples as slow


class SlowSampleBenchmarkTests(unittest.TestCase):
    def test_driver_reports_both_kinds_for_a_small_target(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "slow.json"
            result = subprocess.run(
                [sys.executable, str(Path(slow.__file__)), "--shapes", "threads-only", "service",
                 "--iterations", "100", "--warmup", "0.1", "--repeats", "1",
                 "--output", str(output)], capture_output=True, text=True, timeout=120)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text())
            self.assertTrue(report["complete"])
            self.assertEqual(set(report["summary"]),
                             {"threads-only/resources", "threads-only/memory",
                              "service/resources", "service/memory"})
            for row in report["summary"].values():
                self.assertEqual(row["samples"], 100)
                self.assertGreater(row["wall_p50_us"], 0)
                self.assertGreater(row["cpu_mean_us"], 0)
                self.assertLessEqual(row["wall_p50_us"], row["wall_p95_us"])
            # The service target has at least the 5,000 mappings it asked for.
            self.assertGreaterEqual(report["summary"]["service/memory"]["maps_lines"], 5000)
            self.assertGreater(report["summary"]["service/memory"]["longest_read_max_us"], 0)
            self.assertNotIn("maps_lines", report["summary"]["service/resources"])
            self.assertIn("| service (", result.stdout)

    def test_unknown_sample_kind_is_rejected(self):
        result = subprocess.run([str(slow.BINARY), "1", "1", "100", "0", "bogus"],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("unknown sample kind", result.stderr)


if __name__ == "__main__":
    unittest.main()
