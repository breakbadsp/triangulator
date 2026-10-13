#!/usr/bin/env python3
"""Measure sampler CPU, RSS, complete-sample latency, and delivered throughput.

Use `make benchmark-sampler-matrix` for 100, 300, and 500 threads at four rates.
One target thread burns CPU. All other target threads sleep. No root is needed.
Latency uses kernel receive timestamps (`SO_TIMESTAMPNS_NEW`), which need
Linux 5.1 or later (or a vendor backport). Older kernels, such as the 4.18
kernel in AlmaLinux 8, fail with "kernel receive timestamp is missing".
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
import struct
import subprocess
import sys
import tempfile
import time

from wire import RECORDS_PER_PACKET, decode

ROOT = Path(__file__).resolve().parents[1]
RATES = (1, 2, 5, 10)
TARGET_THREADS = 500
TARGET = ROOT / "build/benchmark-target"
MEMORY_INTERVAL_S = 30
# Linux UAPI asm-generic/socket.h (x86 and arm64; alpha, mips, sparc, and
# parisc use other values). NEW uses two signed 64-bit integers on both 32- and
# 64-bit hosts and needs Linux 5.1 or later. Python does not expose this
# constant everywhere.
SO_TIMESTAMPNS_NEW = 64
TIMESPEC = struct.Struct("=qq")
# The sampler warns once when kernel.dmesg_restrict hides /dev/kmsg. That only
# removes kernel messages from exit reports; sampling is unaffected.
KMSG_NOTICE = "triangulator: kernel log (/dev/kmsg) not readable: "


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
    # schedstat reports execution time in nanoseconds. stat clock ticks are
    # too coarse for this sampler. The production sampler has one thread.
    paths = (Path(f"/proc/{pid}/task").glob("*/schedstat") if whole_process
             else [Path(f"/proc/{pid}/schedstat")])
    runtime_ns = sum(int(path.read_text().split()[0]) for path in paths)
    return time.monotonic_ns(), runtime_ns


def rss_mib(pid):
    for line in Path(f"/proc/{pid}/smaps_rollup").read_text().splitlines():
        if line.startswith("Rss:"):
            return int(line.split()[1]) / 1024
    raise RuntimeError("smaps_rollup has no Rss field")


def percentile(values, percent):
    """Nearest-rank percentile. Keep measured observations without interpolation."""
    return sorted(values)[max(0, math.ceil(len(values) * percent / 100) - 1)]


class SampleStream:
    """Validate every complete tick, including warm-up and window boundaries."""

    def __init__(self, receiver, target_pid, rate, thread_ids):
        self.receiver = receiver
        self.target_pid = target_pid
        self.rate = rate
        self.thread_ids = thread_ids
        self.parts = {}
        self.arrivals = []
        self.last = None
        self.datagrams = Counter()
        self.bytes = 0

    def receive(self):
        data, ancillary, flags, _ = self.receiver.recvmsg(65536, socket.CMSG_SPACE(TIMESPEC.size))
        if flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC):
            raise RuntimeError("truncated UDP data or timestamp")
        arrival_ns = None
        for level, kind, value in ancillary:
            if level == socket.SOL_SOCKET and kind == SO_TIMESTAMPNS_NEW:
                seconds, nanoseconds = TIMESPEC.unpack(value)
                arrival_ns = seconds * 10**9 + nanoseconds
        if arrival_ns is None:
            raise RuntimeError("kernel receive timestamp is missing")
        kind = data[:4].decode("ascii")
        if kind not in ("TMON", "TRES", "TVMA"):
            raise RuntimeError("unexpected datagram")
        self.datagrams[kind] += 1
        self.bytes += len(data)
        if kind != "TMON":
            return None
        packet = decode(data)
        chunks = math.ceil(len(self.thread_ids) / RECORDS_PER_PACKET)
        if (packet.pid != self.target_pid or packet.flags or packet.chunks != chunks
                or packet.interval_ms != 1000 // self.rate):
            raise RuntimeError("sampler did not sample the configured target")
        if self.parts and packet.signature != next(iter(self.parts.values())).signature:
            raise RuntimeError("incomplete thread sample before the next tick")
        if packet.chunk in self.parts:
            raise RuntimeError("duplicate thread sample chunk")
        self.parts[packet.chunk] = packet
        self.arrivals.append(arrival_ns)
        if len(self.parts) != chunks:
            return None
        records = [record for part in self.parts.values() for record in part.records]
        if len(records) != len(self.thread_ids) or {record.tid for record in records} != self.thread_ids:
            raise RuntimeError("thread sample did not contain all target thread IDs")
        if self.last is not None:
            if packet.session != self.last.session or packet.sequence != self.last.sequence + 1:
                raise RuntimeError("thread samples were lost or the sampler session changed")
            # A late tick is an observation, not a failure: collect() counts it.
            # Only a backwards clock or a lost tick (sequence check above) aborts.
            if packet.monotonic_ns <= self.last.monotonic_ns:
                raise RuntimeError("sample monotonic time did not advance")
        latency_ns = max(self.arrivals) - packet.wall_ns
        if latency_ns < 0:
            raise RuntimeError("sample arrived before it was stamped")
        self.last = packet
        self.parts.clear()
        self.arrivals.clear()
        return packet, latency_ns / 1e6


def wait_sample(stream, sampler, target, deadline):
    while time.monotonic() < deadline:
        if sampler.poll() is not None or target.poll() is not None:
            raise RuntimeError("sampler or workload exited before the next sample")
        if select.select([stream.receiver], [], [], min(0.1, max(0, deadline - time.monotonic())))[0]:
            sample = stream.receive()
            if sample is not None:
                return sample
    raise RuntimeError("sampler did not send a complete thread sample in time")


def count_late(packets, latencies_ms, rate):
    """Count ticks that started over 1.5 periods after the previous tick and
    complete-sample latencies of at least one period. Both are reported, not
    rejected, so a bad tail appears in the distribution."""
    late_ticks = sum(b.monotonic_ns - a.monotonic_ns > 1.5e9 / rate
                     for a, b in zip(packets, packets[1:]))
    return late_ticks, sum(value >= 1e3 / rate for value in latencies_ms)


def collect(stream, sampler, target, duration_s, rate_tolerance=0.1):
    sampler_start = cpu_snapshot(sampler.pid)
    target_start = cpu_snapshot(target.pid, whole_process=True)
    start_ns = time.monotonic_ns()
    end_ns = start_ns + round(duration_s * 1e9)
    next_rss_ns = start_ns
    memory = []
    samples = []
    datagrams_start = stream.datagrams.copy()
    bytes_start = stream.bytes
    while time.monotonic_ns() < end_ns:
        if sampler.poll() is not None or target.poll() is not None:
            raise RuntimeError("sampler or workload exited during the measurement")
        now_ns = time.monotonic_ns()
        if now_ns >= next_rss_ns:
            memory.append(rss_mib(sampler.pid))
            next_rss_ns += 10**9
        timeout = max(0, min((end_ns - now_ns) / 1e9, 0.1))
        if select.select([stream.receiver], [], [], timeout)[0]:
            sample = stream.receive()
            if sample is not None and start_ns <= sample[0].monotonic_ns < end_ns:
                samples.append(sample)
    sampler_end = cpu_snapshot(sampler.pid)
    target_end = cpu_snapshot(target.pid, whole_process=True)
    datagrams = stream.datagrams - datagrams_start
    received_bytes = stream.bytes - bytes_start
    memory.append(rss_mib(sampler.pid))
    # Read the first complete tick beyond the window. This detects a lost
    # trailing tick and completes a sample split by the measurement boundary.
    drain_deadline = time.monotonic() + 2 / stream.rate + 1
    while True:
        sample = wait_sample(stream, sampler, target, drain_deadline)
        if sample[0].monotonic_ns >= end_ns:
            break
        if sample[0].monotonic_ns >= start_ns:
            samples.append(sample)
    if len(samples) < 2:
        raise RuntimeError("too few thread samples to verify the frequency")
    packets, latencies = zip(*samples)
    elapsed_ns = packets[-1].monotonic_ns - packets[0].monotonic_ns
    actual_hz = (len(packets) - 1) * 1e9 / elapsed_ns
    if abs(actual_hz / stream.rate - 1) > rate_tolerance:
        raise RuntimeError(f"sample frequency was {actual_hz:.3f} Hz, expected {stream.rate} Hz")
    # Compare wall and monotonic clocks across the window. Abort on a wall
    # clock step rather than presenting it as a latency observation.
    clock_error_ns = abs((packets[-1].wall_ns - packets[0].wall_ns) - elapsed_ns)
    if clock_error_ns > 100_000:
        raise RuntimeError("wall clock changed relative to the monotonic clock")
    late_ticks, latencies_over_period = count_late(packets, latencies, stream.rate)
    cpu_percent = lambda start, end: 100 * (end[1] - start[1]) / (end[0] - start[0])
    thread_count = len(stream.thread_ids)
    return {
        "target_threads": thread_count, "rate_hz": stream.rate,
        "elapsed_s": (sampler_end[0] - sampler_start[0]) / 1e9,
        "sampler_cpu_time_s": (sampler_end[1] - sampler_start[1]) / 1e9,
        "sampler_cpu_percent": cpu_percent(sampler_start, sampler_end),
        "sampler_rss_mean_mib": statistics.mean(memory),
        "sampler_rss_max_mib": max(memory), "rss_observations": len(memory),
        "workload_cpu_percent": cpu_percent(target_start, target_end),
        "observed_rate_hz": actual_hz, "thread_ticks": len(packets),
        "thread_records": len(packets) * thread_count,
        "thread_records_per_s": thread_count * actual_hz,
        "latency_p50_ms": statistics.median(latencies),
        "latency_p95_ms": percentile(latencies, 95), "latency_max_ms": max(latencies),
        "latency_ms": list(latencies), "clock_error_ns": clock_error_ns,
        "late_ticks": late_ticks, "latencies_over_period": latencies_over_period,
        "max_tick_gap_ms": max(b.monotonic_ns - a.monotonic_ns
                               for a, b in zip(packets, packets[1:])) / 1e6,
        "datagrams": dict(datagrams), "received_udp_payload_bytes": received_bytes,
    }


def trial(binary, rate, duration_s, warmup_s, thread_count=TARGET_THREADS):
    with tempfile.TemporaryDirectory() as directory, \
            socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver, \
            child([str(TARGET), str(thread_count)], stdout=subprocess.PIPE, text=True) as target:
        if not select.select([target.stdout], [], [], 10)[0]:
            raise RuntimeError("workload did not start within 10 seconds")
        if target.stdout.readline().strip() != f"{thread_count} threads ready":
            raise RuntimeError("workload did not start all target threads")
        thread_ids = {int(path.name) for path in Path(f"/proc/{target.pid}/task").iterdir()}
        if len(thread_ids) != thread_count:
            raise RuntimeError("target thread count differs from the requested count")
        receiver.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
        receiver.setsockopt(socket.SOL_SOCKET, SO_TIMESTAMPNS_NEW, 1)
        receiver.bind(("127.0.0.1", 0))
        config = Path(directory) / "sampler.toml"
        config.write_text(
            f'target_pid = {target.pid}\nrate_hz = {rate}\n'
            f'collector = "127.0.0.1:{receiver.getsockname()[1]}"\n'
            f'status_fallback = false\nresource_interval_s = 5\nmemory_interval_s = {MEMORY_INTERVAL_S}\n')
        with open(Path(directory) / "sampler.log", "w+") as log, \
                child([str(binary), str(config)], stdout=subprocess.DEVNULL, stderr=log) as sampler:
            try:
                stream = SampleStream(receiver, target.pid, rate, thread_ids)
                wait_sample(stream, sampler, target, time.monotonic() + 10)
                if len(list(Path(f"/proc/{sampler.pid}/task").iterdir())) != 1:
                    raise RuntimeError("CPU measurement requires a single-thread sampler")
                warmup_end = time.monotonic() + warmup_s
                while time.monotonic() < warmup_end:
                    wait_sample(stream, sampler, target, warmup_end + 2 / rate)
                result = collect(stream, sampler, target, duration_s)
                result["receive_buffer_bytes"] = receiver.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF)
                # Count from launch (warm-up included): the memory-map timer starts
                # when the sampler starts, so one interval fits with margin.
                if warmup_s + duration_s > MEMORY_INTERVAL_S and not all(
                        stream.datagrams[kind] for kind in ("TRES", "TVMA")):
                    raise RuntimeError("resource or memory-map samples were missing")
                log.flush()
                log.seek(0)
                if any(line and not line.startswith(KMSG_NOTICE) for line in log.read().splitlines()):
                    raise RuntimeError("sampler logged errors or warnings")
                return result
            except (OSError, ValueError, RuntimeError) as error:
                log.seek(0)
                raise RuntimeError(f"{error}; sampler log: {log.read().strip()}") from error


def table(runs):
    lines = ["| Threads | Rate | p50 latency (ms) | p95 latency (ms) | Thread records/s | CPU (% of one core) | RSS (MiB) |",
             "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |"]
    for count, rate in sorted({(run["target_threads"], run["rate_hz"]) for run in runs}):
        group = [run for run in runs if (run["target_threads"], run["rate_hz"]) == (count, rate)]
        latencies = [value for run in group for value in run["latency_ms"]]
        mean = lambda name: statistics.mean(run[name] for run in group)
        lines.append(f"| {count} | {rate} Hz | {statistics.median(latencies):.3f} | "
                     f"{percentile(latencies, 95):.3f} | {mean('thread_records_per_s'):.1f} | "
                     f"{mean('sampler_cpu_percent'):.3f}% | {mean('sampler_rss_mean_mib'):.2f} |")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "build/triangulator-sampler")
    parser.add_argument("--duration", type=float, default=60, help="measurement seconds per run (at least 2)")
    parser.add_argument("--warmup", type=float, default=5, help="warm-up seconds per run")
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--threads", type=int, nargs="+", default=[500])
    parser.add_argument("--rates", type=int, nargs="+", choices=RATES, default=list(RATES))
    parser.add_argument("--output", type=Path, default=ROOT / "build/sampler-benchmark.json")
    args = parser.parse_args()
    if (not math.isfinite(args.duration) or args.duration < 2
            or not math.isfinite(args.warmup) or args.warmup < 0 or args.repeats < 1):
        parser.error("duration must be at least 2; warmup must be nonnegative; repeats must be positive")
    if any(not 1 <= count <= 500 for count in args.threads) or len(set(args.threads)) != len(args.threads):
        parser.error("threads must be distinct integers from 1 to 500")
    if len(set(args.rates)) != len(args.rates):
        parser.error("rates must be distinct")
    binary = args.binary.resolve()
    cpu_model = next((line.split(":", 1)[1].strip()
                      for line in Path("/proc/cpuinfo").read_text().splitlines()
                      if line.startswith("model name")), platform.machine())
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    report = {
        "schema_version": 2, "complete": False,
        "measured_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "source_dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
        "sampler_source_tree": subprocess.check_output(
            ["git", "ls-tree", "HEAD", "sampler", "common"], cwd=ROOT, text=True).strip(),
        "sampler_sha256": digest(binary), "workload_sha256": digest(TARGET),
        "driver_sha256": digest(Path(__file__)), "workload_source_sha256": digest(ROOT / "tests/benchmark_target.cpp"),
        "build_options": (binary.parent / "build_options").read_text().strip(),
        "kernel": platform.release(), "machine": platform.machine(), "cpu_model": cpu_model,
        "allowed_cpus": sorted(os.sched_getaffinity(0)), "python": platform.python_version(),
        "duration_s": args.duration, "warmup_s": args.warmup, "repeats": args.repeats,
        "thread_counts": args.threads, "rates_hz": args.rates,
        "busy_threads": 1, "resource_interval_s": 5, "memory_interval_s": MEMORY_INTERVAL_S,
        "status_fallback": False, "runs": [],
        "cpu_method": "100 * delta schedstat runtime_ns / delta monotonic_ns; sum all target threads",
        "memory_method": "smaps_rollup Rss each second and at end; MiB = 1024 KiB; excludes kernel allocations",
        "latency_method": "last SO_TIMESTAMPNS_NEW kernel arrival - TMON wall_ns; includes rescan, proc reads, encode, loopback UDP; excludes receiver scheduling and subsequent resource/map work",
        "throughput_method": "thread count * (complete ticks - 1) / (last - first TMON monotonic time); delivered records/s, not saturation capacity",
        "percentile_method": "pooled observations across repeats; median p50; nearest-rank p95",
    }
    # Rotate all count/rate pairs across repeats to reduce order bias.
    pairs = [(count, rate) for rate in args.rates for count in args.threads]
    for repeat in range(args.repeats):
        offset = repeat * len(args.threads) % len(pairs)
        for count, rate in pairs[offset:] + pairs[:offset]:
            print(f"Run {repeat + 1}/{args.repeats}: {count} threads / {rate} Hz", file=sys.stderr, flush=True)
            run = trial(binary, rate, args.duration, args.warmup, count)
            run["repeat"] = repeat + 1
            report["runs"].append(run)
            print(f"  p50 {run['latency_p50_ms']:.3f} ms; p95 {run['latency_p95_ms']:.3f} ms; "
                  f"CPU {run['sampler_cpu_percent']:.3f}%; RSS {run['sampler_rss_mean_mib']:.2f} MiB",
                  file=sys.stderr, flush=True)
            report["complete"] = len(report["runs"]) == len(pairs) * args.repeats
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(table(report["runs"]))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError) as error:
        print(f"benchmark failed: {error}", file=sys.stderr)
        sys.exit(1)
