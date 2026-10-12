#!/usr/bin/env python3
"""Measure sampler CPU and resident memory while sampling 500 native threads.

Use `make benchmark-sampler` from the repository root.
One target thread burns CPU. The other 499 threads sleep.
The default run takes about 13 minutes. No collector or root access is needed.
"""

import argparse
from collections import Counter
from contextlib import contextmanager
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

from wire import RECORDS_PER_PACKET, decode


ROOT = Path(__file__).resolve().parents[1]
RATES = (1, 2, 5, 10)
TARGET_THREADS = 500
TARGET = ROOT / "build/benchmark-target"


@contextmanager
def child(command, **kwargs):
    process = subprocess.Popen(command, **kwargs)
    try:
        yield process
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()


def cpu_snapshot(pid, whole_process=False):
    # schedstat reports this thread's total CPU execution time in nanoseconds.
    # Sum all target threads. The sampler has one thread. Clock ticks from
    # stat are too coarse for the sampler's small CPU use.
    paths = (Path(f"/proc/{pid}/task").glob("*/schedstat") if whole_process
             else [Path(f"/proc/{pid}/schedstat")])
    runtime_ns = sum(int(path.read_text().split()[0]) for path in paths)
    return time.monotonic_ns(), runtime_ns


def rss_mib(pid):
    # smaps_rollup avoids the approximate RSS counters in stat and status.
    for line in Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines():
        if line.startswith("Rss:"):
            return int(line.split()[1]) / 1024
    raise RuntimeError("smaps_rollup has no Rss field")


