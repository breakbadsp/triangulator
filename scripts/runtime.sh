#!/usr/bin/env bash
# Shared runtime paths. Source this after setting the repository root.
runtime_dir="$(realpath -m "${TRIANGULATOR_HOME:-$HOME/triangulator}")"
export TRIANGULATOR_HOME="$runtime_dir"
config_dir="$runtime_dir/config"
run_dir="$runtime_dir/run"
log_dir="$runtime_dir/logs"
bin_dir="$runtime_dir/bin"
template_dir="$root/config"
[[ -f "$root/Makefile" ]] || template_dir="$root/templates"

# Replace binaries atomically so running programs keep their current image.
install_runtime_binary() {
    local app="$1" source="$root/build/triangulator-$1" destination="$bin_dir/triangulator-$1"
    [[ -x "$source" ]] || source="$root/bin/triangulator-$app"
    [[ -x "$source" ]] || { echo "missing $source; run make" >&2; return 1; }
    mkdir -p "$bin_dir" "$runtime_dir/scripts" "$runtime_dir/templates" "$runtime_dir/services"
    if [[ "$source" != "$destination" ]]; then
        cp -p "$source" "$destination.tmp.$$"
        mv -f "$destination.tmp.$$" "$destination"
    fi
    local script
    for script in runtime.sh start.sh stop.sh restart.sh watch-sockets.sh set-target.sh set-rate.sh sampler_control.py; do
        source="$root/scripts/$script"
        destination="$runtime_dir/scripts/$script"
        [[ "$source" != "$destination" ]] || continue
        cp -p "$source" "$destination.tmp.$$"
        mv -f "$destination.tmp.$$" "$destination"
    done
    if [[ -f "$root/Makefile" ]]; then
        cp -p "$root/config/sampler.toml" "$root/config/collector.toml" "$runtime_dir/templates/"
        cp -p "$root/deploy/triangulator-sampler.service" "$root/deploy/triangulator-collector.service" "$runtime_dir/services/"
    fi
    if [[ "$app" == collector && -x "$root/build/triangulator-socket-report" ]]; then
        cp -p "$root/build/triangulator-socket-report" "$bin_dir/triangulator-socket-report.tmp.$$"
        mv -f "$bin_dir/triangulator-socket-report.tmp.$$" "$bin_dir/triangulator-socket-report"
    fi
}
