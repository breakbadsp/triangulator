#!/usr/bin/env bash
set -euo pipefail
root=${1:?pass master checkout path}
cd "$root"
make build/benchmark-sampling build/benchmark-target
out=$(mktemp -d)
trap 'kill "$target" 2>/dev/null || true; wait "$target" 2>/dev/null || true' EXIT
build/benchmark-target 500 > "$out/target" &
target=$!
for ((i=0; i<100; i++)); do
  if rg -q '^500 threads ready$' "$out/target"; then break; fi
  sleep .1
done
rg -q '^500 threads ready$' "$out/target"
test "$(ls /proc/"$target"/task | wc -l)" -eq 500
for trial in 1 2 3; do
  perf stat -x, -o "$out/stat-$trial" -e cycles:u,instructions:u,cache-references:u,cache-misses:u,branches:u,branch-misses:u -- build/benchmark-sampling "$target" 500 2000 1000 > /dev/null
  cat "$out/stat-$trial"
done
printf 'Output: %s\n' "$out"
