#!/usr/bin/env python3
"""Optional experimental gate. A dependency or setup skip is never execution PASS."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def skipped(status, reason, executed):
    print(json.dumps({"status": status, "reason": reason,
                      "executed_test_groups": executed}))
    return 1 if os.environ.get("EXPERIMENTAL_REQUIRE") == "1" else 0


def main():
    if not shutil.which("pkg-config") or subprocess.run(
            ["pkg-config", "--exists", "liburing"]).returncode:
        return skipped("SKIP_DEPENDENCY", "pkg-config and liburing development files required", 0)
    build = subprocess.run(["make", "--no-print-directory", "build/experimental-sampling",
                            "build/experimental-sampling-test", "build/benchmark-target"],
                           cwd=ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (ROOT / "build/experimental-build.log").write_text(build.stdout)
    if build.returncode:
        print(build.stdout, file=sys.stderr)
        print(json.dumps({"status": "FAIL", "phase": "build", "executed_test_groups": 0}))
        return 1
    tested = subprocess.run([str(ROOT / "build/experimental-sampling-test")],
                            cwd=ROOT, text=True, capture_output=True)
    print(tested.stdout, end="")
    if tested.returncode == 77:
        return skipped("SKIP_SETUP", tested.stderr.strip(), 1)
    if tested.returncode:
        print(tested.stderr, file=sys.stderr)
        print(json.dumps({"status": "FAIL", "phase": "test", "executed_test_groups": "see test output"}))
        return 1
    compared = subprocess.run([sys.executable, "tests/experimental_sampling.py",
                               "--threads", "64", "--ticks", "10", "--repeats", "1",
                               "--output", "build/experimental-gate.json"], cwd=ROOT)
    if compared.returncode == 77:
        return skipped("SKIP_SETUP", "live comparison ring setup unavailable", 6)
    if compared.returncode:
        print(json.dumps({"status": "FAIL", "phase": "live comparison", "executed_test_groups": 6}))
        return 1
    print(json.dumps({"status": "PASS", "executed_test_groups": 6,
                      "live_comparison_trials": 12,
                      "cpu_accounting": "see build/experimental-gate.json; unavailable coverage is explicit"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
