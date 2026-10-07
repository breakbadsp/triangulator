#!/usr/bin/env bash
# Run this script as root in a disposable AlmaLinux container.
set -euo pipefail
exec > >(tee /reports/setup.log) 2>&1

cat /etc/os-release
uname -a
rpm -qa | sort > /reports/base-packages.txt
for command in git make c++ python3 node getconf sed od; do
    command -v "$command" || true
done

# Git is a checkout dependency. Install it before the first build attempt.
dnf install -y git
git -c safe.directory=/source clone --no-local /source /work
cd /work
git rev-parse HEAD > /reports/commit.txt
set +e
scripts/start.sh > /reports/first-start.log 2>&1
first_status=$?
set -e
printf '%s\n' "$first_status" > /reports/first-start.status
cat /reports/first-start.log

# Record the system compiler result before enabling a newer toolset.
dnf install -y dnf-plugins-core gcc-c++ make sqlite-devel
set +e
make build/build_options > /reports/missing-cmp.log 2>&1
cmp_status=$?
set -e
printf '%s\n' "$cmp_status" > /reports/missing-cmp.status
dnf install -y diffutils
c++ --version > /reports/system-compiler.txt
set +e
make > /reports/system-build.log 2>&1
system_status=$?
set -e
printf '%s\n' "$system_status" > /reports/system-build.status
tail -n 30 /reports/system-build.log

# CRB supplies the static runtime development packages.
dnf config-manager --set-enabled crb
dnf install -y glibc-static libstdc++-static shadow-utils util-linux
if [[ "$ALMA_VERSION" == 9 ]]; then
    dnf module enable -y nodejs:22
    dnf install -y gcc-toolset-14-gcc-c++ gcc-toolset-14-libstdc++-devel python3.11 nodejs
    mkdir -p /opt/test/bin
    ln -s /usr/bin/python3.11 /opt/test/bin/python3
    export PATH="/opt/test/bin:/opt/rh/gcc-toolset-14/root/usr/bin:$PATH"
else
    dnf install -y python3 nodejs
fi
c++ --version
python3 --version
node --version
rpm -qa | sort > /reports/build-packages.txt

# Use the documented amalgamation option for the fully static release.
# Verify the archive against the hash published by SQLite.
python3 - <<'PY'
import hashlib
from pathlib import Path
import urllib.request
import zipfile
archive = Path('/tmp/sqlite.zip')
urllib.request.urlretrieve('https://www.sqlite.org/2026/sqlite-amalgamation-3530400.zip', archive)
assert hashlib.sha3_256(archive.read_bytes()).hexdigest() == '628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e'
with zipfile.ZipFile(archive) as source:
    for filename in ('sqlite3.c', 'sqlite3.h'):
        Path('/tmp/' + filename).write_bytes(source.read('sqlite-amalgamation-3530400/' + filename))
PY

useradd -m tester
chown -R tester:tester /work /reports
runuser -u tester --preserve-environment -- bash .github/scripts/almalinux-user.sh
