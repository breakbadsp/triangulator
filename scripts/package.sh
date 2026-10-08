#!/usr/bin/env bash
# Usage: scripts/package.sh <version> <label> [output-dir]
# Packs the static release binaries (from "make release") into two archives,
# so the sampler can go on a monitored host without the collector, dashboard or
# report helper:
#   triangulator-sampler-<version>-<label>.tar.gz
#   triangulator-collector-<version>-<label>.tar.gz
# Each has a .sha256 file and the control scripts. The top directory is
# triangulator/, so extracting in $HOME gives the default runtime directory
# ~/triangulator; extracting both there on one machine gives a full install.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -lt 2 || $# -gt 3 ]]; then
    echo "usage: $0 <version> <label> [output-dir]" >&2
    exit 2
fi
version="$1" label="$2" out="$(realpath -m "${3:-$root/dist}")"
mkdir -p "$out"

# pack <sampler|collector> <binary>...: build one archive.
pack() {
    local kind="$1"
    shift
    local name="triangulator-$kind-$version-$label"
    local stage package binary script
    stage="$(mktemp -d)"
    package="$stage/triangulator"
    mkdir -p "$package"/{bin,scripts,templates,services}
    for binary in "$@"; do
        [[ -x "$root/build/$binary" ]] || { echo "missing build/$binary; run make release first" >&2; rm -rf "$stage"; return 1; }
        cp -p "$root/build/$binary" "$package/bin/"
    done
    # Control scripts are shared. watch-sockets.sh is left out: it needs the
    # privileged socket observer, which no package ships.
    for script in runtime.sh start.sh stop.sh restart.sh set-target.sh set-rate.sh sampler_control.py; do
        cp -p "$root/scripts/$script" "$package/scripts/"
    done
    cp -p "$root/config/$kind.toml" "$package/templates/"
    cp -p "$root/deploy/triangulator-$kind.service" "$package/services/"
    printf '%s\n' "$version" >"$package/VERSION"
    # Fixed owner and file order, so the same inputs give the same archive.
    tar --owner=0 --group=0 --numeric-owner --sort=name -C "$stage" -czf "$out/$name.tar.gz" triangulator
    (cd "$out" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
    rm -rf "$stage"
    echo "$out/$name.tar.gz"
}

pack sampler triangulator-sampler
pack collector triangulator-collector triangulator-socket-report
