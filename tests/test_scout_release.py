"""Prove that the optional scout asset cannot enter the core packages."""
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ScoutReleaseTest(unittest.TestCase):
    def test_core_archives_exclude_scout(self):
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run(
                ["bash", str(ROOT / "scripts/package.sh"), "test", "scout-proof", directory],
                cwd=ROOT, check=True, capture_output=True,
            )
            archives = list(Path(directory).glob("*.tar.gz"))
            self.assertEqual(len(archives), 2)
            for archive in archives:
                with tarfile.open(archive) as package:
                    names = package.getnames()
                    self.assertFalse(any("tri-scout" in name for name in names))
                    kind = "sampler" if "sampler" in archive.name else "collector"
                    self.assertIn(f"triangulator/bin/triangulator-{kind}", names)
