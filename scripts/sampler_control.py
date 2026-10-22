#!/usr/bin/env python3
"""Shared code for set-target.sh, set-rate.sh and watch-sockets.sh.

Usage: sampler_control.py <set-target NAME|PID | set-target-id ID NAME|PID |
                           add-target ID NAME|PID | remove-target ID |
                           set-rate HZ | resolve-pid NAME|PID | collector>

set-target and set-rate edit the running sampler's config in place and send
SIGHUP. The new file is first checked by the running sampler binary itself
(`/proc/PID/exe --check-config`), so it is validated by the same parser that
reloads it. resolve-pid and collector print values for watch-sockets.sh.
"""

import fcntl
import ipaddress
import json
import math
import os
from pathlib import Path
import pwd
import re
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
RESTART_HINT = "scripts/stop.sh sampler && scripts/start.sh"


class ControlError(Exception):
    pass


class AmbiguousNameError(ControlError):
    """More than one process has the name. The dashboard offers the candidates."""

    def __init__(self, name, pids):
        super().__init__(f"multiple processes named {name}; pass a PID from: {pids}")
        self.candidates = [process_summary(pid) for pid in pids[:20]]
        self.total = len(pids)


class TargetLimitError(ControlError):
    """The collector has no free target slot for one more target."""

    def __init__(self, max_targets):
        super().__init__(f"The collector is at its limit of {max_targets} targets. Remove a target, "
                         "or raise max_targets in the collector configuration, then add this one.")


def runtime_directory():
    """All user runtime files share this directory."""
    return Path(os.environ.get("TRIANGULATOR_HOME") or Path.home() / "triangulator").resolve()


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


def process_summary(pid):
    """PID, user, start time (Unix seconds), and command line of a process.

    A field that cannot be read, for example after the process exits, is None.
    """
    proc = Path(f"/proc/{pid}")
    summary = {"pid": pid, "user": None, "started_at": None, "command": None}
    try:
        summary["user"] = pwd.getpwuid(proc.stat().st_uid).pw_name
    except (OSError, KeyError):
        pass
    try:
        command = (proc / "cmdline").read_bytes().replace(b"\0", b" ").strip()
        summary["command"] = os.fsdecode(command)[:200] or None
    except OSError:
        pass
    try:
        # Field 22 of /proc/PID/stat is the start time in clock ticks after boot.
        ticks = int((proc / "stat").read_text().rsplit(")", 1)[1].split()[19])
        boot = next(int(line.split()[1]) for line in Path("/proc/stat").read_text().splitlines()
                    if line.startswith("btime "))
        summary["started_at"] = boot + ticks / os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, IndexError, StopIteration):
        pass
    return summary


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
        raise AmbiguousNameError(name, matches)
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
    table = TARGET_TABLE.search(text)
    if table is not None:
        return replace_setting(text[:table.start()], pattern, setting) + text[table.start():]
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
    pidfile = runtime_directory() / "run/sampler.pid"
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
    binaries = ((root / "build/triangulator-sampler").resolve(),
                runtime_directory() / "bin/triangulator-sampler")
    if Path(executable) not in binaries:
        raise ControlError(f"{pidfile} points to {executable}, not this repo's sampler; refusing to signal it")
    args = (proc / "cmdline").read_bytes().split(b"\0")
    if len(args) != 3 or args[-1] != b"":
        raise ControlError("cannot determine the running sampler's config path")
    config = Path(os.fsdecode(args[1]))
    if not config.is_absolute():
        config = proc / "cwd" / config
    return pid, config.resolve(strict=True)


