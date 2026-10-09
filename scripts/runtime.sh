#!/usr/bin/env bash
# Shared runtime paths. Source this after setting $root to the directory that
# holds scripts/ (a repository checkout, or the installed runtime directory).
# Sets: runtime_dir (TRIANGULATOR_HOME, default ~/triangulator), config_dir,
# run_dir (pidfiles), log_dir, bin_dir and template_dir (where the default
# configs come from: config/ in a checkout, templates/ once installed).
runtime_dir="$(realpath -m "${TRIANGULATOR_HOME:-$HOME/triangulator}")"
export TRIANGULATOR_HOME="$runtime_dir"
config_dir="$runtime_dir/config"
run_dir="$runtime_dir/run"
log_dir="$runtime_dir/logs"
bin_dir="$runtime_dir/bin"
template_dir="$root/config"
[[ -f "$root/Makefile" ]] || template_dir="$root/templates"

# The programs this tree can run: both in a checkout, and only the ones a
# package shipped once installed (the sampler host gets no collector).
programs=()
for program in sampler collector; do
    if [[ -f "$root/Makefile" || -x "$root/bin/triangulator-$program" ]]; then
        programs+=("$program")
    fi
done

# Copy the named program, its control scripts, and (from a checkout) the
# templates and service files into the runtime directory. Each file is copied
# to a temporary name and renamed, so a running program keeps its old image and
# a failed copy never leaves a half-written file. Without a Makefile we are
# already running from the runtime directory and the copies are skipped.
install_runtime_binary() {
    local app="$1" source="$root/build/triangulator-$1" destination="$bin_dir/triangulator-$1"
    [[ -x "$source" ]] || source="$root/bin/triangulator-$app"
    if [[ ! -x "$source" ]]; then
        echo "missing $source; run make (a package ships only its own program)" >&2
        return 1
    fi
    mkdir -p "$bin_dir" "$runtime_dir/scripts" "$runtime_dir/templates" "$runtime_dir/services"
    if [[ "$source" != "$destination" ]]; then
        cp -p "$source" "$destination.tmp.$$"
        mv -f "$destination.tmp.$$" "$destination"
    fi
    local script
    for script in runtime.sh start.sh stop.sh restart.sh watch-sockets.sh set-target.sh set-rate.sh sampler_control.py; do
        source="$root/scripts/$script"
        destination="$runtime_dir/scripts/$script"
        [[ "$source" != "$destination" && -e "$source" ]] || continue
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
