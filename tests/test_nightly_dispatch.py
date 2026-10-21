"""Prove dispatch behavior with a fake gh executable; never submit to GitHub."""

import contextlib
from datetime import datetime
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("nightly_dispatch", ROOT / ".github/scripts/dispatch-nightly.py")
DISPATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DISPATCH)
NOW = datetime(2026, 10, 21, 3, tzinfo=DISPATCH.IST)

FAKE_GH = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
root = Path(os.environ["FAKE_GH_ROOT"])
args = sys.argv[1:]
with (root / "calls").open("a") as stream:
    stream.write(json.dumps(args) + "\\n")
config = json.loads((root / "config").read_text())
if args[0] == "workflow":
    state = json.loads(Path(os.environ["FAKE_STATE"]).read_text())
    assert state["2026-10-21"][args[2]]["status"] == "pending", state
    if args[2] == config.get("fail"):
        print("connection lost after submission", file=sys.stderr)
        sys.exit(1)
else:
    endpoint = args[3]
    if endpoint.endswith("/jobs"):
        print(json.dumps([{"jobs": [{"name": name} for name in config.get("jobs", [])]}]))
    else:
        workflow = endpoint.split("/")[-2]
        print(json.dumps([{"workflow_runs": config.get(workflow, [])}]))
'''


class NightlyDispatchTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        executable = self.root / "gh"
        executable.write_text(FAKE_GH)
        executable.chmod(0o755)
        self.state = self.root / "state/nightly.json"
        self.configure()
        self.environment = patch.dict(os.environ, {
            "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
            "FAKE_GH_ROOT": str(self.root),
            "FAKE_STATE": str(self.state),
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def configure(self, **values):
        (self.root / "config").write_text(json.dumps(values))

    def invoke(self, *args, now=NOW):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            status = DISPATCH.main(["--state-path", str(self.state), *args], now=now)
        return status, output.getvalue()

    def submissions(self):
        path = self.root / "calls"
        calls = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        return [call for call in calls if call[0] == "workflow"]

    def run_record(self, event="schedule", branch="master"):
        return {"id": 123, "event": event, "head_branch": branch,
                "created_at": "2026-10-20T21:30:00Z", "html_url": "https://example.test/run/123"}

    def test_all_three_once_with_full_defaults(self):
        self.assertEqual(self.invoke()[0], 0)
        self.assertEqual(self.submissions(), [
            ["workflow", "run", name, "--repo", DISPATCH.REPO, "--ref", "master"]
            for name in DISPATCH.WORKFLOWS])
        self.assertEqual(self.invoke()[0], 0)
        self.assertEqual(len(self.submissions()), 3)

    def test_existing_schedule_suppresses_only_its_workflow(self):
        self.configure(**{"sanitizers.yml": [self.run_record()]})
        status, output = self.invoke()
        self.assertEqual(status, 0, output)
        self.assertIn("existing full run", output)
        self.assertEqual([call[2] for call in self.submissions()], list(DISPATCH.WORKFLOWS[1:]))

    def test_dry_run_has_no_state_or_submissions(self):
        self.configure(**{"sanitizers.yml": [self.run_record()]})
        status, output = self.invoke("--dry-run")
        self.assertEqual(status, 0, output)
        self.assertEqual(output.count("WOULD DISPATCH"), 2)
        self.assertFalse(self.state.parent.exists())
        self.assertEqual(self.submissions(), [])
        self.invoke()
        before = {p.name: p.read_bytes() for p in self.state.parent.iterdir()}
        self.invoke("--dry-run")
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.state.parent.iterdir()})

    def test_uncertain_submission_is_not_retried_and_other_successes_remain(self):
        self.configure(fail="almalinux-user-test.yml")
        status, output = self.invoke()
        self.assertEqual(status, 1)
        self.assertIn("UNCERTAIN", output)
        self.assertEqual(len(self.submissions()), 3)
        self.assertEqual(self.invoke()[0], 1)
        self.assertEqual(len(self.submissions()), 3)
        records = json.loads(self.state.read_text())["2026-10-21"]
        self.assertEqual([records[name]["status"] for name in DISPATCH.WORKFLOWS],
                         ["submitted", "pending", "submitted"])
        self.configure(**{"almalinux-user-test.yml": [self.run_record()]})
        self.assertEqual(self.invoke()[0], 0)
        self.assertEqual(len(self.submissions()), 3)

    def test_lean_manual_does_not_suppress_full_almalinux(self):
        self.configure(**{"almalinux-user-test.yml": [self.run_record("workflow_dispatch")],
                          "jobs": ["C++ format", "AlmaLinux 8"]})
        self.assertEqual(self.invoke()[0], 0)
        self.assertEqual(len(self.submissions()), 3)

    def test_full_manual_suppresses_almalinux(self):
        self.configure(**{"almalinux-user-test.yml": [self.run_record("workflow_dispatch")],
                          "jobs": ["C++ format", "AlmaLinux 8", "AlmaLinux 9"]})
        self.assertEqual(self.invoke()[0], 0)
        self.assertEqual([call[2] for call in self.submissions()],
                         ["sanitizers.yml", "release-package.yml"])

    def test_before_three_has_no_side_effects(self):
        status, output = self.invoke(now=NOW.replace(hour=2, minute=59))
        self.assertEqual(status, 0)
        self.assertIn("before 03:00", output)
        self.assertFalse(self.state.parent.exists())
        self.assertFalse((self.root / "calls").exists())

    def test_damaged_state_fails_closed(self):
        self.state.parent.mkdir()
        self.state.write_text('{"2026-10-21": {"sanitizers.yml": {"status": "unknown"}}}')
        status, output = self.invoke()
        self.assertEqual(status, 1)
        self.assertIn("invalid dispatch state", output)
        self.assertEqual(self.submissions(), [])

    def test_process_lock_blocks_submission(self):
        import fcntl
        self.state.parent.mkdir()
        with self.state.with_suffix(".json.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            status, output = self.invoke()
        self.assertEqual(status, 1)
        self.assertIn("process lock", output)
        self.assertEqual(self.submissions(), [])
