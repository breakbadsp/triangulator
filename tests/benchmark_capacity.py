#!/usr/bin/env python3
"""Measure complete, loss-free sampler capacity on loopback, without rate waits."""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
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

import benchmark_sampler as bench

ROOT = bench.ROOT
BINARY = ROOT / 'build/triangulator-sampler-capacity'
MODE = 'capacity-v1: no CPU budget; no deadline wait'


def require_capacity_binary(binary):
    result = subprocess.run([str(binary), '--capacity-mode'], capture_output=True, text=True, timeout=5)
    if result.returncode or result.stdout.strip() != MODE:
        raise RuntimeError('a separate capacity benchmark build is required')


def check_no_sampler():
    # Also detect a sampler in another checkout. Never stop a user process.
    for task in Path('/proc').iterdir():
        if not task.name.isdigit():
            continue
        name = ''
        try:
            name = (task / 'comm').read_text().strip()
            executable = (task / 'exe').readlink().name
        except FileNotFoundError:
            continue
        except PermissionError:
            if name == 'triangulator-sa':
                raise RuntimeError(f'cannot inspect possible sampler PID {task.name}')
            continue
        if executable.startswith('triangulator-sampler'):
            raise RuntimeError(f'another sampler is running: PID {task.name}')


@contextmanager
def exclusive_host():
    # This lock covers concurrent capacity drivers for the current user.
    with open(Path(tempfile.gettempdir()) / f'triangulator-capacity-{os.getuid()}.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError('another capacity benchmark is running') from error
        check_no_sampler()
        yield


def task_ids(pid):
    return {int(path.name) for path in Path(f'/proc/{pid}/task').iterdir()}


def window(stream, sampler, target, seconds, keep=True):
    first, _ = bench.wait_sample(stream, sampler, target, time.monotonic() + 10)
    start = bench.cpu_snapshot(sampler.pid)
    receiver_start = time.process_time_ns()
    rows = []
    last = first
    ticks = 0
    end_ns = first.monotonic_ns + round(seconds * 1e9)
    deadline = time.monotonic() + seconds + 10
    while last.monotonic_ns < end_ns:
        packet, latency = bench.wait_sample(stream, sampler, target, deadline)
        ticks += 1
        last = packet
        if keep:
            rows.append([packet.sequence, packet.monotonic_ns, latency])
    finish = bench.cpu_snapshot(sampler.pid)
    cpu_percent = 100 * (finish[1] - start[1]) / (finish[0] - start[0])
    elapsed = (last.monotonic_ns - first.monotonic_ns) / 1e9
    if keep and (ticks < 2 or ticks / elapsed <= 10 or cpu_percent <= 10):
        raise RuntimeError('capacity was not demonstrated: require >10 ticks/s and >10% sampler CPU')
    if task_ids(target.pid) != stream.thread_ids or len(task_ids(sampler.pid)) != 1:
        raise RuntimeError('target thread IDs or sampler thread count changed')
    return {
        'elapsed_s': elapsed, 'ticks': ticks, 'thread_records': ticks * len(stream.thread_ids),
        'delivered_records_per_s': ticks * len(stream.thread_ids) / elapsed,
        'sampler_cpu_percent': cpu_percent,
        'sampler_cpu_s': (finish[1] - start[1]) / 1e9,
        'receiver_cpu_s': (time.process_time_ns() - receiver_start) / 1e9,
        'first_sample': [first.sequence, first.monotonic_ns],
        'samples': rows,
    }


def require_scheduled_work(datagrams, seconds):
    # Count from launch, warm-up included: the memory-map timer starts with the sampler.
    # Without TRES and TVMA the run left out scheduled work and overstates capacity.
    if seconds > bench.MEMORY_INTERVAL_S and not all(datagrams[kind] for kind in ('TRES', 'TVMA')):
        raise RuntimeError('resource or memory-map samples were missing')


def trial(binary, threads, duration, warmup):
    with tempfile.TemporaryDirectory() as directory, \
            socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver, \
            bench.child([str(bench.named_link(directory, bench.TARGET)), str(threads)],
                        stdout=subprocess.PIPE, text=True) as target:
        if not select.select([target.stdout], [], [], 10)[0] or target.stdout.readline().strip() != f'{threads} threads ready':
            raise RuntimeError('target did not start the exact thread count')
        tids = task_ids(target.pid)
        if len(tids) != threads:
            raise RuntimeError('target thread count differs from request')
        receiver.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 * 1024 * 1024)
        receiver.setsockopt(socket.SOL_SOCKET, bench.SO_TIMESTAMPNS_NEW, 1)
        receiver.bind(('127.0.0.1', 0))
        config = Path(directory) / 'sampler.toml'
        config.write_text(f'process_names = ["bt-{os.getpid()}"]\nrate_hz = 10\n'
                          f'collector = "127.0.0.1:{receiver.getsockname()[1]}"\n'
                          'cpu_budget_pct = 1\nstatus_fallback = false\n'
                          f'resource_interval_s = 5\nmemory_interval_s = {bench.MEMORY_INTERVAL_S}\n')
        with bench.child([str(binary), str(config)], stdout=subprocess.DEVNULL,
                         stderr=subprocess.PIPE) as sampler:
            stream = bench.SampleStream(receiver, target.pid, 10, tids)
            try:
                window(stream, sampler, target, warmup, keep=False)
                result = window(stream, sampler, target, duration)
                # A further complete tick closes the trailing packet/sequence boundary.
                bench.wait_sample(stream, sampler, target, time.monotonic() + 10)
                require_scheduled_work(stream.datagrams, warmup + duration)
                bench.check_sampler_log(bench.read_sampler_log(sampler))
            except (OSError, ValueError, RuntimeError) as error:
                raise RuntimeError(f'{error}; sampler log: {bench.read_sampler_log(sampler)}') from error
            result.update(target_threads=threads, thread_ids=sorted(tids),
                          receive_buffer_bytes=receiver.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF),
                          datagrams_including_warmup=dict(stream.datagrams))
            return result


