#!/usr/bin/env bash
# Use one official Node build on all supported AlmaLinux versions.
set -euo pipefail
version=24.22.1
sha256=eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c
archive="node-v$version-linux-x64.tar.gz"
[[ "$(uname -m)" == x86_64 ]] || { echo "Node installer requires x86_64" >&2; exit 1; }
temporary="$(mktemp -d)"
trap 'rm -rf "$temporary"' EXIT
curl --fail --silent --show-error --location "https://nodejs.org/dist/v$version/$archive" -o "$temporary/$archive"
printf '%s  %s\n' "$sha256" "$temporary/$archive" | sha256sum --check -
tar -xzf "$temporary/$archive" --strip-components=1 -C /usr/local
node --version
npm --version
