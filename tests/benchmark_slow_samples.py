#!/usr/bin/env python3
"""Measure what one resource sample and one memory-map sample cost the sampler.

Use `make benchmark-slow-samples`. For each target shape, build/benchmark-victim
sleeps with 500 threads and the requested mappings, files and sockets, and
build/benchmark-sampling calls the production ResourceProbe or MemoryProbe in a
loop, with no UDP and no collector. It records the wall time and the sampler
thread's CPU time of each sample. For memory-map samples it also records the
sampler's own report of its longest single read of /proc/PID/maps, which is how
long one read can hold the target's address-space lock. No root is needed.
"""

import argparse
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import platform
import select
import statistics
import subprocess
import sys

from benchmark_sampler import ROOT, child, percentile

VICTIM = ROOT / "build/benchmark-victim"
BINARY = ROOT / "build/benchmark-sampling"
THREADS = 500
# name: victim options. The first has no ballast: threads only.
SHAPES = {
    "threads-only": [],
    "service": ["mappings=5000", "files=300", "sockets=100"],
    "large": ["mappings=30000", "files=1000", "sockets=400"],
    # About 10,000 descriptors and 10,000 sockets in the namespace: shows how the
    # resource sample grows with the socket count.
    "many-sockets": ["mappings=5000", "files=300", "sockets=5000"],
}
KINDS = ("resources", "memory")


def run_case(shape, kind, iterations, warmup_s, cpu):
    """One victim, one run of benchmark-sampling. Returns its parsed output."""
    with child([str(VICTIM), str(THREADS), "1", *["-1"] * 4, *SHAPES[shape]],
               stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True) as victim:
        if not select.select([victim.stdout], [], [], 20)[0]:
            raise RuntimeError("victim did not start within 20 seconds")
        if victim.stdout.readline().strip() != f"{THREADS} threads ready":
            raise RuntimeError("victim did not start all threads")
        result = subprocess.run(
            [str(BINARY), str(victim.pid), str(THREADS), str(iterations), str(round(warmup_s * 1000)), kind],
            capture_output=True, text=True, timeout=600,
            preexec_fn=lambda: os.sched_setaffinity(0, {cpu}) if cpu is not None else None)
        if result.returncode or result.stderr:
            raise RuntimeError(f"{shape}/{kind} failed: {result.stderr.strip()}")
        return json.loads(result.stdout)


def summarize(runs):
    """Pool the observations of all repeats of one shape and kind."""
    wall_us = [value / 1000 for run in runs for value in run["latency_ns"]]
    cpu_us = [value / 1000 for run in runs for value in run["cpu_ns"]]
    row = {"samples": len(wall_us), "wall_p50_us": statistics.median(wall_us),
           "wall_p95_us": percentile(wall_us, 95), "wall_max_us": max(wall_us),
           "cpu_mean_us": statistics.mean(cpu_us), "cpu_p95_us": percentile(cpu_us, 95)}
    if "maps_longest_read_us" in runs[0]:
        longest = [value for run in runs for value in run["maps_longest_read_us"]]
        row.update(maps_lines=runs[0]["maps_lines"],
                   longest_read_p50_us=statistics.median(longest),
                   longest_read_p95_us=percentile(longest, 95), longest_read_max_us=max(longest))
    return row


def render(summary):
    lines = ["| Target | Sample | Wall p50 (ms) | Wall p95 (ms) | Wall max (ms) | CPU mean (ms) | Longest maps read p50 / max (µs) |",
             "| --- | --- | ---: | ---: | ---: | ---: | ---: |"]
    for key, row in summary.items():
        shape, kind = key.split("/")
        reads = (f"{row['longest_read_p50_us']:.0f} / {row['longest_read_max_us']:.0f}"
                 if "maps_lines" in row else "")
        label = shape + (f" ({row['maps_lines']} maps lines)" if "maps_lines" in row else "")
        lines.append(f"| {label} | {kind} | {row['wall_p50_us'] / 1000:.2f} | {row['wall_p95_us'] / 1000:.2f} | "
                     f"{row['wall_max_us'] / 1000:.2f} | {row['cpu_mean_us'] / 1000:.2f} | {reads} |")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shapes", nargs="+", choices=SHAPES, default=list(SHAPES))
    parser.add_argument("--iterations", type=int, default=1000, help="timed samples per run")
    parser.add_argument("--warmup", type=float, default=2, help="warm-up seconds per run")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--cpu", type=int, help="pin the sampler loop to this CPU")
    parser.add_argument("--output", type=Path, default=ROOT / "build/slow-samples.json")
    args = parser.parse_args()
    if (not 100 <= args.iterations <= 1000000 or not math.isfinite(args.warmup)
            or not 0 <= args.warmup <= 60 or args.repeats < 1 or len(set(args.shapes)) != len(args.shapes)):
        parser.error("iterations 100..1000000; warmup 0..60; repeats positive; shapes distinct")
    runs = {f"{shape}/{kind}": [] for shape in args.shapes for kind in KINDS}
    report = {"schema_version": 1, "complete": False, "kernel": platform.release(),
              "machine": platform.machine(), "measured_at_utc": datetime.now(timezone.utc).isoformat(),
              "cpu_model": next((line.split(":", 1)[1].strip()
                                 for line in Path("/proc/cpuinfo").read_text().splitlines()
                                 if line.startswith("model name")), platform.machine()),
              "threads": THREADS, "shapes": {name: SHAPES[name] for name in args.shapes},
              "iterations": args.iterations, "repeats": args.repeats, "summary": {}}
    for repeat in range(args.repeats):
        for key in runs:
            shape, kind = key.split("/")
            print(f"Run {repeat + 1}/{args.repeats}: {shape} {kind}", file=sys.stderr, flush=True)
            runs[key].append(run_case(shape, kind, args.iterations, args.warmup, args.cpu))
            report["summary"] = {name: summarize(group) for name, group in runs.items() if group}
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n")
    report["complete"] = True
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(render(report["summary"]))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"benchmark failed: {error}", file=sys.stderr)
        sys.exit(1)
