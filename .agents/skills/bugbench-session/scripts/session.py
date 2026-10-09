#!/usr/bin/env python3
"""Run one persistent bugbench session through the user systemd manager."""

import argparse
import fcntl
import json
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


class Session:
    def __init__(self, home):
        self.bin = home / "bin"
        self.root = home / "bugbench-session"
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_path = self.root / "state.json"
        self.binary = self.bin / "bugbench"

    def state(self):
        return json.loads(self.state_path.read_text()) if self.state_path.exists() else {}

    def save(self, state):
        temporary = self.state_path.with_suffix(".tmp")
        temporary.write_text(json.dumps(state, indent=2) + "\n")
        temporary.replace(self.state_path)

    def install(self):
        source = Path(__file__).resolve().parents[4] / "bug-lab" / "bugbench.c"
        self.bin.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=self.bin) as directory:
            built = Path(directory) / "bugbench"
            command(["gcc", "-O2", "-Wall", "-Wextra", "-pthread", str(source), "-o", str(built)])
            shutil.copyfile(source, self.bin / "bugbench.c")
            built.replace(self.binary)

    def scenarios(self):
        names = [line.split()[0] for line in command([str(self.binary), "--list"]).splitlines()]
        return [name for name in names if name != "healthy"] + ["healthy"]

    def properties(self, state):
        if not state.get("unit"):
            return {}
        result = subprocess.run(
            ["systemctl", "--user", "show", state["unit"],
             "--property=MainPID", "--property=ActiveState", "--property=Result"],
            capture_output=True, text=True, check=False,
        )
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or "Cannot read the user service state.")
        return dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)

    def status(self):
        state = self.state()
        if not state:
            print("No saved scenario. Use start or next.")
            return
        properties = self.properties(state)
        print(f"Scenario: {state['scenario']}")
        active = properties.get("ActiveState") == "active" and int(properties.get("MainPID", 0)) > 0
        print(f"PID: {properties['MainPID']}" if active else "Process: stopped")
        if properties.get("Result"):
            print(f"Service result: {properties['Result']}")
        print(f"Duration: {state['seconds']} seconds")
        print(f"Log: {state['log']}")
        print(f"Command: {shlex.join(state['command'])}")

    def stop(self):
        state = self.state()
        if state.get("unit"):
            properties = self.properties(state)
            if properties.get("ActiveState") in {"active", "activating", "deactivating"}:
                command(["systemctl", "--user", "stop", state["unit"]])
            state["unit"] = None
            self.save(state)

    def launch(self, scenario, seconds):
        # Check prerequisites before stopping the current workload.
        command(["systemctl", "--user", "show-environment"])
        unit = "triangular-bugbench-" + uuid.uuid4().hex
        storage = Path(tempfile.mkdtemp(prefix="triangular-bugbench-", dir="/var/tmp"))
        log = self.root / (unit + ".log")
        args = ["systemd-run", "--user", f"--unit={unit}",
                "--property=Type=exec", f"--property=RuntimeMaxSec={seconds}",
                "--property=MemoryMax=" + ("256M" if scenario == "mem-oom" else "2G"),
                "--property=MemorySwapMax=0",
                f"--property=StandardOutput=append:{log}",
                f"--property=StandardError=append:{log}",
                f"--setenv=BUG_LAB_DIR={storage}"]
        if scenario == "cpu-throttle":
            args.append("--property=CPUQuota=50%")
        args += [str(self.binary), scenario, str(seconds)]
        self.stop()
        try:
            command(args)
        except Exception:
            storage.rmdir()
            raise
        self.save({"scenario": scenario, "seconds": seconds, "unit": unit + ".service",
                   "storage": str(storage), "log": str(log), "command": args})
        self.status()

    def dispatch(self, action, scenario, seconds):
        if action == "status":
            self.status()
            return
        if action == "stop":
            self.stop()
            print("Session process stopped. Scenario position is saved.")
            return
        if action == "start":
            self.install()
        elif not self.binary.exists():
            self.install()
        names = self.scenarios()
        state = self.state()
        if action == "list":
            print("\n".join(names))
            return
        if action == "start":
            properties = self.properties(state)
            if properties.get("ActiveState") == "active":
                self.status()
                return
            chosen = state.get("scenario", names[0])
        elif action == "run":
            chosen = scenario
        elif not state:
            if action == "previous":
                print("No previous scenario. Use start or next.")
                return
            chosen = names[0]
        else:
            index = names.index(state["scenario"]) + (1 if action == "next" else -1)
            if not 0 <= index < len(names):
                print("No next scenario." if action == "next" else "No previous scenario.")
                return
            chosen = names[index]
        if chosen not in names:
            raise ValueError(f"Unknown scenario: {chosen}. Use list.")
        self.launch(chosen, seconds)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "next", "previous", "run", "list", "status", "stop"])
    parser.add_argument("scenario", nargs="?")
    parser.add_argument("--seconds", type=int, default=1800)
    parser.add_argument("--home", type=Path, default=Path.home() / "triangular")
    args = parser.parse_args()
    if args.seconds <= 0 or (args.action == "run") != (args.scenario is not None):
        parser.error("Use run SCENARIO. Duration must be a positive integer.")
    session = Session(args.home.expanduser().resolve())
    with (session.root / "lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        session.dispatch(args.action, args.scenario, args.seconds)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f"Error: {detail}", file=sys.stderr)
        sys.exit(1)
