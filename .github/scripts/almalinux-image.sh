#!/usr/bin/env bash
# Print the image name on stdout. Keep build output on stderr.
set -euo pipefail
cd "$(dirname "$0")"
version="${ALMA_VERSION:?set ALMA_VERSION}"
if [[ ${LEAN_PR:-0} != 1 ]]; then
    image="almalinux:$version"
    docker pull "$image" >&2
else
    digest="$(cat almalinux-ci.Dockerfile almalinux-toolchain.sh | sha256sum)"
    image="localhost/triangulator-ci:alma$version-${digest:0:20}"
    # Runner slots share the rootless image store. Build a missing image once.
    lock_dir="${XDG_CACHE_HOME:-$HOME/.cache}/triangulator"
    mkdir -p "$lock_dir"
    exec 9> "$lock_dir/alma$version-image.lock"
    flock 9
    if docker image inspect "$image" > /dev/null 2>&1; then
        echo "Reuse prepared image: $image" >&2
    else
        docker build --build-arg "ALMA_VERSION=$version" \
            -f almalinux-ci.Dockerfile -t "$image" . >&2
    fi
fi
printf '%s\n' "$image"
