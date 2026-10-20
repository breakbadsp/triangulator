#!/usr/bin/env bash
# Run this script as root in a disposable AlmaLinux container.
set -euo pipefail
case ${RUN_STATIC_TESTS:-1} in
    0|1) ;;
    *) echo "RUN_STATIC_TESTS must be 0 or 1." >&2; exit 2 ;;
esac
export RUN_STATIC_TESTS=${RUN_STATIC_TESTS:-1}
exec > >(tee /reports/setup.log) 2>&1

cat /etc/os-release
uname -a
rpm -qa | sort > /reports/base-packages.txt
for command in git make c++ python3 node getconf sed od; do
    command -v "$command" || true
done

# Git is a checkout dependency. Install it before the first build attempt.
dnf install -y git
# Older Git versions need these entries in the container global configuration.
git config --global --add safe.directory /source
git config --global --add safe.directory /source/.git
git clone --no-local /source /work
cd /work
git rev-parse HEAD > /reports/commit.txt
set +e
scripts/start.sh > /reports/first-start.log 2>&1
first_status=$?
set -e
printf '%s\n' "$first_status" > /reports/first-start.status
cat /reports/first-start.log
# A missing build tool must give a clear message and leave no local setup.
[[ "$first_status" != 0 ]]
grep -q 'required command not found' /reports/first-start.log
[[ ! -e "$HOME/triangulator" ]]

# Record the system compiler result before enabling a newer toolset.
dnf install -y dnf-plugins-core gcc-c++ make sqlite-devel
c++ --version > /reports/system-compiler.txt
set +e
make > /reports/system-build.log 2>&1
system_status=$?
set -e
printf '%s\n' "$system_status" > /reports/system-build.status
tail -n 30 /reports/system-build.log
# AlmaLinux 8 and 9 have older compilers. The error must name C++23.
if [[ "$ALMA_VERSION" == 8 || "$ALMA_VERSION" == 9 ]]; then
    [[ "$system_status" != 0 ]]
    grep -q 'cannot compile C++23' /reports/system-build.log
fi

# PowerTools on 8 and CRB on 9/10 supply static development packages.
if [[ "$ALMA_VERSION" == 8 ]]; then
    dnf config-manager --set-enabled powertools
else
    dnf config-manager --set-enabled crb
fi
# diffutils (cmp) is not installed by this script: the build must not need it.
dnf install -y glibc-static libstdc++-static shadow-utils util-linux
export CXX=c++
if [[ "$ALMA_VERSION" == 8 || "$ALMA_VERSION" == 9 ]]; then
    dnf module enable -y nodejs:22
    dnf install -y gcc-toolset-14-gcc-c++ gcc-toolset-14-libstdc++-devel python3.11 nodejs
    mkdir -p /opt/test/bin
    ln -s /usr/bin/python3.11 /opt/test/bin/python3
    export PATH="/opt/test/bin:$PATH"
    # Select the newer compiler from outside, without changing PATH or the Makefile.
    export CXX=/opt/rh/gcc-toolset-14/root/usr/bin/g++
else
    dnf install -y python3 nodejs
fi
# Some packages (the GCC toolset) pull in cmp. Hide it in this disposable
# container, so the build must work without it.
if cmp_path="$(command -v cmp)"; then mv "$cmp_path" "$cmp_path.disabled"; fi
if command -v cmp; then echo "cmp must be absent for this test" >&2; exit 1; fi
"$CXX" --version
python3 --version
node --version
rpm -qa | sort > /reports/build-packages.txt

source .github/scripts/compiler-cache.sh
useradd -m tester
if [[ -d /cache ]]; then chown -R tester:tester /cache; fi
chown -R tester:tester /work /reports
# Keep the toolchain environment, but use the unprivileged account's runtime.
runuser -u tester --preserve-environment -- env TRIANGULATOR_HOME=/home/tester/triangulator \
    bash .github/scripts/almalinux-user.sh
