#!/usr/bin/env python3
"""Run a small sampler parsing mutation trial: python3 tests/mutate_sampler.py."""

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MUTATIONS = {
    "thread name truncates one byte early": (
        "std::min(last - first - 1, std::size_t{15})",
        "std::min(last - first - 1, std::size_t{14})",
    ),
    "multi-byte thread state accepted": (
        "if (token.size() != 1)", "if (token.empty())"
    ),

}


def main():
    with tempfile.TemporaryDirectory(prefix="sampler-mutations-") as directory:
        copy = Path(directory) / "source"
        shutil.copytree(ROOT, copy, ignore=shutil.ignore_patterns(
            ".git", "build", "node_modules", "dist", "__pycache__"))
        source = copy / "sampler/parsing.hpp"
        original = source.read_text()
        for name, (before, _) in MUTATIONS.items():
            if original.count(before) != 1:
                raise RuntimeError(f"Mutation no longer matches: {name}")

        def build_and_test():
            build = subprocess.run(["make", "build/sampler-test"], cwd=copy,
                                   capture_output=True, text=True)
            if build.returncode:
                print(build.stdout + build.stderr, file=sys.stderr)
                return "BUILD_ERROR"
            result = subprocess.run([str(copy / "build/sampler-test")], cwd=copy,
                                    capture_output=True, text=True, timeout=60)
            return "PASSED" if result.returncode == 0 else "FAILED"

        baseline = build_and_test()
        print(f"baseline: {baseline}", flush=True)
        if baseline != "PASSED":
            return 1
        errors = False
        for name, (before, after) in MUTATIONS.items():
            source.write_text(original.replace(before, after, 1))
            # Force recompilation even on filesystems with coarse timestamps.
            (copy / "build/sampler-test.o").unlink(missing_ok=True)
            result = build_and_test()
            outcome = {"PASSED": "SURVIVED", "FAILED": "KILLED"}.get(result, result)
            print(f"{name}: {outcome}", flush=True)
            errors |= outcome == "BUILD_ERROR"
        return int(errors)


if __name__ == "__main__":
    sys.exit(main())
