#!/usr/bin/env bash
# Usage: scripts/start.sh (build and start both with config/local/*.toml)
# Optional: scripts/start.sh <sampler|collector> [config.toml]
# Both run as the invoking user with no extra privileges; run the sampler as the
# target process's user so its per-thread /proc files are readable.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_dir="$root/.run"

if [[ $# -eq 0 ]]; then
    cd "$root"
    python3 - "$root" <<'PY'
import os
from pathlib import Path
import sys

root = Path(sys.argv[1])
local = root / "config/local"
local.mkdir(parents=True, exist_ok=True)
for app in ("sampler", "collector"):
    path = local / f"{app}.toml"
    if path.exists():
        continue
    text = (root / "config" / f"{app}.toml").read_text()
    if app == "sampler":
        text = text.replace('collector = "10.0.0.5:9400"', 'collector = "127.0.0.1:9400"')
    else:
        text = text.replace('udp_host = "0.0.0.0"', 'udp_host = "127.0.0.1"')
        text = text.replace('sampler_ip = "10.0.0.10"', 'sampler_ip = "127.0.0.1"')
        text = text.replace('data_dir = "/var/lib/triangulator"', 'data_dir = "./data"')
        text = text.replace('clock_ticks = 100', f'clock_ticks = {os.sysconf("SC_CLK_TCK")}')
        text = text.replace('webhook_url = "https://your-alert-service.example/triangulator"',
                            '# webhook_url = "https://your-alert-service.example/triangulator"')
    with path.open("x") as config_file:
        config_file.write(text)
    print(f"Created {path}")
PY
    echo "Set target_process (or target_pid) in $root/config/local/sampler.toml to select the process to monitor."
    make -C "$root"
    python3 -B -m triangulator "$root/config/local/collector.toml" --check-config

    collector_was_running=false
    if [[ -f "$run_dir/collector.pid" ]] && kill -0 "$(<"$run_dir/collector.pid")" 2>/dev/null; then
        collector_was_running=true
    fi
    "$root/scripts/start.sh" collector "$root/config/local/collector.toml"
    if ! "$root/scripts/start.sh" sampler "$root/config/local/sampler.toml"; then
        if [[ "$collector_was_running" == false ]]; then
            "$root/scripts/stop.sh" collector
        fi
        exit 1
    fi
    echo "Dashboard address is configured by http_host and http_port in config/local/collector.toml (default: http://127.0.0.1:9401)."
    exit 0
fi

app="${1:-}"
config="${2:-$root/config/$app.toml}"

case "$app" in
    sampler|collector) ;;
    *) echo "usage: $0 [<sampler|collector> [config.toml]]" >&2; exit 2 ;;
esac
[[ -f "$config" ]] || { echo "config not found: $config" >&2; exit 1; }

mkdir -p "$run_dir"
pidfile="$run_dir/$app.pid"
log="$run_dir/$app.log"

if [[ -f "$pidfile" ]] && kill -0 "$(<"$pidfile")" 2>/dev/null; then
    echo "$app already running (pid $(<"$pidfile"))" >&2
    exit 0
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
