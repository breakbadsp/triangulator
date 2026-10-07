#!/usr/bin/env bash
# Run copied static binaries without installing packages in this container.
set -euo pipefail
exec > >(tee /reports/runtime.log) 2>&1
id
cat /etc/os-release
rpm -qa | sort > /reports/runtime-packages.txt
for command in python3 c++ make; do
    command -v "$command" || true
done
mkdir -p /tmp/triangulator
cd /tmp/triangulator
cp /reports/release/triangulator-* .
sleep 60 &
target_pid=$!
collector_pid=
sampler_pid=
cleanup() {
    for pid in "$sampler_pid" "$collector_pid" "$target_pid"; do
        if [[ -n "$pid" ]]; then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
    done
}
trap cleanup EXIT
printf '%s\n' "$target_pid" > /reports/runtime-target.pid
cat > sampler.toml <<EOF
target_pid = $target_pid
collector = "127.0.0.1:9400"
rate_hz = 5
EOF
cat > collector.toml <<EOF
udp_host = "127.0.0.1"
http_host = "127.0.0.1"
data_dir = "/tmp/triangulator/data"
clock_ticks = $(getconf CLK_TCK)
EOF
./triangulator-sampler --check-config sampler.toml
./triangulator-collector --check-config collector.toml
./triangulator-collector collector.toml > /reports/runtime-collector.log 2>&1 &
collector_pid=$!
./triangulator-sampler sampler.toml > /reports/runtime-sampler.log 2>&1 &
sampler_pid=$!
for attempt in {1..50}; do
    if (exec 3<>/dev/tcp/127.0.0.1/9401) 2>/dev/null; then
        break
    fi
    sleep .1
done
sleep 2
exec 3<>/dev/tcp/127.0.0.1/9401
printf 'GET /api/live HTTP/1.0\r\nHost: localhost\r\n\r\n' >&3
cat <&3 > /reports/runtime-live.http
exec 3>&-
exec 3<>/dev/tcp/127.0.0.1/9401
printf 'GET / HTTP/1.0\r\nHost: localhost\r\n\r\n' >&3
cat <&3 > /reports/runtime-dashboard.http
exec 3>&-
grep -qi '<html' /reports/runtime-dashboard.http
kill -0 "$collector_pid" "$sampler_pid"
