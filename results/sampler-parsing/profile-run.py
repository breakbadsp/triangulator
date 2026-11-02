#!/usr/bin/env python3
"""Compare sampler binaries on one host with 16 live 50-thread targets."""
import argparse
from collections import Counter
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import tempfile
import time

from benchmark_sampler import ROOT, child
from wire import decode


def snapshot(pid):
    return time.monotonic_ns(), int(Path(f"/proc/{pid}/schedstat").read_text().split()[0])


def trial(binary, name, pids, threads, receiver, config, duration, warmup, sampler_cpu, profile):
    config.write_text(f'process_names = ["{name}"]\nmax_targets = 16\n'
                      f'collector = "127.0.0.1:{receiver.getsockname()[1]}"\n'
                      'rate_hz = 5.0\ncpu_budget_pct = 100.0\n'
                      'status_fallback = false\nresource_interval_s = 2\nmemory_interval_s = 30\n')
    while select.select([receiver], [], [], 0)[0]:
        receiver.recv(65535)
    with tempfile.TemporaryFile(mode="w+") as log, child(
        [str(binary), str(config)], stdout=subprocess.DEVNULL, stderr=log,
        preexec_fn=lambda: os.sched_setaffinity(0, {sampler_cpu}),
    ) as sampler:
        start = time.monotonic_ns() + round(warmup * 1e9)
        end = start + round(duration * 1e9)
        before = after = None
        perf = None
        perf_log = open(str(profile) + ".log", "w")
        parts = {}
        last = {}
        completed = Counter()
        sessions = {}
        max_lag_ms = 0.0
        while time.monotonic_ns() < end + 1_000_000_000:
            now = time.monotonic_ns()
            if before is None and now >= start:
                before = snapshot(sampler.pid)
                perf = subprocess.Popen(["perf", "record", "-e", "cycles:u", "-F", "999", "-p", str(sampler.pid), "-o", str(profile)], stdout=perf_log, stderr=perf_log)
            if after is None and now >= end:
                after = snapshot(sampler.pid)
                perf.send_signal(2)
                perf.wait(timeout=10)
                perf_log.close()
                if perf.returncode not in (0, 130, -2):
                    raise RuntimeError(f"perf failed: {Path(str(profile) + ".log").read_text()}")
            if sampler.poll() is not None:
                raise RuntimeError("sampler exited before measurement completed")
            if not select.select([receiver], [], [], 0.05)[0]:
                continue
            data = receiver.recv(65535)
            if data[:4] != b"TMON":
                continue
            packet = decode(data)
            if packet.flags and not packet.pid:
                continue
            if packet.flags or packet.pid not in pids or packet.interval_ms != 200:
                raise RuntimeError(f"unexpected thread packet: {packet}")
            key = packet.pid, packet.session, packet.sequence
            if packet.pid in sessions and sessions[packet.pid] != packet.session:
                raise RuntimeError("target session changed")
            sessions[packet.pid] = packet.session
            previous = parts.setdefault(key, {})
            if packet.chunk in previous:
                raise RuntimeError("duplicate packet chunk")
            previous[packet.chunk] = packet
            if len(previous) != packet.chunks:
                continue
            records = [record for part in previous.values() for record in part.records]
            if len(records) != threads or {record.tid for record in records} != pids[packet.pid]:
                raise RuntimeError("incomplete or duplicate thread records")
            if packet.pid in last and packet.sequence != last[packet.pid] + 1:
                raise RuntimeError("lost thread sample")
            last[packet.pid] = packet.sequence
            del parts[key]
            if start <= packet.monotonic_ns < end:
                completed[packet.pid] += 1
                max_lag_ms = max(max_lag_ms, (time.time_ns() - packet.wall_ns) / 1e6)
        if before is None or after is None or len(completed) != len(pids):
            raise RuntimeError(f"missing CPU or target samples: {len(completed)}/{len(pids)}")
        if min(completed.values()) < int(duration * 5) - 2:
            raise RuntimeError(f"target did not sustain 5 Hz: {dict(completed)}")
        log.seek(0)
        messages = log.read()
        if any(word in messages.lower() for word in ("failed", "overflow", "dropped")):
            raise RuntimeError(f"sampler warning: {messages}")
        return {"cpu_percent": 100 * (after[1] - before[1]) / (after[0] - before[0]),
                "samples_per_target_min": min(completed.values()),
                "samples_per_target_max": max(completed.values()),
                "target_count": len(completed), "threads_per_target": threads,
                "max_receive_loop_lag_ms": max_lag_ms, "schedstat_before": before, "schedstat_after": after}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", required=True, type=Path)
    parser.add_argument("--after", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--duration", type=float, default=10)
    parser.add_argument("--warmup", type=float, default=5)
    parser.add_argument("--repeats", type=int, default=2)
    args = parser.parse_args()
    if args.duration < 2 or args.warmup < 2 or args.repeats < 1:
        parser.error("duration and warmup must be at least 2 seconds; repeats must be positive")
    cpus = sorted(os.sched_getaffinity(0))
    if len(cpus) < 3:
        parser.error("three CPUs are required for target, sampler, and receiver")
    target_cpu, receiver_cpu, sampler_cpu = cpus[0], cpus[1], cpus[2]
    os.sched_setaffinity(0, {receiver_cpu})
    binaries = {"before": args.before.resolve(), "after": args.after.resolve()}
    with tempfile.TemporaryDirectory(prefix="tri-perf-") as temporary, ExitStack() as stack:
        directory = Path(temporary)
        name = f"tp{os.getpid()}"
        workload = directory / name
        workload.symlink_to(ROOT / "build/benchmark-victim")
        zero = stack.enter_context(open("/dev/zero", "rb"))
        targets = []
        for _ in range(16):
            target = stack.enter_context(child(
                [str(workload), "50", "1", "-1", "-1", "-1", "-1"],
                stdin=zero, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                preexec_fn=lambda: os.sched_setaffinity(0, {target_cpu})))
            if not select.select([target.stdout], [], [], 15)[0] or target.stdout.readline().strip() != "50 threads ready":
                raise RuntimeError("target did not become ready")
            targets.append(target)
        pids = {target.pid: {int(p.name) for p in Path(f"/proc/{target.pid}/task").iterdir()}
                for target in targets}
        if any(len(tids) != 50 for tids in pids.values()):
            raise RuntimeError("target thread count changed")
        receiver = stack.enter_context(socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
        receiver.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
        receiver.bind(("127.0.0.1", 0))
        results = []
        for repeat in range(args.repeats):
            order = ("before", "after") if repeat % 2 == 0 else ("after", "before")
            for label in order:
                row = trial(binaries[label], name, pids, 50, receiver, directory / "sampler.toml",
                            args.duration, args.warmup, sampler_cpu, ROOT / "build" / f"profile-{label}-{repeat + 1}.data")
                row.update(label=label, repeat=repeat + 1)
                results.append(row)
                print(f"{label} repeat {repeat + 1}: {row['cpu_percent']:.3f}% CPU, "
                      f"{row['samples_per_target_min']}..{row['samples_per_target_max']} ticks", flush=True)
        report = {"results": results, "duration_s": args.duration, "warmup_s": args.warmup,
                  "cpu_assignment": {"target": target_cpu, "receiver": receiver_cpu, "sampler": sampler_cpu},
                  "sha256": {label: hashlib.sha256(path.read_bytes()).hexdigest()
                             for label, path in binaries.items()}}
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n")


if __name__ == "__main__":
    main()
