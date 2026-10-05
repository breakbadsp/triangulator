#!/usr/bin/env bash
# Usage: scripts/set-rate.sh <Hz>
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -ne 1 ]]; then
    echo "usage: $0 <Hz> (0.2–10)" >&2
    exit 2
fi

python3 - "$root" "$1" <<'PY'
import math
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
import tomllib


def main():
    root = Path(sys.argv[1])
    try:
        rate = float(sys.argv[2])
    except ValueError:
        raise ValueError("sampling frequency must be a number between 0.2 and 10 Hz") from None
    if not math.isfinite(rate) or not 0.2 <= rate <= 10:
        raise ValueError("sampling frequency must be between 0.2 and 10 Hz")
    setting = f"rate_hz = {rate}"

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
    lines = config.read_text().splitlines(keepends=True)
    pattern = re.compile(r"^\s*rate_hz\s*=")
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
    print(f"Updated {config}: {setting} ({1000 / rate:g} ms between thread samples)")
    print(f"Requested reload of sampler {sampler_pid}; a successful reload starts a new session.")
    print("Socket observation still reports once per second.")


try:
    main()
except (OSError, ValueError, RuntimeError) as error:
    print(f"set-rate: {error}", file=sys.stderr)
    sys.exit(1)
PY
