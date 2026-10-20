"""Check the pinned compiler-cache download and cached archive validation."""

import hashlib
import importlib.util
from io import BytesIO
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / ".github/scripts/install-compiler-cache.py"
SPEC = importlib.util.spec_from_file_location("compiler_cache", SCRIPT)
CACHE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CACHE)


class CompilerCacheTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.archive = self.directory / f"ccache-{CACHE.VERSION}-linux-x86_64-musl-static.tar.gz"
        buffer = BytesIO()
        with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
            name = self.archive.name.removesuffix(".tar.gz") + "/ccache"
            entry = tarfile.TarInfo(name)
            entry.size = len(b"compiler cache")
            archive.addfile(entry, BytesIO(b"compiler cache"))
        self.data = buffer.getvalue()
        self.addCleanup(patch.stopall)
        patch.object(CACHE.platform, "machine", return_value="x86_64").start()
        patch.dict(CACHE.SHA256, {"x86_64": hashlib.sha256(self.data).hexdigest()}).start()
        patch.object(CACHE.sys, "argv", [str(SCRIPT), str(self.directory), str(self.directory / "bin")]).start()

    def test_verified_cached_archive_needs_no_download(self):
        self.archive.write_bytes(self.data)
        with patch.object(CACHE.urllib.request, "urlopen") as download:
            CACHE.main()
        download.assert_not_called()
        binary = self.directory / "bin/ccache"
        self.assertEqual(binary.read_bytes(), b"compiler cache")
        self.assertTrue(binary.stat().st_mode & 0o111)

    def test_corrupt_cached_archive_is_downloaded_again(self):
        self.archive.write_bytes(b"corrupt")
        with patch.object(CACHE.urllib.request, "urlopen", return_value=BytesIO(self.data)) as download:
            CACHE.main()
        download.assert_called_once()
        self.assertEqual(self.archive.read_bytes(), self.data)

    def test_download_with_wrong_hash_is_rejected(self):
        with patch.object(CACHE.urllib.request, "urlopen", return_value=BytesIO(b"wrong")):
            with self.assertRaisesRegex(ValueError, "SHA-256"):
                CACHE.main()
        self.assertFalse((self.directory / "bin/ccache").exists())
