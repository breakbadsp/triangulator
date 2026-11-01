"""Check AI setup with real Git repositories and an isolated home."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
URL = "https://github.com/breakbadsp/ai-assets.git"


class SetupAITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.home = self.directory / "home"
        self.home.mkdir()
        self.remote = self.directory / "upstream"
        self.remote.mkdir()
        self.checkout = self.home / "ai"
        self.environment = dict(os.environ, HOME=str(self.home),
                                GIT_CONFIG_GLOBAL=str(self.home / ".gitconfig"),
                                GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")
        self.git("init", "--initial-branch=main", cwd=self.remote)
        self.git("config", "--global", "user.name", "Setup test")
        self.git("config", "--global", "user.email", "setup@example.invalid")
        self.git("config", "--global", f"url.{self.remote}.insteadOf", URL)
        (self.remote / "scripts").mkdir()
        (self.remote / "install.sh").write_text(
            '#!/bin/bash\nset -eu\n'
            'git -C "$HOME/ai" rev-parse HEAD > "$HOME/installed-commit"\n')
        (self.remote / "scripts/check-loomflow.sh").write_text(
            '#!/bin/bash\nset -eu\n'
            'test -s "$HOME/installed-commit"\n'
            'test -f "$1/.claude/commands/loomflow.md"\n'
            'test -f "$1/docs/loomflow.md"\n')
        self.commit(self.remote)

    def git(self, *arguments, cwd=None):
        return subprocess.run(["git", *arguments], cwd=cwd,
                              env=self.environment, check=True,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, path):
        self.git("add", ".", cwd=path)
        self.git("commit", "-m", "Fixture update", cwd=path)
        return self.git("rev-parse", "HEAD", cwd=path)

    def setup_ai(self, success=True):
        # Run outside the project to check script-relative reference validation.
        result = subprocess.run(["bash", str(ROOT / "scripts/setup-ai.sh")],
                                cwd=self.directory, env=self.environment,
                                capture_output=True, text=True)
        if success:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            expected = self.git("rev-parse", "HEAD", cwd=self.remote)
            self.assertEqual(self.git("rev-parse", "HEAD", cwd=self.checkout), expected)
            self.assertEqual((self.home / "installed-commit").read_text().strip(), expected)
            self.assertIn(expected, result.stdout)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn("LoomFlow ready", result.stdout)
        return result

    def test_clone_update_and_repeat(self):
        self.setup_ai()
        (self.remote / "new-file").write_text("Latest instructions\n")
        self.commit(self.remote)
        self.setup_ai()
        self.assertEqual((self.checkout / "new-file").read_text(), "Latest instructions\n")
        self.setup_ai()

    def test_offline_stops_before_install(self):
        self.setup_ai()
        (self.home / "installed-commit").unlink()
        self.remote.rename(self.directory / "unavailable")
        result = self.setup_ai(success=False)
        self.assertIn("Cannot confirm", result.stderr)
        self.assertFalse((self.home / "installed-commit").exists())

    def test_dirty_checkout_is_preserved(self):
        self.setup_ai()
        changed = self.checkout / "install.sh"
        changed.write_text("Local edit\n")
        self.setup_ai(success=False)
        self.assertEqual(changed.read_text(), "Local edit\n")

    def test_local_commit_is_preserved(self):
        self.setup_ai()
        (self.checkout / "local-file").write_text("Local work\n")
        local_head = self.commit(self.checkout)
        self.setup_ai(success=False)
        self.assertEqual(self.git("rev-parse", "HEAD", cwd=self.checkout), local_head)

    def test_existing_directory_is_preserved(self):
        self.checkout.mkdir()
        local = self.checkout / "notes"
        local.write_text("Local work\n")
        self.setup_ai(success=False)
        self.assertEqual(local.read_text(), "Local work\n")

    def test_wrong_origin_or_branch_is_rejected(self):
        self.setup_ai()
        self.git("remote", "set-url", "origin", "https://example.invalid/other.git",
                 cwd=self.checkout)
        self.setup_ai(success=False)
        self.git("remote", "set-url", "origin", URL, cwd=self.checkout)
        self.git("switch", "-c", "local-work", cwd=self.checkout)
        self.setup_ai(success=False)

    def test_untracked_file_is_preserved(self):
        self.setup_ai()
        local = self.checkout / "notes"
        local.write_text("Local work\n")
        self.setup_ai()
        self.assertEqual(local.read_text(), "Local work\n")

    def test_installer_failure_stops_setup(self):
        (self.remote / "install.sh").write_text("exit 1\n")
        self.commit(self.remote)
        self.setup_ai(success=False)


if __name__ == "__main__":
    unittest.main()
