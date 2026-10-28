#!/bin/bash
set -eu
cd /qa
mkdir -p fixtures runtime/run runtime/logs
for pair in control:healthy cpu:cpu-spin memory:mem-leak fds:fd-leak locks:deadlock; do
 id=${pair%:*}; scenario=${pair#*:}; duration=7200; [ "$id" != memory ] || duration=170
 (ulimit -n 256; exec /qa/bugbench "$scenario" "$duration") >"fixtures/$id.log" 2>&1 &
 echo $! >"fixtures/$id.pid"
done
cat >runtime/config/sampler.toml <<EOF
rate_hz = 10.0
collector = "127.0.0.1:19500"
resource_interval_s = 1
memory_interval_s = 5
cpu_budget_pct = 1.0
[[target]]
id = "control"
process = "bb-healthy"
[[target]]
id = "cpu"
process = "bb-cpu-spin"
[[target]]
id = "memory"
process = "bb-mem-leak"
[[target]]
id = "fds"
process = "bb-fd-leak"
[[target]]
id = "locks"
process = "bb-deadlock"
EOF
export TRIANGULATOR_HOME=/qa/runtime
/qa/install/triangulator/scripts/start.sh
