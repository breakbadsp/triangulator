"""Run the required dashboard JavaScript tests."""
import shutil
import subprocess
import unittest
from pathlib import Path


class DashboardTests(unittest.TestCase):
    def test_dashboard_regressions(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "dashboard tests require Node.js; see docs/build-guidelines.md")
        result = subprocess.run(
            [node, "--test", str(Path(__file__).with_name("dashboard_test.js"))],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
