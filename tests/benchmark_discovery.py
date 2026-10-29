"""Measure real sampler discovery with at most 64 unrelated and 24 matching children.

Run after make all. Output CPU percent of one core, RSS, sampling gaps, and
observed arrival delay as JSON. Fixtures are sleeping processes, not load.
"""
import argparse
import json
import os
import re
from pathlib import Path
import selectors
import shutil
import socket
import subprocess
import tempfile
import time

from wire import decode

ROOT = Path(__file__).resolve().parents[1]


def run_case(mode, duration, sampler):
    with tempfile.TemporaryDirectory(prefix='discovery-bench-') as temporary:
        directory = Path(temporary)
        children = []
        def start(name):
            executable = directory / name
            if not executable.exists():
                executable.symlink_to(shutil.which('sleep'))
            child = subprocess.Popen([executable, '120'])
            children.append(child)
            return child
        receiver = socket.socket(type=socket.SOCK_DGRAM)
        receiver.bind(('127.0.0.1', 0))
        receiver.setblocking(False)
        selector = selectors.DefaultSelector()
        selector.register(receiver, selectors.EVENT_READ)
        process = None
        log = open(directory / "sampler.log", "w+")
        try:
            unrelated = 64 if mode == 'unrelated64' else 0
            matches = 24 if mode == 'matches24' else 1
            for _ in range(unrelated):
                start('db-unrelated')
            active = [start('db-match') for _ in range(matches)]
            rules = f'target_pid={active[0].pid}\n' if mode == 'legacy' else 'process_patterns=["db-match*"]\nmax_targets=8\n'
            config = directory / 'sampler.toml'
            config.write_text(f'collector="127.0.0.1:{receiver.getsockname()[1]}"\n'
                              'rate_hz=5\ncpu_budget_pct=1\nresource_interval_s=0\nmemory_interval_s=0\n' + rules)
            process = subprocess.Popen([sampler, config], stderr=log)
            started = time.monotonic()
            cpu_start = None
            rss = []
            arrivals = {child.pid: started for child in active}
            delays, stamps, last = [], [], {}
            next_churn = started + 3
            hz = os.sysconf('SC_CLK_TCK')
            while time.monotonic() - started < duration + 1:
                if process.poll() is not None:
                    raise RuntimeError(f'sampler exited {process.returncode}')
                now = time.monotonic()
                if mode == 'churn' and now >= next_churn:
                    for child in active:
                        child.terminate()
                        child.wait(timeout=3)
                    child = start('db-match')
                    active = [child]
                    arrivals[child.pid] = time.monotonic()
                    next_churn += 2
                for _, _ in selector.select(0.05):
                    while True:
                        try:
                            data = receiver.recv(65536)
                        except BlockingIOError:
                            break
                        if data[:4] != b'TMON':
                            continue
                        packet = decode(data)
                        if packet.pid in arrivals:
                            delays.append(time.monotonic() - arrivals.pop(packet.pid))
                        if packet.chunk == 0 and packet.pid:
                            stamp = packet.monotonic_ns / 1e9
                            if packet.session in last and now - started >= 1:
                                stamps.append((stamp - last[packet.session]) * 1000)
                            last[packet.session] = stamp
                stat = Path(f'/proc/{process.pid}/stat').read_text().rsplit(')', 1)[1].split()
                cpu = (int(stat[11]) + int(stat[12])) / hz
                rss.append(int(stat[21]) * os.sysconf('SC_PAGE_SIZE') / 1024 / 1024)
                if now - started >= 1 and cpu_start is None:
                    cpu_start = cpu, now
            elapsed = time.monotonic() - cpu_start[1]
            ordered = sorted(stamps)
            log.flush()
            log.seek(0)
            excluded = 0
            for line in log.read().splitlines():
                if line.startswith("triangulator: kernel log (/dev/kmsg) not readable (errno "):
                    continue
                notice = re.fullmatch(r"triangulator: (\d+) matching processes are not monitored: all 8 slots of max_targets are in use", line)
                if notice:
                    excluded = max(excluded, int(notice[1]))
                    continue
                if line:
                    raise RuntimeError(f"unexpected sampler diagnostic: {line}")
            if mode == 'matches24' and excluded != 16:
                raise RuntimeError(f"expected 16 excluded matches, got {excluded}")
            return dict(excluded_reported=excluded, case=mode, elapsed_s=round(elapsed, 3),
                        cpu_percent=round(100 * (cpu - cpu_start[0]) / elapsed, 3),
                        rss_mib=round(max(rss), 3),
                        sample_gap_p95_ms=round(ordered[int((len(ordered)-1)*.95)], 3) if ordered else None,
                        sample_gap_max_ms=round(max(stamps), 3) if stamps else None,
                        arrival_max_s=round(max(delays), 3) if delays else None,
                        arrivals_observed=len(delays), proc_entries=len(list(Path('/proc').iterdir())),
                        unrelated=unrelated, matches=matches)
        finally:
            if process is not None:
                process.terminate()
                process.wait(timeout=5)
                if process.returncode != 0:
                    raise RuntimeError(f"sampler shutdown failed: {process.returncode}")
            log.close()
            for child in children:
                if child.poll() is None:
                    child.terminate()
                child.wait(timeout=5)
            selector.close()
            receiver.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--duration', type=float, default=10)
    parser.add_argument('--sampler', type=Path, default=ROOT / 'build/triangulator-sampler')
    parser.add_argument('--output', type=Path, default=ROOT / 'build/discovery-benchmark.json')
    args = parser.parse_args()
    if not 6 <= args.duration <= 60:
        parser.error('duration must be 6..60 seconds')
    rows = []
    for case in ('legacy', 'unchanged', 'churn', 'unrelated64', 'matches24'):
        row = run_case(case, args.duration, args.sampler)
        print(json.dumps(row), flush=True)
        rows.append(row)
    args.output.write_text(json.dumps(dict(results=rows, limits='Single local run; sleeping fixtures; slow probes disabled; CPU clock resolution 10 ms on this host. Not a 10,000-process measurement.'), indent=2) + '\n')


if __name__ == '__main__':
    main()
