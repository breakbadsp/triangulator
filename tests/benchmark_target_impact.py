#!/usr/bin/env python3
"""Measure how much the sampler disturbs the process it samples.

Use `make benchmark-target-impact`. The target is build/benchmark-victim: sleeping
threads plus four probe threads, each pinned to its own core, that measure CPU time
lost to other work (spin), wake-up lateness (wake), signal-lock waits (lock) and
address-space-lock waits (mmap). Each scenario runs the real sampler against it,
pinned apart from the probes or sharing a probe's core, and is compared with the
`off` scenario, which has no sampler. Sampler CPU and thread-sample latency come
from the same runs; the latency excludes the resource and memory-map work that
follows the thread sample in a tick. Needs six CPUs, or pass --cpus (repeats allowed,
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
from typing import NamedTuple
import time

from benchmark_sampler import (KMSG_NOTICE, MEMORY_INTERVAL_S, ROOT, SO_TIMESTAMPNS_NEW,
                               SampleStream, child, collect, cpu_snapshot, percentile, wait_sample)

VICTIM = ROOT / "build/benchmark-victim"
# Reads the whole maps file again and again, 4 KiB per read() like the sampler.
MAPS_LOOP = """
import os, sys
path = f"/proc/{sys.argv[1]}/maps"
while True:
    fd = os.open(path, os.O_RDONLY)
    while os.read(fd, 4096):
        pass
    os.close(fd)
