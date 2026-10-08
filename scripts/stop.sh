#!/usr/bin/env bash
# Usage: scripts/stop.sh (stop both)
# Optional: scripts/stop.sh <sampler|collector>
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/runtime.sh"
if [[ $# -eq 0 ]]; then
    "$root/scripts/stop.sh" sampler
    "$root/scripts/stop.sh" collector
    exit 0
fi
app="${1:-}"
case "$app" in
    sampler|collector) ;;
    *) echo "usage: $0 [sampler|collector]" >&2; exit 2 ;;
esac

pidfile="$run_dir/$app.pid"
if [[ ! -f "$pidfile" ]]; then
    echo "$app not running (no pidfile)"
    exit 0
fi

pid="$(<"$pidfile")"
[[ "$pid" =~ ^[1-9][0-9]*$ ]] || { echo "invalid pidfile: $pidfile" >&2; exit 1; }
if kill -0 "$pid" 2>/dev/null; then
    # Never signal a recycled PID that now belongs to another program.
    executable="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
    [[ "${executable% (deleted)}" == "$bin_dir/triangulator-$app" ||
       "${executable% (deleted)}" == "$root/build/triangulator-$app" ]] || {
        echo "$pidfile points to another program; refusing to signal it" >&2
        exit 1
    }
    kill -TERM "$pid"
    for _ in {1..50}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    if kill -0 "$pid" 2>/dev/null; then
        echo "$app (pid $pid) ignored SIGTERM; sending SIGKILL" >&2
        kill -KILL "$pid"
    fi
    echo "$app stopped (pid $pid)"
else
    echo "$app not running (stale pidfile)"
fi
rm -f "$pidfile"
