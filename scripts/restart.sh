#!/usr/bin/env bash
# Usage: scripts/restart.sh (rebuild and restart the collector)
# Optional: scripts/restart.sh <collector|sampler|all> [config.toml]
# Rebuilds first, so code and dashboard.html changes are picked up. Reuses the
# config the running program was started with unless one is given. The old
# program keeps running if the build or the collector config check fails.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/runtime.sh"
app="${1:-collector}"

case "$app" in
    all)
        [[ $# -le 1 ]] || { echo "usage: $0 all (no config: each program keeps its own)" >&2; exit 2; }
        "$root/scripts/restart.sh" collector
        "$root/scripts/restart.sh" sampler
        exit 0
        ;;
    sampler|collector) ;;
    *) echo "usage: $0 [<collector|sampler|all> [config.toml]]" >&2; exit 2 ;;
esac

bin="$bin_dir/triangulator-$app"
source_bin="$root/build/triangulator-$app"
[[ -f "$root/Makefile" ]] || source_bin="$bin"
user_id="$(id -u)"

# PIDs of this checkout's build of $app run by this user. The pidfile can be
# missing (deleted, or started by hand), so look at what is actually running.
running_pids() {
    local process pid exe owner
    for process in /proc/[0-9]*; do
        pid="${process##*/}"
        owner="$(stat -c %u "$process" 2>/dev/null)" || continue
        [[ "$owner" == "$user_id" ]] || continue
        # After a rebuild the running binary shows as "<path> (deleted)".
        exe="$(readlink "/proc/$pid/exe" 2>/dev/null)" || continue
        [[ "${exe% (deleted)}" == "$bin" || "${exe% (deleted)}" == "$source_bin" ]] && echo "$pid"
    done
}

# The config path a running program was started with ("<binary>\0<config>\0").
config_of() {
    local config
    config="$(tr '\0' '\n' <"/proc/$1/cmdline" | sed -n 2p)"
    [[ -n "$config" ]] || return 1
    [[ "$config" == /* ]] || config="$(readlink -f "/proc/$1/cwd")/$config"
    realpath "$config"
}

mapfile -t pids < <(running_pids)
pidfile="$run_dir/$app.pid"
pid=""
if [[ $# -ge 2 ]]; then
    config="$(realpath "$2")"
    for candidate in "${pids[@]}"; do
        [[ "$(config_of "$candidate")" == "$config" ]] && pid="$candidate"
    done
else
    if [[ -f "$pidfile" ]] && printf '%s\n' "${pids[@]}" | grep -qx "$(<"$pidfile")"; then
        pid="$(<"$pidfile")"
    elif [[ ${#pids[@]} -eq 1 ]]; then
        pid="${pids[0]}"
    elif [[ ${#pids[@]} -gt 1 ]]; then
        echo "several $app processes are running (${pids[*]}); pass the config to restart one:" >&2
        for candidate in "${pids[@]}"; do echo "  $0 $app $(config_of "$candidate")" >&2; done
        exit 1
    fi
    config=""
    [[ -n "$pid" ]] && config="$(config_of "$pid" || true)"
    config="${config:-$config_dir/$app.toml}"
fi
[[ -f "$config" ]] || { echo "config not found: $config (run scripts/start.sh first)" >&2; exit 1; }

# The same program with the same config run by another user (e.g. via sudo).
# We cannot stop it, and a new copy could not bind its ports, so say so before
# changing anything. Its /proc/PID/exe is unreadable, but the command line is
# public. A relative config path cannot be resolved, so it counts as a match.
foreign=""
for process in /proc/[0-9]*; do
    candidate="${process##*/}"
    owner="$(stat -c %u "$process" 2>/dev/null)" || continue
    [[ "$owner" == "$user_id" ]] && continue
    [[ -r "$process/cmdline" ]] || continue
    mapfile -t args < <(tr '\0' '\n' <"/proc/$candidate/cmdline")
    [[ "${args[0]:-}" == "$bin" || "${args[0]:-}" == "$source_bin" ]] || continue
    [[ "${args[1]:-}" == /* && "$(realpath -m "${args[1]}")" != "$config" ]] && continue
    foreign+=" $candidate"
done
if [[ -n "$foreign" ]]; then
    echo "$app is running as another user with this config (PIDs:${foreign}); stop it first, e.g. sudo kill${foreign}," >&2
    echo "then run $0 again as $(id -un) to restart it without extra privileges." >&2
    exit 1
fi

[[ ! -f "$root/Makefile" ]] || make -C "$root" --no-print-directory "build/triangulator-$app"
if [[ "$app" == collector ]]; then
    "$source_bin" "$config" --check-config
else
    "$source_bin" --check-config "$config"
fi

# stop.sh stops whatever the pidfile names; point it at the process found.
# start.sh then records the new process there. If the pidfile named another
# running instance (e.g. the main one, while restarting a test copy), put
# it back afterwards so stop.sh and set-target.sh keep finding that one.
other=""
if [[ -f "$pidfile" ]]; then
    other="$(<"$pidfile")"
    if [[ "$other" == "$pid" ]] || ! printf '%s\n' "${pids[@]}" | grep -qx "$other"; then
        other=""
    fi
fi
if [[ -n "$pid" ]]; then
    mkdir -p "$run_dir"
    echo "$pid" >"$pidfile"
    "$root/scripts/stop.sh" "$app"
else
    echo "$app was not running; starting it"
    rm -f "$pidfile"
fi
"$root/scripts/start.sh" "$app" "$config"
if [[ -n "$other" ]]; then
    echo "$other" >"$pidfile"
fi

if [[ "$app" == collector ]] && command -v curl >/dev/null; then
    host="$(sed -n 's/^[[:space:]]*http_host[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$config" | head -n 1)"
    port="$(sed -n 's/^[[:space:]]*http_port[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p' "$config" | head -n 1)"
    host="${host:-127.0.0.1}"
    [[ "$host" == 0.0.0.0 || "$host" == "::" ]] && host=127.0.0.1
    [[ "$host" == *:* ]] && host="[$host]"
    url="http://$host:${port:-9401}/"
    for _ in {1..50}; do
        if curl -fsS -o /dev/null --max-time 1 "${url}api/live"; then
            echo "Dashboard ready at $url (reload open tabs to load a changed page)"
            exit 0
        fi
        sleep 0.1
    done
    echo "collector started, but $url did not answer within 5 s; see $log_dir/collector.log" >&2
    exit 1
fi
