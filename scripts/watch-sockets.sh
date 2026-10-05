#!/usr/bin/env bash
# Usage: scripts/watch-sockets.sh [options] <process-name|pid>
# Runs in the foreground; Ctrl+C stops observation and sends a final snapshot.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
usage() {
    echo "usage: $0 [--sudo] [--collector IP:PORT] [--marker BINARY SYMBOL] <process-name|pid>"
}
elevate=false
collector=""
marker=()
target=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --sudo) elevate=true; shift ;;
        --collector)
            [[ $# -ge 2 ]] || { usage >&2; exit 2; }
            collector="$2"; shift 2 ;;
        --marker)
            [[ $# -ge 3 ]] || { usage >&2; exit 2; }
            marker=("$2" "$3"); shift 3 ;;
        -h|--help) usage; exit 0 ;;
        -*) usage >&2; exit 2 ;;
        *)
            [[ -z "$target" ]] || { usage >&2; exit 2; }
            target="$1"; shift ;;
    esac
done
[[ -n "$target" ]] || { usage >&2; exit 2; }

control="$root/scripts/sampler_control.py"
pid="$(python3 "$control" resolve-pid "$target")"
# Default to the running sampler's collector, so both reach the same dashboard.
if [[ -z "$collector" ]]; then
    collector="$(python3 "$control" collector)"
fi
if [[ ${#marker[@]} -gt 0 ]]; then
    [[ -r "${marker[0]}" && -n "${marker[1]}" ]] || {
        echo "watch-sockets: --marker requires a readable ELF binary/library and a symbol" >&2
        exit 2
    }
    marker[0]="$(realpath -- "${marker[0]}")"
fi
[[ -r /sys/kernel/btf/vmlinux ]] || {
    echo "watch-sockets: kernel BTF is unavailable (/sys/kernel/btf/vmlinux)" >&2
    exit 1
}

# Compile as the invoking user; only the observer needs tracing privileges.
make -C "$root" socket-sampler
mkdir -p "$root/.run"
command=("$root/build/triangulator-socket-sampler" "$pid" "$collector" "$root/build/socket.bpf.o" "${marker[@]}")
if [[ "$elevate" == true ]]; then
    command=(sudo -- "${command[@]}")
fi
echo "Observing PID $pid; sending to $collector. Ctrl+C stops observation."
echo "Log: $root/.run/socket-sampler.log"
echo "Set the normal sampler to PID $pid with scripts/set-target.sh $pid."
echo "View the dashboard's Socket I/O & message processing panel."
if [[ ${#marker[@]} -eq 0 ]]; then
    echo "Message counts need --marker BINARY SYMBOL; socket bytes work without a marker."
fi
# Ctrl+C reaches the whole pipeline. tee -i ignores it and keeps copying
# until the observer exits, so shutdown output and errors are not lost.
"${command[@]}" 2>&1 | tee -ia "$root/.run/socket-sampler.log"
