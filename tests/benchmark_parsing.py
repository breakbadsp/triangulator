#!/usr/bin/env python3
"""Verify parser behavior and compare a Git revision with the working tree."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CASES = {
    "stat": ("benchmark_parse_stat.cpp", "check", "1000000"),
    "number-short": ("benchmark_parse_number.cpp", "verify", "short"),
    "number-mixed": ("benchmark_parse_number.cpp", "verify", "mixed"),
    "schedstat": ("benchmark_aux_parsing.cpp", "verify", "schedstat"),
    "io": ("benchmark_aux_parsing.cpp", "verify", "io"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="e1425460", help="Git revision for the original parser")
    parser.add_argument("--hyperfine", default="hyperfine", help="hyperfine executable")
    parser.add_argument("--cpu", type=int, help="pin timed processes to this CPU")
    parser.add_argument("--runs", type=int, default=15)
    parser.add_argument("--warmup", type=int, default=3)
    parser.add_argument("--output", type=Path, default=ROOT / "build/parsing-comparison")
    args = parser.parse_args()
    if args.runs < 2 or args.warmup < 0:
        parser.error("runs must be at least 2 and warmup must be nonnegative")
    revision = subprocess.check_output(["git", "rev-parse", args.base], cwd=ROOT, text=True).strip()
    original = subprocess.check_output(["git", "show", f"{revision}:sampler/parsing.hpp"], cwd=ROOT)
    updated = (ROOT / "sampler/parsing.hpp").read_bytes()
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tri-parser-bench-") as temporary:
        directory = Path(temporary)
        binaries = {}
        for label, header in (("before", original), ("after", updated)):
            root = directory / label
            (root / "sampler").mkdir(parents=True)
            (root / "tests").mkdir()
            (root / "sampler/parsing.hpp").write_bytes(header)
            for source, verify, _ in set(CASES.values()):
                src = root / "tests" / source
                shutil.copyfile(ROOT / "tests" / source, src)
                binary = root / source.removesuffix(".cpp")
                if binary not in binaries.values():
                    subprocess.run([os.environ.get("CXX", "c++"), "-O2", "-flto=auto",
                                    "-Wall", "-Wextra", "-Werror", "-Wconversion", "-Wshadow",
                                    "-std=c++23", str(src), "-o", str(binary)], check=True)
                    subprocess.run([str(binary), verify], check=True)
                binaries[label, source] = binary
        for name, (source, _, mode) in CASES.items():
            commands = []
            for label in ("before", "after"):
                cmd = [str(binaries[label, source]), mode]
                if args.cpu is not None:
                    cmd = ["taskset", "-c", str(args.cpu), *cmd]
                commands.extend(["--command-name", label, shlex.join(cmd)])
            subprocess.run([args.hyperfine, "--warmup", str(args.warmup), "--runs", str(args.runs),
                            "--export-json", str(args.output / f"{name}.json"), *commands], check=True)
        (args.output / "metadata.json").write_text(json.dumps(
            {"base_revision": revision, "compiler": os.environ.get("CXX", "c++"),
             "flags": "-O2 -flto=auto -Wall -Wextra -Werror -Wconversion -Wshadow -std=c++23",
             "cpu": args.cpu, "runs": args.runs, "warmup": args.warmup}, indent=2) + "\n")


if __name__ == "__main__":
    main()
