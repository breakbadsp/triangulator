#!/usr/bin/env bash
# Usage: scripts/package.sh <version> <label> [output-dir]
# Packs the static release binaries (from "make release") with the control
# scripts, config templates and systemd units into
# <output-dir>/triangulator-<version>-<label>.tar.gz plus a .sha256 file.
# The archive's top directory is triangulator/, so extracting it in $HOME gives
# the default runtime directory ~/triangulator.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ $# -lt 2 || $# -gt 3 ]]; then
    echo "usage: $0 <version> <label> [output-dir]" >&2
    exit 2
fi
version="$1" label="$2" out="$(realpath -m "${3:-$root/dist}")"
name="triangulator-$version-$label"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
package="$stage/triangulator"
mkdir -p "$package"/{bin,scripts,templates,services} "$out"

for program in sampler collector socket-report; do
    binary="$root/build/triangulator-$program"
    [[ -x "$binary" ]] || { echo "missing $binary; run make release first" >&2; exit 1; }
    cp -p "$binary" "$package/bin/"
done
# The same file list that runtime.sh installs, so a package can reinstall itself.
for script in runtime.sh start.sh stop.sh restart.sh watch-sockets.sh set-target.sh set-rate.sh sampler_control.py; do
    cp -p "$root/scripts/$script" "$package/scripts/"
done
cp -p "$root/config/sampler.toml" "$root/config/collector.toml" "$package/templates/"
cp -p "$root/deploy/triangulator-sampler.service" "$root/deploy/triangulator-collector.service" "$package/services/"
printf '%s\n' "$version" >"$package/VERSION"

# Fixed owner and file order, so the same inputs give the same archive.
tar --owner=0 --group=0 --numeric-owner --sort=name -C "$stage" -czf "$out/$name.tar.gz" triangulator
(cd "$out" && sha256sum "$name.tar.gz" >"$name.tar.gz.sha256")
echo "$out/$name.tar.gz"
