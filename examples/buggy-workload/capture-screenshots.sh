#!/usr/bin/env bash
# Usage: examples/buggy-workload/capture-screenshots.sh <output-dir> [scenario...]
#
# For each scenario: run it under a private Triangulator pair, wait until its
# symptoms have developed, and save a full-page dashboard screenshot with
# headless Chromium. Needs chromium; build first (see run-scenario.sh).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$(realpath -m "${1:?output directory}")"
shift
mkdir -p "$out"

# scenario:seconds to wait before the screenshot[:extra run-scenario argument]
plan=(
    idle-baseline:15 cpu-spin:20 oversubscribed:20 lock-convoy:20 deadlock:20
    memory-leak:50 fault-storm:20 thread-leak:45 thread-churn:20 fd-leak:45
    close-wait:30 slow-consumer:30 sync-storm:30
    memory-leak:40:--limits cpu-spin:20:--limits
)

for entry in "${plan[@]}"; do
    IFS=: read -r scenario wait_s extra <<<"$entry"
    if [[ $# -gt 0 && ! " $* " == *" $scenario "* ]]; then continue; fi
    name="$scenario${extra:+-limits}"
    echo "== $name"
    "$here/run-scenario.sh" "$scenario" 0 $extra >/dev/null 2>&1 &
    runner=$!
    sleep "$wait_s"
    chromium --headless=new --no-sandbox --hide-scrollbars --window-size=1400,6400 \
        --virtual-time-budget=10000 --screenshot="$out/$name.png" http://127.0.0.1:9501 >/dev/null 2>&1 || true
    curl -s http://127.0.0.1:9501/api/live >"$out/$name.live.json" || true
    curl -s "http://127.0.0.1:9501/api/resources" >"$out/$name.resources.json" || true
    # run-scenario.sh stops its collector, sampler and workload on SIGTERM.
    kill "$runner" 2>/dev/null || true
    wait "$runner" 2>/dev/null || true
    sleep 5
done
