#!/usr/bin/env bash
# Usage: scripts/start.sh (build and start both with ~/triangulator/config/*.toml)
# Optional: scripts/start.sh <sampler|collector> [config.toml]
# The collector (build/triangulator-collector) does no alerting.
# Both run as the invoking user with no extra privileges; run the sampler as the
# target process's user so its per-thread /proc files are readable.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/scripts/runtime.sh"
collector_bin="$bin_dir/triangulator-collector"

if [[ $# -eq 0 ]]; then
    cd "$root"
    # Check the build tools first, so a missing one leaves no half-made setup.
    missing=()
    tools=(sed getconf)
    [[ ! -f "$root/Makefile" ]] || tools+=(make "${CXX:-c++}")
    for tool in "${tools[@]}"; do
        command -v "$tool" >/dev/null || missing+=("$tool")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "required command not found: ${missing[*]}" >&2
        echo "Install the build tools (see README, Requirements and build), then run this script again." >&2
        exit 1
    fi
    mkdir -p "$config_dir" "$run_dir" "$log_dir" "$runtime_dir/data"
    for app in sampler collector; do
        config="$config_dir/$app.toml"
        [[ -e "$config" ]] && continue
        if [[ "$app" == sampler ]]; then
            sed 's/collector = "10.0.0.5:9400"/collector = "127.0.0.1:9400"/' \
                "$template_dir/sampler.toml" >"$config.tmp"
        else
            clock_ticks="$(getconf CLK_TCK)"
            sed \
                -e 's/udp_host = "0.0.0.0"/udp_host = "127.0.0.1"/' \
                -e 's/sampler_ip = "10.0.0.10"/sampler_ip = "127.0.0.1"/' \
                -e 's|^data_dir = .*|data_dir = "./data"|' \
                -e "s/clock_ticks = 100/clock_ticks = $clock_ticks/" \
                -e 's|^webhook_url = "https://your-alert-service.example/triangulator"|# &|' \
                "$template_dir/collector.toml" >"$config.tmp"
        fi
        # Move into place only after sed succeeded, so a failure leaves no
        # partial file that the next run would treat as existing.
        mv -n "$config.tmp" "$config"
        echo "Created $config"
    done
    echo "Set target_process (or target_pid) in $config_dir/sampler.toml to select the process to monitor."
    [[ ! -f "$root/Makefile" ]] || make -C "$root"
    install_runtime_binary collector
    install_runtime_binary sampler
    "$collector_bin" "$config_dir/collector.toml" --check-config

    collector_was_running=false
    if [[ -f "$run_dir/collector.pid" ]] && kill -0 "$(<"$run_dir/collector.pid")" 2>/dev/null; then
        collector_was_running=true
    fi
    "$root/scripts/start.sh" collector "$config_dir/collector.toml"
    if ! "$root/scripts/start.sh" sampler "$config_dir/sampler.toml"; then
        if [[ "$collector_was_running" == false ]]; then
            "$root/scripts/stop.sh" collector
        fi
        exit 1
    fi
    echo "Dashboard address is configured by http_host and http_port in $config_dir/collector.toml (default: http://127.0.0.1:9401)."
    exit 0
fi

app="${1:-}"
config="${2:-$config_dir/$app.toml}"

case "$app" in
    sampler|collector) ;;
    *) echo "usage: $0 [<sampler|collector> [config.toml]]" >&2; exit 2 ;;
esac
[[ -f "$config" ]] || { echo "config not found: $config" >&2; exit 1; }
config="$(realpath "$config")"

mkdir -p "$run_dir" "$log_dir"
pidfile="$run_dir/$app.pid"
log="$log_dir/$app.log"

if [[ -f "$pidfile" ]] && kill -0 "$(<"$pidfile")" 2>/dev/null; then
    echo "$app already running (pid $(<"$pidfile"))" >&2
    exit 0
fi

install_runtime_binary "$app"
bin="$bin_dir/triangulator-$app"
if [[ "$app" == sampler ]]; then
    "$bin" --check-config "$config"
else
    "$bin" "$config" --check-config
fi
# Relative data paths are inside the runtime directory.
cd "$runtime_dir"
nohup "$bin" "$config" >>"$log" 2>&1 &
echo $! >"$pidfile"

sleep 0.5
if kill -0 "$(<"$pidfile")" 2>/dev/null; then
    echo "$app started (pid $(<"$pidfile")), log: $log"
else
    echo "$app failed to start; see $log" >&2
    rm -f "$pidfile"
    exit 1
fi
