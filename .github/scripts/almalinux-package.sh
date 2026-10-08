#!/usr/bin/env bash
# Run as root in a disposable AlmaLinux 8 or 9 container with the repository
# mounted at /source (read-only) and an output directory at /dist.
# Usage: almalinux-package.sh <version>
set -euo pipefail

version="$1"
el="${ALMA_VERSION:?set ALMA_VERSION to 8 or 9}"

# Static libraries live in PowerTools on AlmaLinux 8 and in CRB on 9.
dnf install -y dnf-plugins-core
dnf config-manager --set-enabled "$([[ "$el" == 8 ]] && echo powertools || echo crb)"
dnf install -y gcc-toolset-14-gcc-c++ gcc-toolset-14-libstdc++-devel \
    glibc-static libstdc++-static make python3.11 tar gzip
mkdir -p /opt/tools/bin
ln -s /usr/bin/python3.11 /opt/tools/bin/python3
export PATH="/opt/tools/bin:$PATH"
export CXX=/opt/rh/gcc-toolset-14/root/usr/bin/g++

cp -a /source /work
cd /work
make sqlite-amalgamation
make -j2 release SQLITE_SOURCE=build/sqlite/sqlite3.c
scripts/package.sh "$version" "el$el-$(uname -m)" /dist