"""
ALLOWED_CPUS = frozenset(os.sched_getaffinity(0))
ROLES = ("spin", "wake", "lock", "mmap", "sampler", "driver")
# Keep the historical baseline explicit when comparing interval changes.
RESOURCE_INTERVAL_S = 5


class Scenario(NamedTuple):
    rate: float | None  # thread rate in Hz; None for no sampler
    core: str | None  # role whose core the sampler uses
    memory_interval_s: int = MEMORY_INTERVAL_S
    nice: int = 0
    resource_interval_s: int = RESOURCE_INTERVAL_S
    maps_loop: bool = False  # no sampler; a loop reads /proc/PID/maps without pause


SCENARIOS = {
    "off": Scenario(None, None),
    # Upper bound for the memory-map lock: a reader that does nothing but read
    # maps in the sampler's 4 KiB reads, so the lock is taken at the highest
    # rate one core can manage. A sampler reading every N seconds holds the lock
    # a small fraction of that.
    "maps-loop": Scenario(None, "sampler", maps_loop=True),
    "apart-1hz": Scenario(1, "sampler"),
    "apart-10hz": Scenario(10, "sampler"),
    "apart-10hz-maps-1s": Scenario(10, "sampler", memory_interval_s=1),
    "shared-spin-1hz": Scenario(1, "spin"),
    "shared-spin-10hz": Scenario(10, "spin"),
    "shared-spin-10hz-nice19": Scenario(10, "spin", nice=19),
    "shared-wake-10hz": Scenario(10, "wake"),
    "shared-wake-10hz-nice19": Scenario(10, "wake", nice=19),
    # Resource and memory-map intervals at 5 Hz. apart-5hz keeps the old
    # 5 s resource baseline; apart-5hz-res-2s uses the current defaults.
    "apart-5hz": Scenario(5, "sampler"),
    "apart-5hz-res-2s": Scenario(5, "sampler", resource_interval_s=2),
    "apart-5hz-res-1s": Scenario(5, "sampler", resource_interval_s=1),
    "apart-5hz-maps-10s": Scenario(5, "sampler", memory_interval_s=10),
    "apart-5hz-maps-5s": Scenario(5, "sampler", memory_interval_s=5),
    "apart-5hz-maps-1s": Scenario(5, "sampler", memory_interval_s=1),
    "shared-spin-5hz": Scenario(5, "spin"),
    "shared-spin-5hz-res-1s": Scenario(5, "spin", resource_interval_s=1),
    "shared-spin-5hz-maps-5s": Scenario(5, "spin", memory_interval_s=5),
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


def trial(name, cpus, binary, threads, duration_s, warmup_s, victim_options=()):
    rate, sampler_role, memory_interval_s, nice, resource_interval_s, maps_loop = SCENARIOS[name]
    by_role = dict(zip(ROLES, cpus))
    with tempfile.TemporaryDirectory() as directory, \
            socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver, \
            child([str(VICTIM), str(threads), str(duration_s), *map(str, cpus[:4]), *victim_options],
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
        if rate is None and maps_loop:
            with child([sys.executable, "-c", MAPS_LOOP, str(victim.pid)],
                       preexec_fn=lambda: os.sched_setaffinity(0, {by_role[sampler_role]})) as reader:
                time.sleep(1)
                reader_start = cpu_snapshot(reader.pid)
                start()
                probes = read_probes(victim, duration_s + 10)
                reader_end = cpu_snapshot(reader.pid)
                return {"scenario": name, "probes": probes, "maps_loop_cpu_percent":
                        100 * (reader_end[1] - reader_start[1]) / (reader_end[0] - reader_start[0])}
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
            f'status_fallback = false\nresource_interval_s = {resource_interval_s}\n'
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
        if "maps_loop_cpu_percent" in group[0]:
            row["maps_loop_cpu_percent"] = statistics.mean(run["maps_loop_cpu_percent"] for run in group)
        if "sampler" in group[0]:
            latencies = [value for run in group for value in run["sampler"]["latency_ms"]]
            row["sampler"] = {
                "cpu_percent": statistics.mean(run["sampler"]["sampler_cpu_percent"] for run in group),
                "observed_rate_hz": statistics.mean(run["sampler"]["observed_rate_hz"] for run in group),
                "sample_latency_p50_ms": statistics.median(latencies),
                "sample_latency_p95_ms": percentile(latencies, 95),
                "sample_latency_max_ms": max(latencies),
                "late_ticks": sum(run["sampler"]["late_ticks"] for run in group)}
        rows.append(row)
    return rows


def per_minute(row, count):
    return count * 60 / row["probe_seconds"]


def render(summary):
    us = lambda ns: f"{ns / 1000:,.1f}"
    out = ["Sampler (single core): thread-sample latency is the time from a tick's stamp to its last",
           "thread-sample datagram. It excludes resource and memory-map work, which follows in the tick.",
           "", "| Scenario | Rate (Hz) | CPU (% of one core) | Latency p50 (ms) | Latency p95 (ms) | Latency max (ms) | Late ticks |",
           "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for row in summary:
        if "sampler" in row:
            s = row["sampler"]
            out.append(f"| {row['scenario']} | {s['observed_rate_hz']:.2f} | {s['cpu_percent']:.3f} | {s['sample_latency_p50_ms']:.2f} | "
                       f"{s['sample_latency_p95_ms']:.2f} | {s['sample_latency_max_ms']:.2f} | {s['late_ticks']} |")
    for row in summary:
        if "maps_loop_cpu_percent" in row:
            out += ["", f"{row['scenario']}: the maps reader used {row['maps_loop_cpu_percent']:.1f}% of its core."]
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
    parser.add_argument("--victim-options", nargs="*", default=[], metavar="OPTION",
                        help="give the target mappings, files and sockets, for example "
                             "mappings=5000 files=300 sockets=100")
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
        "repeats": args.repeats, "scenarios": args.scenarios,
        "victim_options": args.victim_options, "runs": [], "summary": [],
        "methods": {
            "spin": "gap between consecutive CLOCK_MONOTONIC reads; time lost = sum of gaps of 10 us or more",
            "wake": "lateness after clock_nanosleep to an absolute 1 ms deadline, timer slack 1 ns",
            "lock": "duration of two pthread_sigmask calls that change the mask (process signal lock)",
            "mmap": "duration of mmap plus munmap of one anonymous page (address-space lock)",
            "percentiles": "upper bound of power-of-two buckets, capped at the observed maximum; counts are exact",
            "sample_latency": ("last thread-sample (TMON) SO_TIMESTAMPNS_NEW kernel arrival minus the tick's wall "
                               "stamp: rescan, reads, encode, loopback UDP; excludes the resource (TRES) and "
                               "memory-map (TVMA) work that follows in the same tick"),
        },
    }
    # Rotate the scenario order across repeats to reduce order bias.
    for repeat in range(args.repeats):
        offset = repeat % len(args.scenarios)
        for name in args.scenarios[offset:] + args.scenarios[:offset]:
            print(f"Run {repeat + 1}/{args.repeats}: {name}", file=sys.stderr, flush=True)
            run = trial(name, cpus, binary, args.threads, args.duration, args.warmup, args.victim_options)
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
