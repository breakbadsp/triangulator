#!/usr/bin/env python3
"""Install a verified static ccache binary without extra container packages."""

import hashlib
from io import BytesIO
from pathlib import Path
import platform
import sys
import tarfile
import urllib.request


VERSION = "4.14.2"
SHA256 = {
    "x86_64": "d540ba01f160addbd3dd5e18eda9bd34005591b095c09ac8ae9d0a1b655e7ef5",
    "aarch64": "2be524bbccfc7e9ff0085d110da7dc9964de983bd92d29acf3b872e557194945",
}


def main():
    cache, destination = map(Path, sys.argv[1:])
    architecture = platform.machine()
    expected = SHA256[architecture]
    name = f"ccache-{VERSION}-linux-{architecture}-musl-static"
    archive = cache / f"{name}.tar.gz"
    data = archive.read_bytes() if archive.exists() else b""
    if hashlib.sha256(data).hexdigest() != expected:
        url = f"https://github.com/ccache/ccache/releases/download/v{VERSION}/{name}.tar.gz"
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError("ccache archive does not match its pinned SHA-256")
        cache.mkdir(parents=True, exist_ok=True)
        archive.write_bytes(data)
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=BytesIO(data), mode="r:gz") as source:
        # Read only the binary. Archive paths are never extracted.
        binary = source.extractfile(f"{name}/ccache")
        (destination / "ccache").write_bytes(binary.read())
    (destination / "ccache").chmod(0o755)


if __name__ == "__main__":
    main()
