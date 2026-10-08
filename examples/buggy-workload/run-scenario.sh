#!/usr/bin/env bash
# Usage: examples/buggy-workload/run-scenario.sh <scenario> [seconds] [--limits]
#
# Runs one buggy-workload scenario under a private Triangulator pair (its own
# ports and data), so a monitoring setup you already run is left alone. Open
# http://127.0.0.1:9501 while it runs. Press Ctrl-C to stop everything.
# --limits runs the workload in a systemd user scope with a CPU quota and a
# memory cap, to see cgroup throttling and OOM findings.
# Build first: make && make -C examples/buggy-workload
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scenario="${1:?scenario name; see buggy-workload --list}"
seconds="${2:-0}"
limits="${3:-}"
home="${BUGGY_HOME:-/tmp/buggy-triangulator}"
workload="$root/build/buggy-workload"

rm -rf "$home"
mkdir -p "$home/data" "$home/logs"
cat >"$home/sampler.toml" <<TOML
target_process = "buggy-workload"
rate_hz = 2.0
collector = "127.0.0.1:9500"
status_fallback = false
resource_interval_s = 1
memory_interval_s = 5
TOML
cat >"$home/collector.toml" <<TOML
clock_ticks = $(getconf CLK_TCK)
udp_host = "127.0.0.1"
udp_port = 9500
http_host = "127.0.0.1"
http_port = 9501
sampler_ip = "127.0.0.1"
data_dir = "$home/data"
retention_days = 1
store_raw = false
replay_interval_s = 1
max_live_samples = 1000000
[[group]]
name = "io"
prefix = "io-"
[[group]]
name = "worker"
prefix = "worker-"
[[group]]
name = "sender"
prefix = "sender-"
[[group]]
name = "misc"
prefix = "misc-"
TOML

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

"$root/build/triangulator-collector" "$home/collector.toml" >"$home/logs/collector.log" 2>&1 &
pids+=($!)
"$root/build/triangulator-sampler" "$home/sampler.toml" >"$home/logs/sampler.log" 2>&1 &
pids+=($!)

if [[ "$limits" == --limits ]]; then
    systemd-run --user --scope --quiet -p CPUQuota=30% -p MemoryMax=400M -p MemorySwapMax=0 \
        "$workload" "$scenario" "$seconds" &
else
    "$workload" "$scenario" "$seconds" &
fi
pids+=($!)
echo "dashboard: http://127.0.0.1:9501   (logs in $home/logs)"
wait "${pids[-1]}" || true
if [[ "$seconds" == 0 ]]; then
    # Killed (for example by the memory limit): keep the monitors up so the
    # dashboard can show how the death was reported.
    echo "workload exited; the monitors keep running until you press Ctrl-C"
    wait
fi
