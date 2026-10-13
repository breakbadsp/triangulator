#!/usr/bin/env python3
"""Measure sampler thread-reading throughput and latency without UDP or a collector.

Use `make benchmark-sampling`. One target thread burns CPU; all others sleep.
Use --compare BASELINE.json to compare a new run with a saved baseline.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import select
import subprocess
import sys

from benchmark_sampler import ROOT, TARGET, child


COUNTS = (1, 100, 200, 300, 500)
BINARY = ROOT / "build/benchmark-sampling"
METRICS = ("throughput_threads_s", "mean_tick_us", "mean_thread_us",
           "p50_tick_us", "p90_tick_us", "p99_tick_us", "p100_tick_us")
MATCH_FIELDS = ("schema_version", "counts", "iterations", "warmup_s", "repeats",
                "cpu_model", "kernel", "machine", "allowed_cpus", "build_options", "workload_source_sha256",
                "status_fallback", "descriptor_strategy", "latency_method", "throughput_method",
                "percentile_method", "mean_thread_method")


def summarize(latency_ns, threads):
    if not latency_ns or any(value <= 0 for value in latency_ns):
        raise ValueError("sampling durations must be positive")
    ordered = sorted(latency_ns)
    total_ns = sum(ordered)
    mean_us = total_ns / len(ordered) / 1000
    result = {
        "threads": threads, "ticks": len(ordered), "thread_records": threads * len(ordered),
        "total_sampling_ns": total_ns,
        "throughput_threads_s": threads * len(ordered) * 1e9 / total_ns,
        "mean_tick_us": mean_us, "mean_thread_us": mean_us / threads,
    }
    for percentile in (50, 90, 99, 100):
        index = math.ceil(percentile * len(ordered) / 100) - 1
        result[f"p{percentile}_tick_us"] = ordered[index] / 1000
    return result


def run_case(threads, iterations, warmup_s):
    with child([str(TARGET), str(threads)], stdout=subprocess.PIPE, text=True) as target:
        if not select.select([target.stdout], [], [], 10)[0]:
            raise RuntimeError("workload did not start within 10 seconds")
        if target.stdout.readline().strip() != f"{threads} threads ready":
            raise RuntimeError("workload did not start the required threads")
        if len(list(Path(f"/proc/{target.pid}/task").iterdir())) != threads:
            raise RuntimeError("workload native thread count is incorrect")
        result = subprocess.run(
            [str(BINARY), str(target.pid), str(threads), str(iterations), str(round(warmup_s * 1000))],
            capture_output=True, text=True, timeout=max(30, warmup_s + iterations * 0.1))
        if result.returncode or result.stderr:
            raise RuntimeError(f"sampling benchmark failed: {result.stderr.strip()}")
        measured = json.loads(result.stdout)
        if measured["threads"] != threads or len(measured["latency_ns"]) != iterations:
            raise RuntimeError("sampling benchmark returned incomplete results")
        return measured["latency_ns"]


def render(summary):
    lines = ["| Threads | Thread records/s | Mean batch (ms) | p50 (ms) | p90 (ms) | p99 (ms) | p100 (ms) | Mean/thread (µs) |",
             "| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for row in summary:
        times = " | ".join(f"{row[key] / 1000:.3f}" for key in
                           ("mean_tick_us", "p50_tick_us", "p90_tick_us", "p99_tick_us", "p100_tick_us"))
        lines.append(f"| {row['threads']} | {row['throughput_threads_s']:,.0f} | {times} | {row['mean_thread_us']:.3f} |")
    return "\n".join(lines)


def compare(baseline, current):
    if not baseline.get("complete") or not current.get("complete"):
        raise ValueError("comparison requires two complete benchmark runs")
    mismatch = [key for key in MATCH_FIELDS if baseline.get(key) != current.get(key)]
    if mismatch:
        raise ValueError("baseline settings differ: " + ", ".join(mismatch))
    old = {row["threads"]: row for row in baseline["summary"]}
    if set(old) != {row["threads"] for row in current["summary"]}:
        raise ValueError("baseline thread counts differ")
    differences = []
    for row in current["summary"]:
        differences.append({"threads": row["threads"], **{
            key + "_change_percent": 100 * (row[key] / old[row["threads"]][key] - 1)
            for key in METRICS}})
    return differences


def render_comparison(differences):
    lines = ["| Threads | Throughput change | Mean latency change | p50 change | p90 change | p99 change | p100 change |",
             "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for row in differences:
        values = " | ".join(f"{row[key + '_change_percent']:+.2f}%" for key in
                            ("throughput_threads_s", "mean_tick_us", "p50_tick_us",
                             "p90_tick_us", "p99_tick_us", "p100_tick_us"))
        lines.append(f"| {row['threads']} | {values} |")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--iterations", type=int, default=10000, help="timed batches per case per repeat")
    parser.add_argument("--warmup", type=float, default=5, help="warm-up seconds per case")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--counts", type=int, nargs="+", default=list(COUNTS), help="target thread counts")
    parser.add_argument("--output", type=Path, default=ROOT / "build/sampling-performance.json")
    parser.add_argument("--compare", type=Path, help="saved baseline with the same settings and host")
    args = parser.parse_args()
    if (not 100 <= args.iterations <= 1000000 or not math.isfinite(args.warmup)
            or not 0 <= args.warmup <= 60 or args.repeats < 1
            or len(set(args.counts)) != len(args.counts) or any(not 1 <= value <= 500 for value in args.counts)):
        parser.error("iterations must be 100..1000000; warmup 0..60; repeats positive; counts unique in 1..500")
    cpu_model = next((line.split(":", 1)[1].strip()
                      for line in Path("/proc/cpuinfo").read_text().splitlines()
                      if line.startswith("model name")), platform.machine())
    report = {
        "schema_version": 1, "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "benchmark_sha256": hashlib.sha256(BINARY.read_bytes()).hexdigest(),
        "benchmark_driver_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "workload_sha256": hashlib.sha256(TARGET.read_bytes()).hexdigest(),
        "workload_source_sha256": hashlib.sha256((ROOT / "tests/benchmark_target.cpp").read_bytes()).hexdigest(),
        "build_options": (BINARY.parent / "build_options").read_text().strip(),
        "cpu_model": cpu_model, "kernel": platform.release(), "machine": platform.machine(),
        "allowed_cpus": sorted(os.sched_getaffinity(0)),
        "counts": args.counts, "iterations": args.iterations, "warmup_s": args.warmup,
        "repeats": args.repeats, "busy_threads": 1, "status_fallback": False,
        "descriptor_strategy": "keep all four proc files open per thread",
        "latency_method": "CLOCK_MONOTONIC around FindTarget, Rescan, TakeSample and record writes; no UDP/resources/memory maps",
        "throughput_method": "total thread records / sum timed batch durations; no rate limit",
        "percentile_method": "nearest rank over all timed batches from all repeats; p100 is observed maximum",
        "mean_thread_method": "mean batch duration / thread count; includes shared batch costs",
        "runs": [], "summary": [], "complete": False,
    }
    baseline = json.loads(args.compare.read_text()) if args.compare else None
    if baseline is not None:
        if not baseline.get("complete"):
            raise ValueError("baseline is an incomplete benchmark run")
        if {row["threads"] for row in baseline["summary"]} != set(args.counts):
            raise ValueError("baseline thread counts differ")
        mismatch = [key for key in MATCH_FIELDS if baseline.get(key) != report.get(key)]
        if mismatch:
            raise ValueError("baseline settings differ: " + ", ".join(mismatch))
    samples = {count: [] for count in args.counts}
    for repeat in range(args.repeats):
        for count in args.counts:
            print(f"Run {repeat + 1}/{args.repeats}: {count} threads", file=sys.stderr, flush=True)
            durations = run_case(count, args.iterations, args.warmup)
            samples[count].extend(durations)
            row = summarize(durations, count)
            report["runs"].append({"repeat": repeat + 1, **row})
            report["summary"] = [summarize(samples[count], count) for count in args.counts if samples[count]]
            print(f"  {row['throughput_threads_s']:,.0f} records/s; mean {row['mean_tick_us'] / 1000:.3f} ms; "
                  f"p99 {row['p99_tick_us'] / 1000:.3f} ms", file=sys.stderr, flush=True)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n")
    report["complete"] = True
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(render(report["summary"]))
    if baseline is not None:
        report["comparison"] = compare(baseline, report)
        args.output.write_text(json.dumps(report, indent=2) + "\n")
        print("\nChange from baseline (higher throughput and lower latency are better):\n")
        print(render_comparison(report["comparison"]))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"benchmark failed: {error}", file=sys.stderr)
        sys.exit(1)
