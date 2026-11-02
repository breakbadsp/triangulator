#!/usr/bin/env python3
"""Shared code for set-rate.sh and the dashboard target control.

Usage: sampler_control.py set-rate HZ

set-rate and the dashboard edit the running sampler's config in place and send
SIGHUP. The new file is first checked by the running sampler binary itself
(`/proc/PID/exe --check-config`), so it is validated by the same parser that
reloads it.
"""

import fcntl
from fnmatch import fnmatchcase
import ipaddress
import json
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

    Other matching lines are removed (the sampler rejects duplicate keys).
    Without a match, setting is appended.
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
        raise ControlError("the local sampler sends to a different collector; edit sampler.toml on its host")


RULE_LISTS = ("process_names", "process_patterns")
RULE_NAME = re.compile(r"[A-Za-z0-9_.-]{1,15}")


def strip_comment(line):
    quoted = False
    for index, character in enumerate(line):
        if character == '"':
            quoted = not quoted
        elif character == "#" and not quoted:
            return line[:index]
    return line


def rule_list(text, key):
    """(items, first line, last line) of a list setting, or None without it.

    Read with the sampler's rules: a list can span lines, with comments. An
    item cannot contain a closing bracket, as the sampler rejects one.
    """
    lines = text.split("\n")
    for start, line in enumerate(lines):
        name, separator, value = strip_comment(line).partition("=")
        if not separator or name.strip(" \t\r") != key:
            continue
        body, end = value.strip(), start
        while "]" not in body and end + 1 < len(lines):
            end += 1
            body += " " + strip_comment(lines[end]).strip()
        return re.findall(r'"([^"]*)"', body), start, end
    return None


def replace_rule_list(text, key, items):
    """Write a list setting with one item per line, so adding a name is one line."""
    block = [f"{key} = ["] + [f'  "{item}",' for item in items] + ["]"] if items else [f"{key} = []"]
    found = rule_list(text, key)
    lines = text.split("\n")
    if found is None:
        if lines and lines[-1] == "":
            lines.pop()
        return "\n".join(lines + block) + "\n"
    _, start, end = found
    return "\n".join(lines[:start] + block + lines[end + 1:])


def change_rule_set(text, change):
    """Add or remove one exact process name; patterns are edited on the host."""
    if not isinstance(change, dict) or set(change) - {"action", "id", "target", "name", "key", "rule"}:
        raise ControlError("expected an action and a process name")
    names = (rule_list(text, "process_names") or ([],))[0]
    patterns = (rule_list(text, "process_patterns") or ([],))[0]
    action = change.get("action")
    if action == "add":
        name = change.get("target")
        if not isinstance(name, str) or not RULE_NAME.fullmatch(name) or name in (".", ".."):
            raise ControlError("enter an exact process name of 1..15 letters, digits, dots, "
                               "underscores, or hyphens; Linux keeps 15 bytes of a process name")
        if name in names:
            raise ControlError(f"{name} is already in process_names")
        if len(names) + len(patterns) >= 16:
            raise ControlError("at most 16 process names and patterns are permitted")
        names.append(name)
    elif action == "remove":
        name = change.get("name")
        if name not in names:
            raise ControlError("this process name is no longer configured; reload the target list")
        if any(fnmatchcase(name, pattern) for pattern in patterns):
            raise ControlError("a process pattern also selects this name; edit process_patterns on the host")
        if names == [name] and not patterns:
            raise ControlError("keep at least one process name or pattern; the sampler needs one")
        names.remove(name)
    else:
        raise ControlError("action must be add or remove")
    return replace_rule_list(text, "process_names", names)


def dashboard_targets(root, host, port, body=None):
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
                change_rule_set(sampler[1].read_text(), change)
            else:
                update_config(root, None, None, (host, port),
                              transform=lambda text: change_rule_set(text, change))
        sampler = running_sampler(root)
        if sampler is None:
            raise ControlError("the sampler is not running; start it with scripts/start.sh")
        require_local_collector(sampler[1], (host, port))
        text = sampler[1].read_text()
        result = {"enabled": True, "host": os.uname().nodename}
        result.update(names=(rule_list(text, "process_names") or ([],))[0],
                      patterns=(rule_list(text, "process_patterns") or ([],))[0])
        if body is not None and not check:
            result["message"] = "Reload requested. The target change applies to every viewer."
    except (ControlError, OSError, subprocess.TimeoutExpired) as error:
        result = {"enabled": body is not None, "error": str(error)}
    print(json.dumps(result))


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


def main(argv):
    if len(argv) in (4, 5) and argv[1] == "dashboard-targets":
        dashboard_targets(ROOT, argv[2], argv[3], argv[4] if len(argv) == 5 else None)
        return 0
    commands = {
        "set-rate": (1, lambda rate: set_rate(ROOT, rate)),
    }
    name = argv[1] if len(argv) > 1 else ""
    if name not in commands or len(argv) != commands[name][0] + 2:
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 2
    try:
        commands[name][1](*argv[2:])
    except (ControlError, OSError, subprocess.TimeoutExpired) as error:
        print(f"{name}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
