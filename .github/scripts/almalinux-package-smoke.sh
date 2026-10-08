#!/usr/bin/env bash
# Run as an unprivileged user in a clean AlmaLinux container with no compiler:
# unpack the package, start it from the extracted files and fetch the dashboard.
# Usage: almalinux-package-smoke.sh <package.tar.gz>
set -euo pipefail

tar -xzf "$1" -C "$HOME"
cd "$HOME/triangulator"
cat VERSION
scripts/start.sh
# Read the whole page first: grep -q would close the pipe and fail curl.
page="$(curl -fsS http://127.0.0.1:9401/)"
grep -qi '<html' <<<"$page"
scripts/stop.sh
echo "Package started and served the dashboard."
