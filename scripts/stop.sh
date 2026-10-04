#!/usr/bin/env bash
# Usage: scripts/stop.sh <sampler|collector>
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
app="${1:-}"
case "$app" in
    sampler|collector) ;;
    *) echo "usage: $0 <sampler|collector>" >&2; exit 2 ;;
esac

pidfile="$root/.run/$app.pid"
if [[ ! -f "$pidfile" ]]; then
    echo "$app not running (no pidfile)"
    exit 0
fi

pid="$(<"$pidfile")"
if kill -0 "$pid" 2>/dev/null; then
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
