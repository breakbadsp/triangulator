#!/usr/bin/env bash
# Usage: scripts/start.sh <sampler|collector> [config.toml]
# Both run as the invoking user with no extra privileges; run the sampler as the
# target process's user so its per-thread /proc files are readable.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_dir="$root/.run"
app="${1:-}"
config="${2:-$root/config/$app.toml}"

case "$app" in
    sampler|collector) ;;
    *) echo "usage: $0 <sampler|collector> [config.toml]" >&2; exit 2 ;;
esac
[[ -f "$config" ]] || { echo "config not found: $config" >&2; exit 1; }

mkdir -p "$run_dir"
pidfile="$run_dir/$app.pid"
log="$run_dir/$app.log"

if [[ -f "$pidfile" ]] && kill -0 "$(<"$pidfile")" 2>/dev/null; then
    echo "$app already running (pid $(<"$pidfile"))" >&2
    exit 1
fi

if [[ "$app" == collector ]]; then
    cd "$root"
    nohup python3 -B -m triangulator "$config" >>"$log" 2>&1 &
    echo $! >"$pidfile"
else
    bin="$root/build/triangulator-sampler"
    [[ -x "$bin" ]] || { echo "missing $bin; run make" >&2; exit 1; }
    nohup "$bin" "$config" >>"$log" 2>&1 &
    echo $! >"$pidfile"
fi

sleep 0.5
if kill -0 "$(<"$pidfile")" 2>/dev/null; then
    echo "$app started (pid $(<"$pidfile")), log: $log"
else
    echo "$app failed to start; see $log" >&2
    rm -f "$pidfile"
    exit 1
fi
