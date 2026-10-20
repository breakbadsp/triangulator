#!/usr/bin/env bash
# Edit the local sampler configuration and request SIGHUP.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ $# -eq 1 && ( $1 == --help || $1 == -h ) ]]; then
    echo "usage: $0 [ID] <process-name|pid> | --add ID <process-name|pid> | --remove ID"
    exit 0
elif [[ $# -eq 3 && $1 == --add ]]; then
    exec python3 "$root/scripts/sampler_control.py" add-target "$2" "$3"
elif [[ $# -eq 2 && $1 == --remove ]]; then
    exec python3 "$root/scripts/sampler_control.py" remove-target "$2"
elif [[ $# -eq 2 ]]; then
    exec python3 "$root/scripts/sampler_control.py" set-target-id "$1" "$2"
elif [[ $# -eq 1 ]]; then
    exec python3 "$root/scripts/sampler_control.py" set-target "$1"
fi
echo "usage: $0 [ID] <process-name|pid> | --add ID <process-name|pid> | --remove ID" >&2
exit 2
