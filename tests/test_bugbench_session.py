"""Check persistent navigation and constrained workload launch behavior."""

import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / ".agents/skills/bugbench-session/scripts/session.py"
SPEC = importlib.util.spec_from_file_location("bugbench_session", SCRIPT)
session_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(session_module)


class SessionTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.session = session_module.Session(Path(self.directory.name))
        self.session.bin.mkdir()
        self.session.binary.touch()

    def test_navigation_reads_saved_position_and_preserves_boundaries(self):
        names = ["cpu-spin", "mem-oom", "healthy"]
        with patch.object(self.session, "scenarios", return_value=names), \
                patch.object(self.session, "launch") as launch:
            self.session.dispatch("next", None, 10)
            launch.assert_called_once_with("cpu-spin", 10)
            self.session.save({"scenario": "mem-oom"})
            # A new object must use the position on disk.
            other = session_module.Session(Path(self.directory.name))
            with patch.object(other, "scenarios", return_value=names), \
                    patch.object(other, "launch") as other_launch:
                other.dispatch("previous", None, 20)
                other_launch.assert_called_once_with("cpu-spin", 20)
            self.session.dispatch("next", None, 10)
            launch.assert_called_with("healthy", 10)
            self.session.save({"scenario": "healthy"})
            launch.reset_mock()
            self.session.dispatch("next", None, 10)
            launch.assert_not_called()
            self.assertEqual(self.session.state()["scenario"], "healthy")

    def test_launch_stops_owned_service_and_sets_oom_limit(self):
        storage = Path(self.directory.name) / "storage"
        storage.mkdir()
        self.session.save({"scenario": "cpu-spin", "unit": "triangular-bugbench-old.service"})
        with patch.object(self.session, "properties", return_value={"ActiveState": "active"}), \
                patch.object(self.session, "status"), \
                patch.object(session_module.tempfile, "mkdtemp", return_value=str(storage)), \
                patch.object(session_module, "command", return_value="") as command:
            self.session.launch("mem-oom", 1800)
            calls = [call.args[0] for call in command.call_args_list]
            self.assertEqual(calls[1], ["systemctl", "--user", "stop", "triangular-bugbench-old.service"])
            self.assertIn("--property=MemoryMax=256M", calls[2])
            self.assertIn("--property=MemorySwapMax=0", calls[2])
            self.assertEqual(calls[2][-2:], ["mem-oom", "1800"])
            self.assertEqual(self.session.state()["scenario"], "mem-oom")

    def test_failed_launch_does_not_advance_position(self):
        storage = Path(self.directory.name) / "storage"
        storage.mkdir()
        self.session.save({"scenario": "cpu-spin", "unit": None})
        with patch.object(session_module.tempfile, "mkdtemp", return_value=str(storage)), \
                patch.object(session_module, "command", side_effect=["", RuntimeError("failed")]):
            with self.assertRaisesRegex(RuntimeError, "failed"):
                self.session.launch("cpu-throttle", 10)
        self.assertEqual(self.session.state()["scenario"], "cpu-spin")
        self.assertFalse(storage.exists())


if __name__ == "__main__":
    unittest.main()
