import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "qa_summary.py"


class QaSummaryTests(unittest.TestCase):
    def test_recorded_results_are_consistent(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--check"],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("| **Total** |", result.stdout)

    def test_every_status_is_counted(self):
        result = subprocess.run([sys.executable, str(SCRIPT)],
                                capture_output=True, text=True, check=True)
        for status in ("PASSED", "FAILED", "BLOCKED", "NOT_RUN"):
            self.assertIn(f"| {status} |", result.stdout)


if __name__ == "__main__":
    unittest.main()
