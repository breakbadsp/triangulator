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
#   HOLD               seconds before the screenshot (default 70, thread-leak 165)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TRIANGULATOR_HOME="${TRIANGULATOR_HOME:-$HOME/triangulator-lab}"
port="${HTTP_PORT:-19401}"
out="${OUT:-$root/docs/screenshots/bug-lab}"
if [[ -n ${HOLD+x} ]] && [[ ! $HOLD =~ ^[1-9][0-9]{0,3}$ || $HOLD -lt 26 || $HOLD -gt 3600 ]]; then
    echo "HOLD must be an integer from 26 to 3600 seconds" >&2
    exit 2
fi
app=''
shot=''
scratch=''
cleanup() {
    if [[ -n $shot ]]; then
        kill -TERM "$shot" 2>/dev/null || true
        wait "$shot" 2>/dev/null || true
        shot=''
    fi
    if [[ -n $app ]]; then
        kill -CONT "$app" 2>/dev/null || true
        kill -TERM "$app" 2>/dev/null || true
        wait "$app" 2>/dev/null || true
        app=''
    fi
}
finish() {
    cleanup
    if [[ -n $scratch ]]; then
        rm -rf -- "$scratch"
    fi
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
scratch="$(mktemp -d "${TMPDIR:-/var/tmp}/triangulator-bug-lab.XXXXXX")"
export BUG_LAB_DIR="${BUG_LAB_DIR:-$scratch/data}"
bench="${BUGBENCH:-$scratch/bugbench}"
mkdir -p "$out"
gcc -O2 -Wall -Wextra -pthread "$root/bug-lab/bugbench.c" -o "$bench"

all=(healthy cpu-spin cpu-oversub cpu-throttle yield-storm lock-convoy deadlock
     mem-leak mem-oom vm-bloat fd-leak disk-sync major-faults tcp-slow udp-drop
     close-wait listen-full thread-churn thread-leak stopped)
scenarios=("$@")
[[ ${#scenarios[@]} -gt 0 ]] || scenarios=("${all[@]}")

for name in "${scenarios[@]}"; do
    echo "== $name"
    hold="${HOLD:-70}"
    [[ $name != thread-leak || -n ${HOLD+x} ]] || hold=165
    seconds=$((hold + 30))
    run=("$bench" "$name" "$seconds")
    case "$name" in
        stopped) run=("$bench" healthy "$seconds") ;;
        cpu-throttle) run=(systemd-run --user --scope --quiet -p CPUQuota=50% "${run[@]}") ;;
        mem-oom) run=(systemd-run --user --scope --quiet -p MemoryHigh=160M -p MemoryMax=240M -p MemorySwapMax=0 "${run[@]}") ;;
    esac
    "${run[@]}" 2>"$out/$name.log" &
    app=$!
    sleep 1
    if ! kill -0 "$app" 2>/dev/null; then
        echo "$name exited before target selection; see $out/$name.log" >&2
        exit 1
    fi
    # Select by PID: a name is ambiguous if another lab run uses the same scenario.
    "$root/scripts/set-target.sh" "$app" >/dev/null
    # The page opens first so trend charts cover the whole run.
    node "$root/bug-lab/capture.mjs" "http://127.0.0.1:$port" "$hold" "$out/$name.png" \
        "#overview=$out/$name-overview.png" "#threads-section=$out/$name-threads.png" \
        "#resources=$out/$name-resources.png" "#memory-map=$out/$name-memory.png" &
    shot=$!
    if [[ "$name" == stopped ]]; then
        # Stop the whole process shortly before the screenshot, resume after it.
        sleep $((hold - 25))
        kill -STOP "$app" || true
        wait "$shot"
        shot=''
        kill -CONT "$app" || true
    fi
    if [[ -n $shot ]]; then
        wait "$shot"
        shot=''
    fi
    cleanup
    sleep 2
done
echo "screenshots in $out"
