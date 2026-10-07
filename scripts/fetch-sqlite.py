#!/usr/bin/env python3
"""Download the SQLite amalgamation and check it against the published hash.

Usage: scripts/fetch-sqlite.py DIRECTORY
Writes sqlite3.c and sqlite3.h to DIRECTORY. Use it for fully static builds on
systems without libsqlite3.a:

    make sqlite-amalgamation
    make release SQLITE_SOURCE=build/sqlite/sqlite3.c
"""
import hashlib
import sys
import urllib.request
import zipfile
from io import BytesIO
from pathlib import Path

NAME = 'sqlite-amalgamation-3530400'
URL = f'https://www.sqlite.org/2026/{NAME}.zip'
# SHA3-256 of the archive, as published on https://www.sqlite.org/download.html
SHA3_256 = '628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e'


def main(argv):
    if len(argv) != 2:
        print(f'usage: {argv[0]} DIRECTORY', file=sys.stderr)
        return 2
    target = Path(argv[1])
    with urllib.request.urlopen(URL, timeout=60) as response:
        archive = response.read()
    if hashlib.sha3_256(archive).hexdigest() != SHA3_256:
        print(f'error: {URL} does not match the expected SHA3-256 hash.', file=sys.stderr)
        return 1
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(BytesIO(archive)) as source:
        for filename in ('sqlite3.c', 'sqlite3.h'):
            (target / filename).write_bytes(source.read(f'{NAME}/{filename}'))
    print(f'Wrote {target}/sqlite3.c and {target}/sqlite3.h')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
