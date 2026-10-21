"""Check CI reuse against real Git histories and a controlled GitHub response."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / ".github/scripts/ci-reuse.py"


class CIReuseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.repository = self.root / "repository"
        self.repository.mkdir()
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        self.base = self.commit("app.py", "print(0)\n")
        self.previous = self.commit("app.py", "print(1)\n")
        tools = self.root / "bin"
        tools.mkdir()
        gh = tools / "gh"
        gh.write_text("#!/usr/bin/env python3\nimport os, sys\n"
                      "if os.environ.get('API_FAIL'): sys.exit(1)\n"
                      "print(os.environ['API_RESPONSE'])\n")
        gh.chmod(0o755)
        self.environment = {**os.environ, "PATH": str(tools) + os.pathsep + os.environ["PATH"],
                            "GITHUB_REPOSITORY": "owner/repository",
                            "GITHUB_EVENT_NAME": "pull_request",
                            "GITHUB_EVENT_PATH": str(self.root / "event.json"),
                            "GITHUB_OUTPUT": str(self.root / "output")}

    def git(self, *arguments):
        return subprocess.run(["git", *arguments], cwd=self.repository, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, path, content):
        file = self.repository / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(content)
        self.git("add", path)
        self.git("commit", "-qm", "Test change")
        return self.git("rev-parse", "HEAD")

    def run_check(self, *, number=133, conclusion="success"):
        event = {"number": 133, "pull_request": {
            "head": {"sha": self.git("rev-parse", "HEAD"), "ref": "change"},
            "base": {"sha": self.base}}}
        Path(self.environment["GITHUB_EVENT_PATH"]).write_text(json.dumps(event))
        run = {"conclusion": conclusion, "pull_requests": [{"number": number}],
               "head_sha": self.previous, "html_url": "https://example.invalid/passing-run"}
        self.environment["API_RESPONSE"] = json.dumps({"workflow_runs": [run]})
        output = Path(self.environment["GITHUB_OUTPUT"])
        output.unlink(missing_ok=True)
        result = subprocess.run(["python3", str(SCRIPT)], cwd=self.repository,
                                env=self.environment, check=True, capture_output=True, text=True)
        return output.read_text().strip(), result

    def test_documentation_update_reuses_a_passing_run(self):
        self.commit("README.md", "Updated QA summary\n")
        output, result = self.run_check()
        self.assertEqual(output, "run_tests=false")
        self.assertIn("https://example.invalid/passing-run", result.stdout)

    def test_code_tests_build_config_and_markdown_fixtures_require_checks(self):
        for path in ["app.py", "tests/check.py", "Makefile", "tests/fixture.md",
                     ".github/workflows/almalinux-user-test.yml"]:
            with self.subTest(path=path):
                self.git("checkout", "--detach", self.previous)
                self.commit(path, "Changed input\n")
                self.assertEqual(self.run_check()[0], "run_tests=true")

    def test_new_base_code_requires_checks_even_when_head_is_unchanged(self):
        self.git("checkout", "--detach", self.base)
        self.base = self.commit("upstream.py", "print(2)\n")
        self.git("checkout", "--detach", self.previous)
        self.assertEqual(self.run_check()[0], "run_tests=true")

    def test_documentation_merge_reuses_the_passing_inputs(self):
        self.git("checkout", "--detach", self.base)
        self.base = self.commit("docs/qa/results.md", "New upstream result\n")
        self.git("checkout", "--detach", self.previous)
        self.git("merge", "--no-ff", "--no-edit", self.base)
        self.assertEqual(self.run_check()[0], "run_tests=false")

    def test_a_different_pr_or_failed_run_is_not_reused(self):
        for arguments in [{"number": 134}, {"conclusion": "failure"}]:
            with self.subTest(arguments=arguments):
                self.assertEqual(self.run_check(**arguments)[0], "run_tests=true")

    def test_unavailable_github_history_runs_the_checks(self):
        self.environment["API_FAIL"] = "1"
        output, result = self.run_check()
        self.assertEqual(output, "run_tests=true")
        self.assertIn("Cannot verify", result.stderr)

    def test_missing_commit_history_runs_the_checks(self):
        self.previous = "0" * 40
        self.assertEqual(self.run_check()[0], "run_tests=true")

    def test_manual_dispatch_runs_without_querying_history(self):
        self.environment["GITHUB_EVENT_NAME"] = "workflow_dispatch"
        self.environment["API_FAIL"] = "1"
        output, result = self.run_check()
        self.assertEqual(output, "run_tests=true")
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
