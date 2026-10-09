#!/usr/bin/env bash
# Usage: examples/buggy-workload/capture-screenshots.sh <output-dir> [scenario...]
# Run each scenario and save a dashboard screenshot and API data.
# Requires Chromium and curl. Build with make check first.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$(realpath -m "${1:?output directory}")"
shift
mkdir -p "$out"
runner=""
sleeper=""
browser=""
profile=""
cleanup() {
    trap - EXIT INT TERM
    if [[ -n "$browser" ]]; then
        # timeout starts a separate process group. Stop all browser children.
        kill -KILL -- "-$browser" 2>/dev/null || true
        kill -KILL "$browser" 2>/dev/null || true
        wait "$browser" 2>/dev/null || true
    fi
    [[ -z "$profile" ]] || rm -rf -- "$profile"
    [[ -z "$sleeper" ]] || kill "$sleeper" 2>/dev/null || true
    if [[ -n "$runner" ]]; then
        kill "$runner" 2>/dev/null || true
        wait "$runner" 2>/dev/null || true
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pause() {
    sleep "$1" &
    sleeper=$!
    wait "$sleeper"
    sleeper=""
}

# scenario:seconds before capture[:run-scenario argument]
plan=(
    idle-baseline:15 cpu-spin:20 oversubscribed:20 lock-convoy:20 deadlock:20
    memory-leak:50 fault-storm:20 thread-leak:45 thread-churn:20 fd-leak:45
    close-wait:30 slow-consumer:30 sync-storm:30
    memory-leak:40:--limits cpu-spin:20:--limits
)
for requested in "$@"; do
    found=false
    for entry in "${plan[@]}"; do
        [[ "${entry%%:*}" != "$requested" ]] || found=true
    done
    if [[ "$found" != true ]]; then
        echo "unknown scenario: $requested" >&2
        exit 2
    fi
done
for entry in "${plan[@]}"; do
    IFS=: read -r scenario wait_s extra <<<"$entry"
    if [[ $# -gt 0 && ! " $* " == *" $scenario "* ]]; then continue; fi
    name="$scenario${extra:+-limits}"
    echo "== $name"
    args=("$scenario" 0)
    [[ -z "$extra" ]] || args+=("$extra")
    "$here/run-scenario.sh" "${args[@]}" >"$out/$name.run.log" 2>&1 &
    runner=$!
    pause "$wait_s"
    kill -0 "$runner"
    profile="$(mktemp -d "${TMPDIR:-/tmp}/buggy-chromium.XXXXXX")"
    timeout --kill-after=5s 45s chromium --user-data-dir="$profile" --headless=new --hide-scrollbars --window-size=1400,6400 \
        --virtual-time-budget=10000 --screenshot="$out/$name.png" http://127.0.0.1:9501 >"$out/$name.chromium.log" 2>&1 &
    browser=$!
    wait "$browser"
    browser=""
    rm -rf -- "$profile"
    profile=""
    curl --fail --silent --show-error --max-time 5 http://127.0.0.1:9501/api/live >"$out/$name.live.json"
    curl --fail --silent --show-error --max-time 5 http://127.0.0.1:9501/api/resources >"$out/$name.resources.json"
    kill "$runner" 2>/dev/null || true
    wait "$runner" 2>/dev/null || true
    runner=""
    pause 1
done
