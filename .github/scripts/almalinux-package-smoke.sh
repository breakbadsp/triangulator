#!/usr/bin/env bash
# Run as an unprivileged user in a clean AlmaLinux container with no compiler:
# unpack one package, start it from the extracted files and check that it runs.
# Usage: almalinux-package-smoke.sh <sampler|collector> <package.tar.gz>
set -euo pipefail

kind="$1"
tar -xzf "$2" -C "$HOME"
cd "$HOME/triangulator"
cat VERSION
# A package holds its own program only; the other must be absent.
case "$kind" in
    sampler) other=collector ;;
    collector) other=sampler ;;
    *) echo "unknown package kind: $kind" >&2; exit 2 ;;
esac
[[ -x "bin/triangulator-$kind" && ! -e "bin/triangulator-$other" ]]
scripts/start.sh
kill -0 "$(<"run/$kind.pid")"
if [[ "$kind" == collector ]]; then
    # Read the whole page first: grep -q would close the pipe and fail curl.
    page="$(curl -fsS http://127.0.0.1:9401/)"
    grep -qi '<html' <<<"$page"
fi
scripts/stop.sh
echo "The $kind package started from its own files."
