#!/usr/bin/env bash
# Run bugbench scenarios against an isolated Triangulator and capture the dashboard.
#
#   bug-lab/run-lab.sh [scenario ...]     (default: every scenario)
#
# Environment:
#   TRIANGULATOR_HOME  runtime directory (default ~/triangulator-lab); the
#                      sampler must already be configured and running there
#   HTTP_PORT          collector HTTP port (default 19401)
#   OUT                output directory (default docs/screenshots/bug-lab)
#   HOLD               seconds each scenario runs before the screenshot (default 70)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TRIANGULATOR_HOME="${TRIANGULATOR_HOME:-$HOME/triangulator-lab}"
port="${HTTP_PORT:-19401}"
out="${OUT:-$root/docs/screenshots/bug-lab}"
hold="${HOLD:-70}"
bench="${BUGBENCH:-/tmp/bugbench}"
mkdir -p "$out"
gcc -O2 -Wall -Wextra -pthread "$root/bug-lab/bugbench.c" -o "$bench"

all=(healthy cpu-spin cpu-oversub cpu-throttle yield-storm lock-convoy deadlock
     mem-leak mem-oom vm-bloat fd-leak disk-sync major-faults tcp-slow udp-drop
     close-wait listen-full thread-churn thread-leak stopped)
scenarios=("$@")
[[ ${#scenarios[@]} -gt 0 ]] || scenarios=("${all[@]}")

for name in "${scenarios[@]}"; do
    echo "== $name"
    run=("$bench" "$name" 300)
    comm="bb-$name"
    case "$name" in
        stopped) run=("$bench" healthy 300); comm=bb-healthy ;;
        cpu-throttle) run=(systemd-run --user --scope --quiet -p CPUQuota=50% "${run[@]}") ;;
        mem-oom) run=(systemd-run --user --scope --quiet -p MemoryHigh=160M -p MemoryMax=240M -p MemorySwapMax=0 "${run[@]}") ;;
    esac
    "${run[@]}" 2>"$out/$name.log" &
    app=$!
    sleep 1
    "$root/scripts/set-target.sh" "${comm:0:15}" >/dev/null
    # The page opens first so trend charts cover the whole run.
    node "$root/bug-lab/capture.mjs" "http://127.0.0.1:$port" "$hold" "$out/$name.png" \
        "#overview=$out/$name-overview.png" "#threads-section=$out/$name-threads.png" \
        "#resources=$out/$name-resources.png" "#memory-map=$out/$name-memory.png" &
    shot=$!
    if [[ "$name" == stopped ]]; then
        # Stop the whole process shortly before the screenshot, resume after it.
        sleep $((hold - 25))
        pkill -STOP -x "$comm" || true
        wait "$shot"
        pkill -CONT -x "$comm" || true
    fi
    wait "$shot"
    pkill -TERM -f "$bench $name" || true
    wait "$app" 2>/dev/null || true
    sleep 2
done
echo "screenshots in $out"