def receive(receiver, target_pid, rate):
    data = receiver.recv(65536)
    if data[:4] != b"TMON":
        return data[:4].decode("ascii"), None
    packet = decode(data)
    if (packet.pid != target_pid or packet.flags
            or packet.chunks != TARGET_THREADS // RECORDS_PER_PACKET
            or packet.interval_ms != 1000 // rate):
        raise RuntimeError("sampler did not sample the configured 500-thread target")
    return "TMON", packet


def collect(receiver, sampler, target, rate, duration_s, measure=False):
    sampler_start = cpu_snapshot(sampler.pid)
    target_start = cpu_snapshot(target.pid, whole_process=True)
    deadline = time.monotonic() + duration_s
    next_rss = time.monotonic()
    memory = []
    ticks = []
    datagrams = Counter()
    chunks = {}
    while time.monotonic() < deadline:
        if sampler.poll() is not None or target.poll() is not None:
            raise RuntimeError("sampler or workload exited during the measurement")
        now = time.monotonic()
        if measure and now >= next_rss:
            memory.append(rss_mib(sampler.pid))
            next_rss += 1
        timeout = max(0, min(deadline - now, 0.25))
        if select.select([receiver], [], [], timeout)[0]:
            kind, packet = receive(receiver, target.pid, rate)
            datagrams[kind] += 1
            if packet is not None:
                chunks.setdefault(packet.sequence, {})[packet.chunk] = packet
                parts = chunks[packet.sequence]
                if len(parts) == packet.chunks:
                    records = [record for part in parts.values() for record in part.records]
                    if (len(records) != TARGET_THREADS
                            or len({record.tid for record in records}) != TARGET_THREADS
                            or target.pid not in {record.tid for record in records}):
                        raise RuntimeError("thread sample did not contain all 500 target threads")
                    ticks.append(packet)
                    chunks = {sequence: parts for sequence, parts in chunks.items()
                              if sequence > packet.sequence}
    sampler_end = cpu_snapshot(sampler.pid)
    target_end = cpu_snapshot(target.pid, whole_process=True)
    if not measure:
        return None
    if len(ticks) < 2:
        raise RuntimeError("too few thread samples to verify the frequency")
    if any(right.sequence != left.sequence + 1
           for left, right in zip(ticks, ticks[1:])):
        raise RuntimeError("thread samples were lost")
    elapsed_ns = ticks[-1].monotonic_ns - ticks[0].monotonic_ns
    actual_hz = (len(ticks) - 1) * 1e9 / elapsed_ns
    if abs(actual_hz / rate - 1) > 0.1:
        raise RuntimeError(f"sample frequency was {actual_hz:.3f} Hz, expected {rate} Hz")
    memory.append(rss_mib(sampler.pid))
    cpu_percent = lambda start, end: 100 * (end[1] - start[1]) / (end[0] - start[0])
    return {
        "rate_hz": rate,
        "elapsed_s": (sampler_end[0] - sampler_start[0]) / 1e9,
        "sampler_cpu_time_s": (sampler_end[1] - sampler_start[1]) / 1e9,
        "sampler_cpu_percent": cpu_percent(sampler_start, sampler_end),
        "sampler_rss_mean_mib": statistics.mean(memory),
        "sampler_rss_max_mib": max(memory),
        "rss_observations": len(memory),
        "workload_cpu_percent": cpu_percent(target_start, target_end),
        "observed_rate_hz": actual_hz,
        "thread_ticks": len(ticks),
        "datagrams": dict(datagrams),
    }


def trial(binary, rate, duration_s, warmup_s):
    with tempfile.TemporaryDirectory() as directory, \
            socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver, \
            child([str(TARGET)], stdout=subprocess.PIPE, text=True) as target:
        if not select.select([target.stdout], [], [], 10)[0]:
            raise RuntimeError("workload did not start within 10 seconds")
        if target.stdout.readline().strip() != "500 threads ready":
            raise RuntimeError("workload did not start all 500 threads")
        receiver.bind(("127.0.0.1", 0))
        config = Path(directory) / "sampler.toml"
        config.write_text(
            f'target_pid = {target.pid}\nrate_hz = {rate}\n'
            f'collector = "127.0.0.1:{receiver.getsockname()[1]}"\n'
            'status_fallback = false\nresource_interval_s = 5\nmemory_interval_s = 30\n')
        with open(Path(directory) / "sampler.log", "w+") as log, \
                child([str(binary), str(config)], stdout=subprocess.DEVNULL, stderr=log) as sampler:
            try:
                ready_deadline = time.monotonic() + 10
                while True:
                    if sampler.poll() is not None or target.poll() is not None:
                        raise RuntimeError("sampler or workload exited before the first sample")
                    if time.monotonic() >= ready_deadline:
                        raise RuntimeError("sampler did not send a thread sample within 10 seconds")
                    if select.select([receiver], [], [], 0.1)[0]:
                        if receive(receiver, target.pid, rate)[1] is not None:
                            break
                if len(list(Path(f"/proc/{sampler.pid}/task").iterdir())) != 1:
                    raise RuntimeError("CPU measurement requires a single-thread sampler")
                collect(receiver, sampler, target, rate, warmup_s)
                result = collect(receiver, sampler, target, rate, duration_s, measure=True)
                if duration_s >= 60 and not all(result["datagrams"].get(kind)
                                               for kind in ("TRES", "TVMA")):
                    raise RuntimeError("resource or memory-map samples were missing")
                log.flush()
                log.seek(0)
                if log.read():
                    raise RuntimeError("sampler logged errors or warnings")
                return result
            except (OSError, ValueError, RuntimeError) as error:
                log.seek(0)
                raise RuntimeError(f"{error}; sampler log: {log.read().strip()}") from error


def table(runs):
    lines = ["| Rate | Sampler CPU (% of one core) | Mean RSS (MiB) | Max observed RSS (MiB) |",
             "| --- | ---: | ---: | ---: |"]
    for rate in RATES:
        group = [run for run in runs if run["rate_hz"] == rate]
        cpu = statistics.mean(run["sampler_cpu_percent"] for run in group)
        rss = statistics.mean(run["sampler_rss_mean_mib"] for run in group)
        peak = max(run["sampler_rss_max_mib"] for run in group)
        lines.append(f"| {rate} Hz | {cpu:.3f}% | {rss:.2f} | {peak:.2f} |")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "build/triangulator-sampler")
    parser.add_argument("--duration", type=float, default=60, help="measurement seconds per run (at least 2)")
    parser.add_argument("--warmup", type=float, default=5, help="warm-up seconds per run")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--output", type=Path, default=ROOT / "build/sampler-overhead.json")
    args = parser.parse_args()
    if (not math.isfinite(args.duration) or args.duration < 2
            or not math.isfinite(args.warmup) or args.warmup < 0 or args.repeats < 1):
        parser.error("duration must be at least 2; warmup must be nonnegative; repeats must be positive")
    binary = args.binary.resolve()
    cpu_model = next((line.split(":", 1)[1].strip()
                      for line in Path("/proc/cpuinfo").read_text().splitlines()
                      if line.startswith("model name")), platform.machine())
    report = {
        "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "sampler_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        "build_options": (binary.parent / "build_options").read_text().strip(),
        "kernel": platform.release(), "machine": platform.machine(), "cpu_model": cpu_model,
        "allowed_cpus": sorted(os.sched_getaffinity(0)), "python": platform.python_version(),
        "duration_s": args.duration, "warmup_s": args.warmup, "repeats": args.repeats,
        "target_threads": TARGET_THREADS, "busy_threads": 1, "sleeping_threads": 499,
        "resource_interval_s": 5, "memory_interval_s": 30,
        "status_fallback": False, "runs": [],
        "cpu_method": "100 * delta schedstat runtime_ns / delta monotonic_ns; sum all target threads",
        "workload_sha256": hashlib.sha256(TARGET.read_bytes()).hexdigest(),
        "memory_method": "smaps_rollup Rss, sampled each second and at the end; MiB = 1024 KiB",
    }
    # Interleave rates so one frequency does not always run on a cold host.
    for repeat in range(args.repeats):
        for rate in RATES:
            print(f"Run {repeat + 1}/{args.repeats}: {rate} Hz", file=sys.stderr, flush=True)
            run = trial(binary, rate, args.duration, args.warmup)
            run["repeat"] = repeat + 1
            report["runs"].append(run)
            print(f"  CPU {run['sampler_cpu_percent']:.3f}%; RSS {run['sampler_rss_mean_mib']:.2f} MiB; "
                  f"workload CPU {run['workload_cpu_percent']:.1f}%", file=sys.stderr, flush=True)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(table(report["runs"]))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(f"benchmark failed: {error}", file=sys.stderr)
        sys.exit(1)
