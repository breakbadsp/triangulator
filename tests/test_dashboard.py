"""Run the dashboard's JavaScript regressions when Node.js is available."""
import shutil
import subprocess
import unittest
from pathlib import Path


class DashboardTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "dashboard JavaScript tests require Node.js")
    def test_dashboard_regressions(self):
        result = subprocess.run(
            ["node", "--test", str(Path(__file__).with_name("dashboard_test.js"))],
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
