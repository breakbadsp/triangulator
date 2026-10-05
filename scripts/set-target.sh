#!/usr/bin/env bash
# Usage: scripts/set-target.sh <process-name|pid>
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -ne 1 ]]; then
    echo "usage: $0 <process-name|pid>" >&2
    exit 2
fi

python3 - "$root" "$1" <<'PY'
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
import tomllib


def main():
    root = Path(sys.argv[1])
    target = sys.argv[2]
    if target.isascii() and target.isdecimal():
        pid = int(target)
        if not 0 < pid <= 2147483647:
            raise ValueError("target PID must be a positive 32-bit integer")
        setting = f"target_pid = {pid}"
    else:
        if not 1 <= len(target.encode()) <= 15 or any(c in target for c in '\"\n\r\x00'):
            raise ValueError("process name must contain 1..15 bytes and no quotes or newlines")
        setting = f'target_process = "{target}"'

    pid_text = (root / ".run/sampler.pid").read_text().strip()
    if not pid_text.isascii() or not pid_text.isdecimal() or int(pid_text) <= 0:
        raise ValueError("invalid sampler pidfile; start the sampler with scripts/start.sh")
    sampler_pid = int(pid_text)
    proc = Path(f"/proc/{sampler_pid}")
    executable = os.readlink(proc / "exe").removesuffix(" (deleted)")
    if Path(executable) != root / "build/triangulator-sampler":
        raise ValueError("sampler pidfile points to a different program; refusing to reload it")
    args = (proc / "cmdline").read_bytes().split(b"\0")
    if len(args) != 3 or args[-1] != b"":
        raise ValueError("cannot determine the running sampler's config path")
    config = Path(os.fsdecode(args[1]))
    if not config.is_absolute():
        config = proc / "cwd" / config
    config = config.resolve(strict=True)
    contents = config.read_text()
    # Preserve all other settings and comments, removing either target selector.
    lines = contents.splitlines(keepends=True)
    pattern = re.compile(r"^\s*target_(?:process|pid)\s*=")
    updated = setting + "\n" + "".join(line for line in lines if not pattern.match(line))
    tomllib.loads(updated)
    os.kill(sampler_pid, 0)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=config.parent, delete=False) as output:
            temporary = Path(output.name)
            os.fchmod(output.fileno(), config.stat().st_mode & 0o777)
            output.write(updated)
        os.replace(temporary, config)
        temporary = None
        try:
            os.kill(sampler_pid, signal.SIGHUP)
        except OSError as error:
            raise RuntimeError(f"updated {config}, but reload failed: {error}; restart the sampler") from error
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    print(f"Updated {config}: {setting}")
    print(f"Requested reload of sampler {sampler_pid}; check the dashboard and .run/sampler.log.")


try:
    main()
except (OSError, ValueError, RuntimeError) as error:
    print(f"set-target: {error}", file=sys.stderr)
    sys.exit(1)
PY
