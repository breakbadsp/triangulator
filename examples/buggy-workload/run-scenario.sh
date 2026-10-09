#!/usr/bin/env bash
# Usage: examples/buggy-workload/run-scenario.sh <scenario> [seconds] [--limits]
# Run one scenario on UDP 9500 and HTTP 9501. Build with make check first.
# BUGGY_HOME selects a base directory. Each run keeps its own logs and data.
# --limits uses a systemd user scope with a CPU quota and memory cap.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scenario="${1:?scenario name; see buggy-workload --list}"
seconds="${2:-0}"
limits="${3:-}"
if [[ $# -gt 3 || ! "$seconds" =~ ^[0-9]+$ || ( -n "$limits" && "$limits" != --limits ) ]]; then
    echo 'expected <scenario> [nonnegative seconds] [--limits]' >&2
    exit 2
fi
workload="$root/build/buggy-workload"
# Reject a bad scenario before starting any processes or creating directories.
if ! "$workload" --list | awk '{print $1}' | grep -Fxq -- "$scenario"; then
    echo "unknown scenario: $scenario" >&2
    exit 2
fi
state_base="${BUGGY_HOME:-${TMPDIR:-/tmp}}"
mkdir -p -- "$state_base"
run_dir="$(mktemp -d "$state_base/buggy-triangulator.XXXXXX")"
mkdir -p "$run_dir/data" "$run_dir/logs"
config_dir="${run_dir//\\/\\\\}"
config_dir="${config_dir//\"/\\\"}"
cat >"$run_dir/collector.toml" <<TOML
clock_ticks = $(getconf CLK_TCK)
udp_host = "127.0.0.1"
udp_port = 9500
http_host = "127.0.0.1"
http_port = 9501
sampler_ip = "127.0.0.1"
data_dir = "$config_dir/data"
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
scope=""
cleanup() {
    trap - EXIT INT TERM
    if [[ -n "${runner:-}" ]] && kill -0 "$runner" 2>/dev/null && [[ -f "$run_dir/workload.pid" ]]; then
        kill "$(cat "$run_dir/workload.pid")" 2>/dev/null || true
    fi
    if [[ -n "$scope" ]]; then
        systemctl --user stop "$scope" >/dev/null 2>&1 || true
    fi
    # Include a child started immediately before a signal interrupted the
    # next pids assignment.
    while read -r pid; do pids+=("$pid"); done < <(jobs -pr)
    if [[ ${#pids[@]} -gt 0 ]]; then
        kill "${pids[@]}" 2>/dev/null || true
        for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"$root/build/triangulator-collector" "$run_dir/collector.toml" >"$run_dir/logs/collector.log" 2>&1 &
collector=$!
pids+=("$collector")
# Give binding errors time to reach the collector log. Never start a workload
# against a dashboard that already owns these ports.
sleep 0.2
ready=false
for attempt in {1..50}; do
    if ! kill -0 "$collector" 2>/dev/null; then
        cat "$run_dir/logs/collector.log" >&2
        exit 1
    fi
    if curl --fail --silent --max-time 1 http://127.0.0.1:9501/api/live >/dev/null; then
        ready=true
        break
    fi
    sleep 0.1
done
if [[ "$ready" != true ]]; then
    echo "collector did not start; see $run_dir/logs/collector.log" >&2
    exit 1
fi

# The wrapper writes the workload PID before exec. Use that explicit PID
# to select exactly this run, with or without a systemd scope.
cat >"$run_dir/workload-wrapper.sh" <<'SH'
printf '%s\n' "$$" > "$1"
exec "$2" "$3" "$4"
SH
command=(bash "$run_dir/workload-wrapper.sh"
    "$run_dir/workload.pid" "$workload" "$scenario" "$seconds")
if [[ "$limits" == --limits ]]; then
    scope="buggy-workload-$$.scope"
    systemd-run --user --scope --unit="$scope" --quiet -p CPUQuota=30% -p MemoryMax=400M -p MemorySwapMax=0 \
        "${command[@]}" &
else
    "${command[@]}" &
fi
runner=$!
pids+=("$runner")
for attempt in {1..50}; do
    [[ -s "$run_dir/workload.pid" ]] && break
    if ! kill -0 "$runner" 2>/dev/null; then
        echo 'workload did not start' >&2
        exit 1
    fi
    sleep 0.1
done
if [[ ! -s "$run_dir/workload.pid" ]]; then
    echo 'workload did not report its PID' >&2
    exit 1
fi
workload_pid="$(cat "$run_dir/workload.pid")"
if [[ ! "$workload_pid" =~ ^[1-9][0-9]*$ ]]; then
    echo 'workload reported an invalid PID' >&2
    exit 1
fi
cat >"$run_dir/sampler.toml" <<TOML
target_pid = $workload_pid
rate_hz = 2.0
collector = "127.0.0.1:9500"
status_fallback = false
resource_interval_s = 1
memory_interval_s = 5
TOML
"$root/build/triangulator-sampler" "$run_dir/sampler.toml" >"$run_dir/logs/sampler.log" 2>&1 &
sampler=$!
pids+=("$sampler")
sleep 0.2
if ! kill -0 "$sampler" 2>/dev/null; then
    cat "$run_dir/logs/sampler.log" >&2
    exit 1
fi
echo "dashboard: http://127.0.0.1:9501   (logs in $run_dir/logs)"
result=0
wait "$runner" || result=$?
if [[ "$seconds" =~ ^0+$ ]]; then
    echo 'workload exited; the monitors keep running until you press Ctrl-C'
    wait
else
    exit "$result"
fi
