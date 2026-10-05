#!/usr/bin/env python3
"""Shared code for set-target.sh, set-rate.sh and watch-sockets.sh.

Usage: sampler_control.py <set-target NAME|PID | set-rate HZ |
                           resolve-pid NAME|PID | collector>

set-target and set-rate edit the running sampler's config in place and send
SIGHUP. The new file is first checked by the running sampler binary itself
(`/proc/PID/exe --check-config`), so it is validated by the same parser that
reloads it. resolve-pid and collector print values for watch-sockets.sh.
"""

import fcntl
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
RESTART_HINT = "scripts/stop.sh sampler && scripts/start.sh"


class ControlError(Exception):
    pass


def parse_pid(text):
    """Return text as a PID, or None when it is not a decimal number."""
    if not (text.isascii() and text.isdecimal()):
        return None
    pid = int(text)
    if not 0 < pid <= 2**31 - 1:
        raise ControlError("PID must be a positive 32-bit integer")
    return pid


def require_process(pid):
    """Fail unless pid is a live process, not a thread ID or a zombie.

    /proc/TID exists for every thread too (readdir just doesn't list it), so
    only Tgid tells a process from one of its threads.
    """
    try:
        status = Path(f"/proc/{pid}/status").read_text()
    except FileNotFoundError:
        raise ControlError(f"no running process with PID {pid}") from None
    fields = dict(line.split(":", 1) for line in status.splitlines() if ":" in line)
    tgid = int(fields["Tgid"])
    if tgid != pid:
        raise ControlError(f"{pid} is a thread ID of process {tgid}; pass {tgid}")
    if fields["State"].split()[0] in ("Z", "X"):
        raise ControlError(f"process {pid} has exited")


def processes_named(name):
    """PIDs whose /proc/PID/comm equals name, matched like the sampler does."""
    wanted = os.fsencode(name)
    matches = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            comm = (entry / "comm").read_bytes()
        except OSError:
            continue
        if comm.removesuffix(b"\n") == wanted:
            matches.append(int(entry.name))
    return sorted(matches)


def check_name(name):
    if not 1 <= len(os.fsencode(name)) <= 15:
        raise ControlError("process name must contain 1..15 bytes")
    if any(character in name for character in '"\n\r\0'):
        raise ControlError("process name must not contain quotes or line breaks")


def unique_process_named(name):
    """The only process named name, or None when none is running.

    The sampler treats an ambiguous name as an absent target, so more than
    one match is an error.
    """
    check_name(name)
    matches = processes_named(name)
    if len(matches) > 1:
        raise ControlError(f"multiple processes named {name}; pass a PID from: {matches}")
    return matches[0] if matches else None


def resolve_pid(target):
    """The PID of target (a PID or an exact, unique process name)."""
    pid = parse_pid(target)
    if pid is not None:
        require_process(pid)
        return pid
    pid = unique_process_named(target)
    if pid is None:
        raise ControlError(f"no running process named {target}")
    return pid


def read_setting(text, key):
    """The value of key in a sampler config, read with the sampler's rules."""
    for line in text.split("\n"):
        quoted = False
        for index, character in enumerate(line):
            if character == '"':
                quoted = not quoted
            elif character == "#" and not quoted:
                line = line[:index]
                break
        name, separator, value = line.partition("=")
        if separator and name.strip(" \t\r\n") == key:
            value = value.strip(" \t\r\n")
            if len(value) >= 2 and value[0] == value[-1] == '"':
                value = value[1:-1]
            return value
    return None


def replace_setting(text, pattern, setting):
    """Replace the first line matching pattern with setting, in place.

    Other matching lines are removed (the sampler rejects duplicate keys and
    both target keys at once). Without a match, setting is appended.
    """
    output = []
    placed = False
    for line in text.splitlines(keepends=True):
        if not pattern.match(line):
            output.append(line)
        elif not placed:
            output.append(setting + line[len(line.rstrip("\r\n")):])
            placed = True
    if not placed:
        if output and not output[-1].endswith("\n"):
            output[-1] += "\n"
        output.append(setting + "\n")
    return "".join(output)


