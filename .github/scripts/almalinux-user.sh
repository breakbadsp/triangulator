#!/usr/bin/env bash
# Build and run as the same unprivileged user as the target process.
set -euo pipefail
exec > >(tee /reports/user-test.log) 2>&1
cd /work
id
target_pid=
cleanup() {
    scripts/stop.sh || true
    if [[ -n "$target_pid" ]]; then
        kill "$target_pid" 2>/dev/null || true
        wait "$target_pid" 2>/dev/null || true
    fi
    cp -a .run /reports/startup-logs 2>/dev/null || true
}
trap cleanup EXIT

make clean
scripts/start.sh
sleep 120 &
target_pid=$!
scripts/set-target.sh "$target_pid"
scripts/set-rate.sh 5
python3 - "$target_pid" <<'PY'
import json
import sys
import time
import urllib.request
pid = int(sys.argv[1])
base = 'http://127.0.0.1:9401'
for attempt in range(100):
    with urllib.request.urlopen(base + '/api/live', timeout=2) as response:
        live = json.load(response)
    if live['health'].get('pid') == pid and live.get('threads'):
        break
    time.sleep(.1)
else:
    raise SystemExit('The dashboard did not receive the target samples.')
assert live['threads'][0]['name'] == 'sleep', live['threads']
with open('/reports/startup-live.json', 'w') as output:
    json.dump(live, output, indent=2)
with urllib.request.urlopen(base, timeout=2) as response:
    assert response.status == 200
    assert b'<html' in response.read().lower()
print('Startup, target change, rate change, dashboard and live samples passed.')
PY
scripts/stop.sh
make -j2 check 2>&1 | tee /reports/check.log

mkdir -p /reports/normal /reports/release
cp build/triangulator-{sampler,collector,socket-report,memory-report} /reports/normal/
for binary in /reports/normal/*; do
    readelf -lW "$binary"
    readelf -dW "$binary"
done > /reports/normal-linkage.txt

# Both programs must print usage for --help and exit with status 0.
build/triangulator-sampler --help > /reports/sampler-help.log
build/triangulator-socket-report --help > /reports/socket-report-help.log
build/triangulator-memory-report --help > /reports/memory-report-help.log

# Without a static SQLite library, release must stop with a clear message.
set +e
make release > /reports/release-without-amalgamation.log 2>&1
release_status=$?
set -e
printf '%s\n' "$release_status" > /reports/release-without-amalgamation.status
[[ "$release_status" != 0 ]]
grep -q 'make sqlite-amalgamation' /reports/release-without-amalgamation.log

make sqlite-amalgamation
make -j2 release SQLITE_SOURCE=build/sqlite/sqlite3.c
make -j2 check STATIC=1 SQLITE_SOURCE=build/sqlite/sqlite3.c 2>&1 | tee /reports/release-check.log
cp build/triangulator-{sampler,collector,socket-report,memory-report} /reports/release/
for binary in /reports/release/*; do
    readelf -lW "$binary"
    readelf -dW "$binary"
done > /reports/release-linkage.txt