def update_config(root, pattern, setting, collector_endpoint=None, transform=None):
    """Write setting into the running sampler's config and request a reload."""
    run_dir = runtime_directory() / "run"
    run_dir.mkdir(parents=True, exist_ok=True)
    # Serialise concurrent runs, so one edit can't overwrite another.
    with open(run_dir / "sampler-control.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        sampler = running_sampler(root)
        if sampler is None:
            raise ControlError("the sampler is not running; start it with scripts/start.sh")
        pid, config = sampler
        if collector_endpoint is not None:
            require_local_collector(config, collector_endpoint)
        examples = (root / "config").resolve()
        # Only a checkout (it has build/) has tracked example configs to protect.
        if (root / "build").is_dir() and config.is_relative_to(examples) and \
                not config.is_relative_to(examples / "local"):
            raise ControlError(
                f"the sampler is using {config}, a tracked example file; refusing to edit it. "
                f"Restart it with {runtime_directory() / 'config/sampler.toml'}: {RESTART_HINT}")
        original = config.read_text()
        updated = transform(original) if transform else replace_setting(original, pattern, setting)
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


def set_target(root, target, collector_endpoint=None, target_id=None):
    running = True
    pid = parse_pid(target)
    if pid is not None:
        require_process(pid)
        setting = f"target_pid = {pid}"
    else:
        running = unique_process_named(target) is not None
        setting = f'target_process = "{target}"'
    pattern = re.compile(r"\s*target_(?:process|pid)\s*=")
    selected = str(pid) if pid is not None else target
    # The setting that was written, for the success message.
    written = setting

    def transform(text):
        nonlocal written
        if TARGET_TABLE.search(text) is None:
            if target_id not in (None, "default"):
                raise ControlError("this target id is not configured; use --add ID NAME|PID")
            return replace_setting(text, pattern, setting)
        targets = configured_targets(text)
        wanted = target_id or next((item["id"] for item in targets if item["id"] == "default"),
                                   targets[0]["id"] if len(targets) == 1 else None)
        existing = next((item for item in targets if item["id"] == wanted), None)
        if existing is None:
            raise ControlError("specify a configured target ID; use --add ID NAME|PID to add one")
        existing["target"] = selected
        selector = f"pid = {pid}" if pid is not None else f'process = "{target}"'
        written = f'[[target]] id = "{wanted}", {selector}'
        return replace_targets(text, targets)

    sampler, config = update_config(root, pattern, setting, collector_endpoint, transform=transform)
    message = "Reload requested. The dashboard will update when the sampler reports."
    if not running:
        message = f"Waiting for a process named {target} to start."
    if collector_endpoint is not None:
        return {"enabled": True, "target": target, "message": message}
    print(f"Updated {config}: {written}")
    print(f"Requested reload of sampler {sampler}; check the dashboard and "
          f"{runtime_directory() / 'logs/sampler.log'}.")
    if not running:
        print(f"No process named {target} is running yet; the dashboard shows the target as absent until one starts.")


def require_local_collector(config, expected):
    """The dashboard must control only a sampler sending to this collector."""
    endpoint = read_setting(config.read_text(), "collector") or ""
    host, separator, configured_port = endpoint.rpartition(":")
    try:
        address = ipaddress.ip_address(host.strip("[]"))
        bind_host, port = expected
        listener = ipaddress.ip_address(bind_host)
        # The collector's IPv6 wildcard socket also receives IPv4 datagrams.
        local = address.is_loopback and (address.version == listener.version or
                                         (listener.version == 6 and listener.is_unspecified))
        local = local and (listener.is_unspecified or address == listener)
        matching_port = int(configured_port) == int(port)
    except ValueError:
        local = matching_port = False
    if not separator or not local or not matching_port:
        raise ControlError("the local sampler sends to a different collector; use scripts/set-target.sh on its host")


def dashboard_target(root, host, port, target=None):
    """JSON interface for the local dashboard; reuse the CLI's validated edit."""
    try:
        if target is not None:
            result = set_target(root, target, (host, port))
        else:
            sampler = running_sampler(root)
            if sampler is None:
                raise ControlError("the sampler is not running; start it with scripts/start.sh")
            config = sampler[1]
            require_local_collector(config, (host, port))
            text = config.read_text()
            targets = configured_targets(text)
            selected = next((target for target in targets if target["id"] == "default"),
                            targets[0] if len(targets) == 1 else None)
            if selected is None:
                raise ControlError("use Manage targets for this multi-target sampler")
            result = {"enabled": True, "target": selected["target"]}
    except (ControlError, OSError, subprocess.TimeoutExpired) as error:
        result = {"enabled": True, "error": str(error)}
    print(json.dumps(result))


TARGET_TABLE = re.compile(r"(?m)^[ \t]*\[\[target\]\][ \t\r]*(?:#[^\n]*)?$" )


def configured_targets(text):
    """Read the sampler's small configuration syntax without changing escapes."""
    parts = TARGET_TABLE.split(text)
    if len(parts) == 1:
        pid = read_setting(text, "target_pid")
        name = read_setting(text, "target_process")
        return [{"id": "default", "target": pid or name}] if pid or name else []
    return [{"id": read_setting(part, "id"),
             "target": read_setting(part, "pid") or read_setting(part, "process")}
            for part in parts[1:]]


def replace_targets(text, targets):
    prefix = TARGET_TABLE.split(text, maxsplit=1)[0]
    prefix = "".join(line for line in prefix.splitlines(keepends=True)
                     if not re.match(r"\s*target_(?:pid|process)\s*=", line))
    output = prefix.rstrip() + "\n\n"
    for target in targets:
        selected = target["target"]
        pid = parse_pid(selected)
        selector = f"pid = {pid}" if pid is not None else f'process = "{selected}"'
        output += f'[[target]]\nid = "{target["id"]}"\n{selector}\n\n'
    return output


def change_target_set(text, change, max_targets=None):
    if not isinstance(change, dict) or set(change) - {"action", "id", "target"}:
        raise ControlError("expected an action, target id, and selector")
    action, target_id = change.get("action"), change.get("id")
    if not isinstance(target_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,31}", target_id) or target_id in (".", ".."):
        raise ControlError("target id must contain 1..31 letters, digits, dots, underscores, or hyphens")
    targets = configured_targets(text)
    existing = next((target for target in targets if target["id"] == target_id), None)
    if action == "add":
        if existing is not None:
            raise ControlError("this target id is already configured")
        if len(targets) >= 16:
            raise ControlError("at most 16 targets are permitted")
        # The collector drops a target beyond max_targets. Its published count
        # lags a reload, so the configured count, read under the lock, also
        # counts adds that it has not seen yet.
        if max_targets is not None and len(targets) >= max_targets:
            raise TargetLimitError(max_targets)
        selected = change.get("target")
        if not isinstance(selected, str) or not selected:
            raise ControlError("enter a process name or PID")
        pid = parse_pid(selected)
        if pid is not None:
            require_process(pid)
        else:
            unique_process_named(selected)
        targets.append({"id": target_id, "target": selected})
    elif action == "remove":
        if existing is None:
            raise ControlError("this target id is no longer configured")
        if len(targets) <= 1:
            raise ControlError("keep at least one target configured")
        if "target" in change and change["target"] != existing["target"]:
            raise ControlError("this target selector changed; reload the target list")
        targets.remove(existing)
    else:
        raise ControlError("action must be add or remove")
    return replace_targets(text, targets)


def dashboard_targets(root, host, port, max_targets, body=None):
    """Apply one set operation under the existing configuration lock."""
    check = False
    try:
        if body is not None:
            try:
                change = json.loads(body)
            except ValueError:
                raise ControlError("invalid target change JSON") from None
            # A check validates an add without a change, so the dashboard
            # can reject bad input before it asks for confirmation.
            check = isinstance(change, dict) and change.pop("check", None) is True
            if check:
                if change.get("action") != "add":
                    raise ControlError("only an add can be checked")
                sampler = running_sampler(root)
                if sampler is None:
                    raise ControlError("the sampler is not running; start it with scripts/start.sh")
                require_local_collector(sampler[1], (host, port))
                change_target_set(sampler[1].read_text(), change, max_targets)
            else:
                update_config(root, None, None, (host, port),
                              transform=lambda text: change_target_set(text, change, max_targets))
        sampler = running_sampler(root)
        if sampler is None:
            raise ControlError("the sampler is not running; start it with scripts/start.sh")
        require_local_collector(sampler[1], (host, port))
        result = {"enabled": True, "host": os.uname().nodename,
                  "targets": configured_targets(sampler[1].read_text())}
        if body is not None and not check:
            result["message"] = "Reload requested. The target change applies to every viewer."
    except (ControlError, OSError, subprocess.TimeoutExpired) as error:
        result = {"enabled": True, "error": str(error)}
        if isinstance(error, TargetLimitError):
            result["at_limit"] = True
        if isinstance(error, AmbiguousNameError):
            result["candidates"] = error.candidates
            result["total"] = error.total
    print(json.dumps(result))


def edit_target_set(root, change):
    sampler, config = update_config(root, None, None,
        transform=lambda text: change_target_set(text, change))
    print(f"Updated {config}: {change['action']} target {change['id']}")
    print(f"Requested reload of sampler {sampler}.")


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
    """Use the runtime config only when the sampler is absent or stopped."""
    try:
        sampler = running_sampler(root)
        config = sampler[1] if sampler is not None else runtime_directory() / "config/sampler.toml"
        endpoint = read_setting(config.read_text(), "collector")
    except (ControlError, OSError) as error:
        raise ControlError(f"cannot read the collector endpoint: {error}; pass --collector IP:PORT") from None
    if not endpoint:
        raise ControlError(f"no collector in {config}; pass --collector IP:PORT")
    print(f"Collector {endpoint} from {config}", file=sys.stderr)
    print(endpoint)


def main(argv):
    if len(argv) in (5, 6) and argv[1] == "dashboard-targets":
        dashboard_targets(ROOT, argv[2], argv[3], int(argv[4]), argv[5] if len(argv) == 6 else None)
        return 0
    if len(argv) in (4, 5) and argv[1] == "dashboard-target":
        dashboard_target(ROOT, argv[2], argv[3], argv[4] if len(argv) == 5 else None)
        return 0
    commands = {
        "set-target": (1, lambda target: set_target(ROOT, target)),
        "set-target-id": (2, lambda target_id, target: set_target(ROOT, target, target_id=target_id)),
        "add-target": (2, lambda target_id, target: edit_target_set(ROOT, {"action": "add", "id": target_id, "target": target})),
        "remove-target": (1, lambda target_id: edit_target_set(ROOT, {"action": "remove", "id": target_id})),
        "set-rate": (1, lambda rate: set_rate(ROOT, rate)),
        "resolve-pid": (1, lambda target: print(resolve_pid(target))),
        "collector": (0, lambda: collector(ROOT)),
    }
    name = argv[1] if len(argv) > 1 else ""
    if name not in commands or len(argv) != commands[name][0] + 2:
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    prefix = "watch-sockets" if name in ("resolve-pid", "collector") else name
    try:
        commands[name][1](*argv[2:])
    except (ControlError, OSError, subprocess.TimeoutExpired) as error:
        print(f"{prefix}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
