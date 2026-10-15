import subprocess
import sys
import unittest
from pathlib import Path
from runpy import run_path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "qa_summary.py"


class QaSummaryTests(unittest.TestCase):
    def test_case_procedures_do_not_require_result_rows(self):
        check = run_path(str(SCRIPT))["check"]
        with patch.dict(check.__globals__, {"defined_ids": lambda: {"QA-001", "QA-002"}}):
            rows = [("QA-001", "NOT_RUN", "-", "-", "-")]
            self.assertEqual(check(rows), [])
            self.assertEqual(check(rows + [("QA-003", "NOT_RUN", "-", "-", "-")]),
                             ["QA-003: result row has no case definition"])

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
