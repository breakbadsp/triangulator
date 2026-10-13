#!/usr/bin/env python3
"""Measure how much the sampler disturbs the process it samples.

Use `make benchmark-target-impact`. The target is build/benchmark-victim: sleeping
threads plus four probe threads, each pinned to its own core, that measure CPU time
lost to other work (spin), wake-up lateness (wake), signal-lock waits (lock) and
address-space-lock waits (mmap). Each scenario runs the real sampler against it,
pinned apart from the probes or sharing a probe's core, and is compared with the
`off` scenario, which has no sampler. Sampler CPU and tick duration (the burst
length) come from the same runs. Needs six CPUs, or pass --cpus (repeats allowed,
but results are then not isolated). No root is needed. Latency uses the receiver of
benchmark_sampler.py, so it needs Linux 5.1 or later.
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
import socket
import statistics
import subprocess
import sys
import tempfile
import time

from benchmark_sampler import (KMSG_NOTICE, MEMORY_INTERVAL_S, ROOT, SO_TIMESTAMPNS_NEW,
                               SampleStream, child, collect, percentile, wait_sample)

VICTIM = ROOT / "build/benchmark-victim"
ALLOWED_CPUS = frozenset(os.sched_getaffinity(0))
ROLES = ("spin", "wake", "lock", "mmap", "sampler", "driver")
# name: (rate_hz or None for no sampler, core the sampler uses, memory_interval_s, nice)
SCENARIOS = {
    "off": (None, None, MEMORY_INTERVAL_S, 0),
    "apart-1hz": (1, "sampler", MEMORY_INTERVAL_S, 0),
    "apart-10hz": (10, "sampler", MEMORY_INTERVAL_S, 0),
    "apart-10hz-maps-1s": (10, "sampler", 1, 0),
    "shared-spin-1hz": (1, "spin", MEMORY_INTERVAL_S, 0),
    "shared-spin-10hz": (10, "spin", MEMORY_INTERVAL_S, 0),
    "shared-spin-10hz-nice19": (10, "spin", MEMORY_INTERVAL_S, 19),
    "shared-wake-10hz": (10, "wake", MEMORY_INTERVAL_S, 0),
    "shared-wake-10hz-nice19": (10, "wake", MEMORY_INTERVAL_S, 19),
}
PROBES = ("spin", "wake", "lock", "mmap")
THRESHOLDS = ("over_10us", "over_100us", "over_1ms", "over_10ms")


def merge(probe_runs):
    """Add the counts of several runs of one probe; keep the largest value."""
    merged = {key: sum(run[key] for run in probe_runs)
              for key in ("samples", "slow_total_ns") + THRESHOLDS}
    merged["max_ns"] = max(run["max_ns"] for run in probe_runs)
    merged["buckets"] = [sum(column) for column in zip(*(run["buckets"] for run in probe_runs))]
    return merged


def percentile_ns(probe, percent):
    """Upper bound of the power-of-two bucket that holds the percentile, capped
    by the observed maximum. A report of N means the value is N or less."""
    target = math.ceil(sum(probe["buckets"]) * percent / 100)
    running = 0
    for width, count in enumerate(probe["buckets"]):
        running += count
        if running >= target:
            return min(probe["max_ns"], 0 if width == 0 else 2 ** width)
    return probe["max_ns"]


def check_probe(probe):
    if sum(probe["buckets"]) != probe["samples"] or probe["samples"] <= 0:
        raise RuntimeError("probe histogram is inconsistent")
    return probe


def read_probes(victim, timeout_s):
    if not select.select([victim.stdout], [], [], timeout_s)[0]:
        raise RuntimeError("workload did not report probe results in time")
    report = json.loads(victim.stdout.readline())
    return {name: check_probe(report[name]) for name in PROBES}


def trial(name, cpus, binary, threads, duration_s, warmup_s):
    rate, sampler_role, memory_interval_s, nice = SCENARIOS[name]
    by_role = dict(zip(ROLES, cpus))
    with tempfile.TemporaryDirectory() as directory, \
            socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver, \
            child([str(VICTIM), str(threads), str(duration_s), *map(str, cpus[:4])],
                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                  preexec_fn=lambda: os.sched_setaffinity(0, ALLOWED_CPUS)) as victim:
        if not select.select([victim.stdout], [], [], 10)[0]:
            raise RuntimeError("workload did not start within 10 seconds")
        if victim.stdout.readline().strip() != f"{threads} threads ready":
            raise RuntimeError("workload did not start all threads")
        thread_ids = {int(path.name) for path in Path(f"/proc/{victim.pid}/task").iterdir()}
        if len(thread_ids) != threads:
            raise RuntimeError("workload thread count differs from the requested count")
        start = lambda: (victim.stdin.write("go\n"), victim.stdin.flush())
        if rate is None:
            start()
            return {"scenario": name, "probes": read_probes(victim, duration_s + 10)}
        receiver.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
        receiver.setsockopt(socket.SOL_SOCKET, SO_TIMESTAMPNS_NEW, 1)
        receiver.bind(("127.0.0.1", 0))
        config = Path(directory) / "sampler.toml"
        config.write_text(
            f'target_pid = {victim.pid}\nrate_hz = {rate}\n'
            f'collector = "127.0.0.1:{receiver.getsockname()[1]}"\n'
            f'status_fallback = false\nresource_interval_s = 5\n'
            f'memory_interval_s = {memory_interval_s}\n')
        sampler_cpu = by_role[sampler_role]
        with open(Path(directory) / "sampler.log", "w+") as log, \
                child([str(binary), str(config)], stdout=subprocess.DEVNULL, stderr=log,
                      preexec_fn=lambda: (os.sched_setaffinity(0, {sampler_cpu}),
                                          os.setpriority(os.PRIO_PROCESS, 0, nice))) as sampler:
            try:
                stream = SampleStream(receiver, victim.pid, rate, thread_ids)
                wait_sample(stream, sampler, victim, time.monotonic() + 10)
                warmup_end = time.monotonic() + warmup_s
                while time.monotonic() < warmup_end:
                    wait_sample(stream, sampler, victim, warmup_end + 2 / rate)
                start()
                # A sampler that shares a core at low priority may be starved, at any
                # rate. That is the result, so it is recorded with its observed rate
                # and not rejected.
                sampler_result = collect(stream, sampler, victim, duration_s,
                                         allow_slow=bool(nice))
                probes = read_probes(victim, 10)
                log.flush()
                log.seek(0)
                if any(line and not line.startswith(KMSG_NOTICE) for line in log.read().splitlines()):
                    raise RuntimeError("sampler logged errors or warnings")
            except (OSError, ValueError, RuntimeError) as error:
                log.seek(0)
                raise RuntimeError(f"{error}; sampler log: {log.read().strip()}") from error
        return {"scenario": name, "probes": probes, "sampler": sampler_result}


def summarize(runs):
    """One row per scenario: merged probe counts and pooled sampler observations."""
    rows = []
    for name in dict.fromkeys(run["scenario"] for run in runs):
        group = [run for run in runs if run["scenario"] == name]
        row = {"scenario": name, "runs": len(group),
               "probe_seconds": sum(run["duration_s"] for run in group),
               "probes": {probe: merge([run["probes"][probe] for run in group]) for probe in PROBES}}
        if "sampler" in group[0]:
            latencies = [value for run in group for value in run["sampler"]["latency_ms"]]
            row["sampler"] = {
                "cpu_percent": statistics.mean(run["sampler"]["sampler_cpu_percent"] for run in group),
                "observed_rate_hz": statistics.mean(run["sampler"]["observed_rate_hz"] for run in group),
                "burst_p50_ms": statistics.median(latencies),
                "burst_p95_ms": percentile(latencies, 95), "burst_max_ms": max(latencies),
                "late_ticks": sum(run["sampler"]["late_ticks"] for run in group)}
        rows.append(row)
    return rows


def per_minute(row, count):
    return count * 60 / row["probe_seconds"]


def render(summary):
    us = lambda ns: f"{ns / 1000:,.1f}"
    out = ["Sampler (single core): the burst is the time from a tick's stamp to its last datagram.",
           "", "| Scenario | Rate (Hz) | CPU (% of one core) | Burst p50 (ms) | Burst p95 (ms) | Burst max (ms) | Late ticks |",
           "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for row in summary:
        if "sampler" in row:
            s = row["sampler"]
            out.append(f"| {row['scenario']} | {s['observed_rate_hz']:.2f} | {s['cpu_percent']:.3f} | {s['burst_p50_ms']:.2f} | "
                       f"{s['burst_p95_ms']:.2f} | {s['burst_max_ms']:.2f} | {s['late_ticks']} |")
    out += ["", "Spin probe: CPU time lost in gaps of 10 us or more between clock reads.", "",
            "| Scenario | Time lost (% of probe time) | Gaps ≥100 µs per min | Gaps ≥1 ms per min | Gaps ≥10 ms per min | Max gap (µs) |",
            "| --- | ---: | ---: | ---: | ---: | ---: |"]
    for row in summary:
        p = row["probes"]["spin"]
        lost = 100 * p["slow_total_ns"] / (row["probe_seconds"] * 1e9)
        out.append(f"| {row['scenario']} | {lost:.3f} | {per_minute(row, p['over_100us']):.1f} | "
                   f"{per_minute(row, p['over_1ms']):.1f} | {per_minute(row, p['over_10ms']):.1f} | {us(p['max_ns'])} |")
    for probe, title, tail in (("wake", "Wake probe: lateness of a 1 ms timer wake-up (value or less).", 99.9),
                               ("lock", "Lock probe: time to change the signal mask twice (value or less).", 99.99),
                               ("mmap", "Mmap probe: time to map and unmap one page (value or less).", 99.99)):
        out += ["", title, "",
                f"| Scenario | p50 (µs) | p99 (µs) | p{tail} (µs) | Max (µs) | ≥100 µs per min | ≥1 ms per min |",
                "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
        for row in summary:
            p = row["probes"][probe]
            out.append(f"| {row['scenario']} | {us(percentile_ns(p, 50))} | {us(percentile_ns(p, 99))} | "
                       f"{us(percentile_ns(p, tail))} | {us(p['max_ns'])} | "
                       f"{per_minute(row, p['over_100us']):.1f} | {per_minute(row, p['over_1ms']):.1f} |")
    return "\n".join(out)


def choose_cpus(requested):
    if requested is not None:
        if len(requested) != len(ROLES) or not set(requested) <= ALLOWED_CPUS:
            raise ValueError(f"--cpus needs {len(ROLES)} allowed CPUs, one per role: {', '.join(ROLES)}")
        return requested
    allowed = sorted(ALLOWED_CPUS)
    if len(allowed) < len(ROLES):
        raise ValueError(f"{len(ROLES)} CPUs are needed for isolated roles; this process may use "
                         f"{len(allowed)}. Pass --cpus to share CPUs")
    return allowed[-len(ROLES):]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "build/triangulator-sampler")
    parser.add_argument("--scenarios", nargs="+", choices=SCENARIOS, default=list(SCENARIOS))
    parser.add_argument("--threads", type=int, default=500, help="target threads, 5..500")
    parser.add_argument("--duration", type=int, default=30, help="probe seconds per run (at least 2)")
    parser.add_argument("--warmup", type=float, default=5, help="sampler warm-up seconds per run")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--cpus", type=int, nargs="+",
                        help="CPUs for " + ", ".join(ROLES) + " (default: the last six allowed)")
    parser.add_argument("--output", type=Path, default=ROOT / "build/target-impact.json")
    args = parser.parse_args()
    if (not 5 <= args.threads <= 500 or args.duration < 2 or not math.isfinite(args.warmup)
            or args.warmup < 0 or args.repeats < 1 or len(set(args.scenarios)) != len(args.scenarios)):
        parser.error("threads 5..500; duration at least 2; warmup nonnegative; repeats positive; scenarios distinct")
    cpus = choose_cpus(args.cpus)
    os.sched_setaffinity(0, {cpus[ROLES.index("driver")]})
    binary = args.binary.resolve()
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    report = {
        "schema_version": 1, "complete": False,
        "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
        "sampler_sha256": digest(binary), "victim_sha256": digest(VICTIM),
        "driver_sha256": digest(Path(__file__)),
        "build_options": (binary.parent / "build_options").read_text().strip(),
        "kernel": platform.release(), "machine": platform.machine(),
        "cpu_model": next((line.split(":", 1)[1].strip()
                           for line in Path("/proc/cpuinfo").read_text().splitlines()
                           if line.startswith("model name")), platform.machine()),
        "cpu_roles": dict(zip(ROLES, cpus)),
        "threads": args.threads, "duration_s": args.duration, "warmup_s": args.warmup,
        "repeats": args.repeats, "scenarios": args.scenarios, "runs": [], "summary": [],
        "methods": {
            "spin": "gap between consecutive CLOCK_MONOTONIC reads; time lost = sum of gaps of 10 us or more",
            "wake": "lateness after clock_nanosleep to an absolute 1 ms deadline, timer slack 1 ns",
            "lock": "duration of two pthread_sigmask calls that change the mask (process signal lock)",
            "mmap": "duration of mmap plus munmap of one anonymous page (address-space lock)",
            "percentiles": "upper bound of power-of-two buckets, capped at the observed maximum; counts are exact",
            "burst": "last SO_TIMESTAMPNS_NEW kernel arrival minus the tick's wall stamp: rescan, reads, encode, loopback UDP",
        },
    }
    # Rotate the scenario order across repeats to reduce order bias.
    for repeat in range(args.repeats):
        offset = repeat % len(args.scenarios)
        for name in args.scenarios[offset:] + args.scenarios[:offset]:
            print(f"Run {repeat + 1}/{args.repeats}: {name}", file=sys.stderr, flush=True)
            run = trial(name, cpus, binary, args.threads, args.duration, args.warmup)
            run.update(repeat=repeat + 1, duration_s=args.duration)
            report["runs"].append(run)
            report["summary"] = summarize(report["runs"])
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