def check_baseline(current, baseline):
    keys = ('schema_version', 'method', 'threads', 'duration_s', 'warmup_s', 'repeats',
            'build_options', 'cpu_model', 'kernel', 'allowed_cpus',
            'workload_source_sha256', 'receiver_source_sha256')
    if not baseline.get('complete') or any(current[key] != baseline.get(key) for key in keys):
        raise ValueError('baseline protocol, workload, build flags, or machine differs')
    rates = [run.get('delivered_records_per_s') for run in baseline.get('runs') or []]
    if not rates or not all(isinstance(rate, (int, float)) and rate > 0 for rate in rates):
        raise ValueError('baseline has no usable runs')


def comparison(current, baseline):
    check_baseline(current, baseline)
    old = statistics.median(run['delivered_records_per_s'] for run in baseline['runs'])
    new = statistics.median(run['delivered_records_per_s'] for run in current['runs'])
    return {'baseline_median_records_per_s': old, 'change_percent': 100 * (new / old - 1)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=BINARY)
    parser.add_argument('--threads', type=int, default=100)
    parser.add_argument('--duration', type=float, default=35)
    parser.add_argument('--warmup', type=float, default=5)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--output', type=Path, default=ROOT / 'build/capacity.json')
    parser.add_argument('--baseline', type=Path)
    args = parser.parse_args()
    if (not 1 <= args.threads <= 500 or args.repeats < 1
            or not math.isfinite(args.duration) or args.duration < 6
            or not math.isfinite(args.warmup) or args.warmup < 1):
        parser.error('require 1..500 threads, positive repeats, duration >=6 s, warmup >=1 s')
    if args.baseline and args.baseline.resolve() == args.output.resolve():
        parser.error('baseline and output must be different files')
    binary = args.binary.resolve()
    require_capacity_binary(binary)
    digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
    report = {
        'schema_version': 1, 'method': 'continuous-full-sampler-loopback-v1', 'complete': False,
        'measured_at_utc': datetime.now(timezone.utc).isoformat(),
        'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
        'source_diff': subprocess.check_output(['git', 'diff', 'HEAD'], cwd=ROOT, text=True),
        'source_status': subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True),
        'source_sha256': {str(path.relative_to(ROOT)): digest(path) for pattern in
                          ('sampler/*.*pp', 'common/*.*pp', 'tests/benchmark_capacity.py',
                           'tests/benchmark_sampler.py', 'tests/wire.py', 'tests/benchmark_target.cpp', 'Makefile')
                          for path in ROOT.glob(pattern)},
        'binary_sha256': digest(binary), 'target_sha256': digest(bench.TARGET),
        'workload_source_sha256': digest(ROOT / 'tests/benchmark_target.cpp'),
        'receiver_source_sha256': {name: digest(ROOT / 'tests' / name)
                                   for name in ('benchmark_sampler.py', 'wire.py')},
        'build_options': (binary.parent / 'build_options').read_text().strip(),
        'benchmark_define': 'TRIANGULATOR_CAPACITY_BENCHMARK',
        'compiler': subprocess.check_output([(binary.parent / 'build_options').read_text().split()[0], '--version'], text=True).splitlines()[0],
        'cpu_model': next((line for line in Path('/proc/cpuinfo').read_text().splitlines()
                           if line.startswith('model name')), platform.machine()),
        'kernel': platform.release(), 'machine': platform.machine(), 'hostname': platform.node(),
        'allowed_cpus': sorted(os.sched_getaffinity(0)), 'python': platform.python_version(),
        'threads': args.threads, 'duration_s': args.duration, 'warmup_s': args.warmup,
        'repeats': args.repeats, 'busy_target_threads': 1, 'configured_budget_pct': 1,
        'resource_interval_s': 5, 'memory_interval_s': 30, 'runs': [],
        'limit': 'local delivered capacity; includes receiver and host contention; not collector ingestion',
        'raw_sample_columns': ['sequence', 'monotonic_ns', 'complete_latency_ms'],
    }
    # Reject an unusable baseline now: a failure after the runs would discard them.
    baseline = json.loads(args.baseline.read_text()) if args.baseline else None
    if baseline is not None:
        check_baseline(report, baseline)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with exclusive_host():
        args.output.write_text(json.dumps(report, indent=2) + '\n')
        for repeat in range(args.repeats):
            print(f'Capacity repetition {repeat + 1}/{args.repeats}', file=sys.stderr, flush=True)
            report['runs'].append(trial(binary, args.threads, args.duration, args.warmup))
            args.output.write_text(json.dumps(report, indent=2) + '\n')
    report['complete'] = True
    rates = [run['delivered_records_per_s'] for run in report['runs']]
    report['median_records_per_s'] = statistics.median(rates)
    report['min_records_per_s'] = min(rates)
    report['max_records_per_s'] = max(rates)
    if args.baseline:
        report['comparison'] = comparison(report, baseline)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    print(f"Local delivered capacity: {report['median_records_per_s']:.1f} thread records/s; {args.output}")
    if args.baseline:
        print(f"Change: {report['comparison']['change_percent']:+.2f}%")


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'capacity benchmark failed: {error}', file=sys.stderr)
        sys.exit(1)
