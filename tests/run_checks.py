"""Run the complete test suite and check sanitizer reports from child processes."""

import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def sanitizer_environment(mode, directory):
    environment = os.environ.copy()
    for name in ("ASAN_OPTIONS", "UBSAN_OPTIONS", "TSAN_OPTIONS"):
        options = environment.get(name, "")
        required = f"halt_on_error=1:log_path={directory / name}"
        if name == "ASAN_OPTIONS":
            required += ":detect_leaks=1"
        if name == "UBSAN_OPTIONS":
            required += ":print_stacktrace=1"
        environment[name] = f"{options}:{required}" if options else required
    environment["SANITIZER"] = mode
    return environment


def check_reports(directory):
    reports = sorted(path for path in directory.iterdir()
                     if path.is_file() and path.stat().st_size)
    for report in reports:
        print(f"Sanitizer report: {report}", file=sys.stderr)
        print(report.read_text(errors="replace"), file=sys.stderr)
    return bool(reports)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binaries", nargs="*")
    parser.add_argument("--pattern", default="test*.py")
    arguments = parser.parse_args()
    mode = os.environ.get("SANITIZER", "")
    directory = None
    environment = os.environ.copy()
    if mode:
        parent = ROOT / "build/sanitizer-reports" / mode
        parent.mkdir(parents=True, exist_ok=True)
        directory = Path(tempfile.mkdtemp(prefix="run-", dir=parent))
        environment = sanitizer_environment(mode, directory)
        print(f"Sanitizer reports: {directory}", flush=True)
    commands = [[str(ROOT / binary)] for binary in arguments.binaries]
    commands.append([sys.executable, "-m", "unittest", "discover", "-s", "tests",
                     "-p", arguments.pattern, "-v"])
    status = 0
    try:
        for command in commands:
            result = subprocess.run(command, cwd=ROOT, env=environment, check=False)
            if result.returncode:
                status = 1
                break
    finally:
        # Tests can discard stderr or accept a child's nonzero exit status.
        # Runtime log files preserve reports from these processes.
        if directory is not None and check_reports(directory):
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())
