#!/usr/bin/env bash
# Install the same toolchain for prepared PR images and clean installation tests.
set -euo pipefail
dnf install -y git dnf-plugins-core gcc-c++ make sqlite-devel
# PowerTools on 8 and CRB on 9/10 supply static development packages.
if [[ "$ALMA_VERSION" == 8 ]]; then
    dnf config-manager --set-enabled powertools
else
    dnf config-manager --set-enabled crb
fi
# diffutils (cmp) is not installed by this script: the build must not need it.
dnf install -y glibc-static libstdc++-static shadow-utils util-linux
if [[ "$ALMA_VERSION" == 8 || "$ALMA_VERSION" == 9 ]]; then
    dnf module enable -y nodejs:22
    dnf install -y gcc-toolset-14-gcc-c++ gcc-toolset-14-libstdc++-devel python3.11 nodejs
    mkdir -p /opt/test/bin
    ln -s /usr/bin/python3.11 /opt/test/bin/python3
else
    dnf install -y python3 nodejs
fi
# Some packages (the GCC toolset) pull in cmp. Hide it in this disposable
# container, so the build must work without it.
if cmp_path="$(command -v cmp)"; then mv "$cmp_path" "$cmp_path.disabled"; fi
if command -v cmp; then echo "cmp must be absent for this test" >&2; exit 1; fi
dnf clean all
