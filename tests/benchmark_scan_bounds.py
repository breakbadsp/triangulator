#!/usr/bin/env python3
"""Measure tick latency and sampler CPU on a large host.

Many idle processes fill /proc, and one target is configured by name.
Without a per-tick scan bound, the name lookup delays the ticks. The
result is one JSON line.

Latency is the time from the tick start (the monotonic time in the packet)
to the arrival of its last chunk. Both clocks are CLOCK_MONOTONIC of this
host. No root is needed.
"""

import argparse
import json
import os
from pathlib import Path
import socket
import statistics
import struct
import subprocess
import sys
import tempfile
import time

from wire import decode

ROOT = Path(__file__).resolve().parents[1]
NAME = "tri-scan-target"
# Sets the name, then reports and waits.
TARGET = """
import ctypes, time
ctypes.CDLL(None).prctl(15, b"%s", 0, 0, 0)
print("ready", flush=True)
time.sleep(3600)
""" % NAME


def cpu_seconds(pid):
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    return (int(fields[11]) + int(fields[12])) / os.sysconf("SC_CLK_TCK")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, default=ROOT / "build/triangulator-sampler")
    parser.add_argument("--processes", type=int, default=4000)
    parser.add_argument("--rate", type=int, default=10)
    parser.add_argument("--duration", type=float, default=20)
    arguments = parser.parse_args()

    idle = [subprocess.Popen(["sleep", "3600"]) for _ in range(arguments.processes)]
    target = subprocess.Popen([sys.executable, "-c", TARGET],
                              stdout=subprocess.PIPE, text=True)
    sampler = None
    try:
        if target.stdout.readline().strip() != "ready":
            sys.exit("target did not start")
        receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        receiver.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
        receiver.bind(("127.0.0.1", 0))
        receiver.settimeout(5)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "sampler.toml"
            config.write_text(
                f'process_names = ["{NAME}"]\nrate_hz = {arguments.rate}\n'
                f'collector = "127.0.0.1:{receiver.getsockname()[1]}"\n'
                'resource_interval_s = 2\nmemory_interval_s = 0\ncpu_budget_pct = 100\n')
            sampler = subprocess.Popen([str(arguments.binary), str(config)],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            warmup_end = time.monotonic() + 3
            while time.monotonic() < warmup_end:
                receiver.recv(65536)
            cpu_start, wall_start = cpu_seconds(sampler.pid), time.monotonic()
            latencies, starts, resources = [], [], 0
            end = wall_start + arguments.duration
            while time.monotonic() < end:
                data = receiver.recv(65536)
                arrival = time.monotonic_ns()
                if data[:4] == b"TRES":
                    resources += 1
                if data[:4] != b"TMON":
                    continue
                packet = decode(data)
                if packet.pid != target.pid or packet.chunk != packet.chunks - 1:
                    continue
                latencies.append((arrival - packet.monotonic_ns) / 1e6)
                starts.append(packet.monotonic_ns / 1e6)
            cpu = cpu_seconds(sampler.pid) - cpu_start
            elapsed = time.monotonic() - wall_start
        gaps = [later - earlier for earlier, later in zip(starts, starts[1:])]
        latencies.sort()
        print(json.dumps({
            "binary": str(arguments.binary), "processes": arguments.processes,
            "rate_hz": arguments.rate,
            "ticks": len(latencies), "expected_ticks": round(elapsed * arguments.rate),
            "resource_datagrams": resources,
            "latency_ms": {"p50": round(statistics.median(latencies), 2),
                           "p99": round(latencies[int(len(latencies) * 0.99) - 1], 2),
                           "max": round(latencies[-1], 2)},
            "max_tick_gap_ms": round(max(gaps), 1),
            "cpu_percent_of_one_core": round(100 * cpu / elapsed, 2)}))
    finally:
        for process in [sampler, target, *idle]:
            if process and process.poll() is None:
                process.kill()
        for process in [sampler, target, *idle]:
            if process:
                process.wait()


if __name__ == "__main__":
    main()
