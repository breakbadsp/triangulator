#!/usr/bin/env bash
# Usage: scripts/watch-sockets.sh [options] <process-name|pid>
# Runs in the foreground; Ctrl+C stops observation and sends a final snapshot.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
usage() {
    echo "usage: $0 [--sudo] [--collector IP:PORT] [--marker BINARY SYMBOL] <process-name|pid>"
}
elevate=false
collector=""
marker=()
target=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --sudo) elevate=true; shift ;;
        --collector)
            [[ $# -ge 2 ]] || { usage >&2; exit 2; }
            collector="$2"; shift 2 ;;
        --marker)
            [[ $# -ge 3 ]] || { usage >&2; exit 2; }
            marker=("$2" "$3"); shift 3 ;;
        -h|--help) usage; exit 0 ;;
        -*) usage >&2; exit 2 ;;
        *)
            [[ -z "$target" ]] || { usage >&2; exit 2; }
            target="$1"; shift ;;
    esac
done
[[ -n "$target" ]] || { usage >&2; exit 2; }

pid="$(python3 - "$target" <<'PY'
from pathlib import Path
import sys

target = sys.argv[1]
try:
    if target.isascii() and target.isdecimal():
        pid = int(target)
        if not 0 < pid <= 2147483647 or not Path(f"/proc/{pid}/stat").exists():
            raise ValueError("target PID is invalid or is not running")
    else:
        if not 1 <= len(target.encode()) <= 15:
            raise ValueError("process name must contain 1..15 bytes")
        matches = []
        for entry in Path('/proc').iterdir():
            if not entry.name.isdecimal():
                continue
            try:
                if (entry / 'comm').read_bytes().removesuffix(b'\n') == target.encode():
                    matches.append(int(entry.name))
            except OSError:
                continue
        if not matches:
            raise ValueError(f"no running process named {target}")
        if len(matches) != 1:
            raise ValueError(f"multiple processes named {target}; pass a PID from: {sorted(matches)}")
        pid = matches[0]
    print(pid)
except (OSError, ValueError) as error:
    print(f"watch-sockets: {error}", file=sys.stderr)
    sys.exit(1)
PY
)"

if [[ -z "$collector" ]]; then
    collector="$(python3 - "$root/config/local/sampler.toml" <<'PY'
import sys
import tomllib
try:
    with open(sys.argv[1], 'rb') as config:
        endpoint = tomllib.load(config)['collector']
    if not isinstance(endpoint, str) or not endpoint:
        raise ValueError('collector must be a nonempty string')
    print(endpoint)
except (OSError, ValueError, KeyError) as error:
    print(f'watch-sockets: cannot read local collector endpoint: {error}; pass --collector IP:PORT', file=sys.stderr)
    sys.exit(1)
PY
)"
fi
if [[ ${#marker[@]} -gt 0 ]]; then
    [[ -r "${marker[0]}" && -n "${marker[1]}" ]] || {
        echo "watch-sockets: --marker requires a readable ELF binary/library and a symbol" >&2
        exit 2
    }
    marker[0]="$(realpath -- "${marker[0]}")"
fi
[[ -r /sys/kernel/btf/vmlinux ]] || {
    echo "watch-sockets: kernel BTF is unavailable (/sys/kernel/btf/vmlinux)" >&2
    exit 1
}

# Compile as the invoking user; only the observer needs tracing privileges.
make -C "$root" socket-sampler
mkdir -p "$root/.run"
command=("$root/build/triangulator-socket-sampler" "$pid" "$collector" "$root/build/socket.bpf.o" "${marker[@]}")
if [[ "$elevate" == true ]]; then
    command=(sudo -- "${command[@]}")
fi
echo "Observing PID $pid; sending to $collector. Ctrl+C stops observation."
echo "Log: $root/.run/socket-sampler.log"
echo "Set the normal sampler to PID $pid with scripts/set-target.sh $pid."
echo "View the dashboard's Socket I/O & message processing panel."
if [[ ${#marker[@]} -eq 0 ]]; then
    echo "Message counts need --marker BINARY SYMBOL; socket bytes work without a marker."
fi
"${command[@]}" 2>&1 | tee -a "$root/.run/socket-sampler.log"