def running_sampler(root):
    """(pid, config path), or None if the sampler is absent or stopped.

    Inspection errors propagate so callers cannot mistake them for absence.
    """
    pidfile = root / ".run/sampler.pid"
    try:
        pid_text = pidfile.read_text().strip()
    except FileNotFoundError:
        return None
    pid = parse_pid(pid_text)
    if pid is None:
        raise ControlError(f"invalid {pidfile}; restart the sampler with {RESTART_HINT}")
    proc = Path(f"/proc/{pid}")
    try:
        executable = os.readlink(proc / "exe").removesuffix(" (deleted)")
    except FileNotFoundError:
        return None
    except PermissionError:
        raise ControlError(f"cannot inspect sampler PID {pid}; run this as the sampler's user") from None
    # The kernel reports a fully resolved path; resolve ours too, so a repo
    # reached through a symlink still matches.
    if Path(executable) != (root / "build/triangulator-sampler").resolve():
        raise ControlError(f"{pidfile} points to {executable}, not this repo's sampler; refusing to signal it")
    args = (proc / "cmdline").read_bytes().split(b"\0")
    if len(args) != 3 or args[-1] != b"":
        raise ControlError("cannot determine the running sampler's config path")
    config = Path(os.fsdecode(args[1]))
    if not config.is_absolute():
        config = proc / "cwd" / config
    return pid, config.resolve(strict=True)


def update_config(root, pattern, setting):
    """Write setting into the running sampler's config and request a reload."""
    (root / ".run").mkdir(exist_ok=True)
    # Serialise concurrent runs, so one edit can't overwrite another.
    with open(root / ".run/sampler-control.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        sampler = running_sampler(root)
        if sampler is None:
            raise ControlError("the sampler is not running; start it with scripts/start.sh")
        pid, config = sampler
        examples = (root / "config").resolve()
        if config.is_relative_to(examples) and not config.is_relative_to(examples / "local"):
            raise ControlError(
                f"the sampler is using {config}, a tracked example file; refusing to edit it. "
                f"Restart it with config/local/sampler.toml: {RESTART_HINT}")
        updated = replace_setting(config.read_text(), pattern, setting)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                    mode="w", dir=config.parent, prefix=f".{config.name}.", delete=False) as output:
                temporary = Path(output.name)
                os.fchmod(output.fileno(), config.stat().st_mode & 0o777)
                output.write(updated)
            # The running binary checks the file, even if build/ was rebuilt since.
            checked = subprocess.run([f"/proc/{pid}/exe", "--check-config", str(temporary)],
                                     capture_output=True, text=True, timeout=10)
            if checked.returncode != 0:
                raise ControlError(f"sampler config validation failed: {checked.stderr.strip()}; "
                                   f"{config} is unchanged")
            os.replace(temporary, config)
            temporary = None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError as error:
            raise ControlError(f"updated {config}, but reload failed: {error}; restart the sampler") from error
        return pid, config


def set_target(root, target):
    running = True
    pid = parse_pid(target)
    if pid is not None:
        require_process(pid)
        setting = f"target_pid = {pid}"
    else:
        running = unique_process_named(target) is not None
        setting = f'target_process = "{target}"'
    sampler, config = update_config(root, re.compile(r"\s*target_(?:process|pid)\s*="), setting)
    print(f"Updated {config}: {setting}")
    print(f"Requested reload of sampler {sampler}; check the dashboard and .run/sampler.log.")
    if not running:
        print(f"No process named {target} is running yet; the dashboard shows the target as absent until one starts.")


def set_rate(root, text):
    try:
        rate = float(text)
    except ValueError:
        rate = math.nan
    if not math.isfinite(rate) or not 0.2 <= rate <= 10:
        raise ControlError("sampling frequency must be a number between 0.2 and 10 Hz")
    setting = f"rate_hz = {rate}"
    sampler, config = update_config(root, re.compile(r"\s*rate_hz\s*="), setting)
    print(f"Updated {config}: {setting} ({1000 / rate:g} ms between thread samples)")
    print(f"Requested reload of sampler {sampler}; a successful reload starts a new session.")
    print("Socket observation still reports once per second.")


def collector(root):
    """Use config/local only when the sampler is absent or stopped."""
    try:
        sampler = running_sampler(root)
        config = sampler[1] if sampler is not None else root / "config/local/sampler.toml"
        endpoint = read_setting(config.read_text(), "collector")
    except (ControlError, OSError) as error:
        raise ControlError(f"cannot read the collector endpoint: {error}; pass --collector IP:PORT") from None
    if not endpoint:
        raise ControlError(f"no collector in {config}; pass --collector IP:PORT")
    print(f"Collector {endpoint} from {config}", file=sys.stderr)
    print(endpoint)


def main(argv):
    commands = {
        "set-target": lambda target: set_target(ROOT, target),
        "set-rate": lambda rate: set_rate(ROOT, rate),
        "resolve-pid": lambda target: print(resolve_pid(target)),
        "collector": lambda: collector(ROOT),
    }
    name = argv[1] if len(argv) > 1 else ""
    if name not in commands or len(argv) != (2 if name == "collector" else 3):
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    prefix = "watch-sockets" if name in ("resolve-pid", "collector") else name
    try:
        commands[name](*argv[2:])
    except (ControlError, OSError, subprocess.TimeoutExpired) as error:
        print(f"{prefix}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
