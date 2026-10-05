#!/usr/bin/env bash
# Usage: scripts/set-target.sh <process-name|pid>
# Edits the running sampler's config in place and sends SIGHUP to reload it.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ $# -ne 1 ]]; then
    echo "usage: $0 <process-name|pid>" >&2
    exit 2
fi
exec python3 "$root/scripts/sampler_control.py" set-target "$1"
