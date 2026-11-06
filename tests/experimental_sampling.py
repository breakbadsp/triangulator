#!/usr/bin/env python3
"""Compare isolated thread readers. No UDP, resource scans, or deployment.

Example: python3 tests/experimental_sampling.py --threads 64 --ticks 20 \
    --rate 10 --repeats 2 --output build/experimental-comparison.json
Build first with make check-experimental.
The same live target serves both arms. CPU accounting runs before comparisons.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import sys
import time

from benchmark_sampler import ROOT, TARGET, child

BINARY = ROOT / "build/experimental-sampling"


def run_reader(pid, backend, ticks, rate, verify=False):
    command = [str(BINARY), backend, str(pid), str(ticks), str(rate)]
    if verify:
        command.append("verify")
    completed = subprocess.run(command, text=True, capture_output=True,
                               timeout=20 + (ticks + 3) / rate)
    if completed.returncode == 77:
        raise PermissionError(completed.stderr.strip())
    if completed.returncode:
        raise RuntimeError(f"{command}: exit {completed.returncode}: {completed.stderr}")
    if completed.stderr:
        raise RuntimeError(f"reader emitted warnings: {completed.stderr}")
    result = json.loads(completed.stdout)
    expected = result["threads"] * ticks
    omissions = sum(result[key] for key in (
        "required_errors", "pending_completion", "blocked_by_pending_chunk",
        "deadline_before_chunk"))
    if result["published"] + omissions != expected:
        raise RuntimeError("record accounting does not cover the cohort")
    result["command"] = command
    result["omitted"] = omissions
    result["process_cpu_ns"] = result["cpu_end"]["process_ns"] - result["cpu_begin"]["process_ns"]
    result["process_cpu_pct"] = 100 * result["process_cpu_ns"] / result["window_ns"]
    result["mean_collection_us"] = statistics.mean(result["latency_ns"]) / 1000
    result["published_rate_hz"] = result["published"] * 1e9 / result["window_ns"] / result["threads"]
    return result


def start_target(threads, workload):
    command = [str(TARGET), str(threads)]
    if workload != "quiet":
        command.append(workload)
    return child(command, stdout=subprocess.PIPE, text=True)


def ready(target, threads):
    import select
    if not select.select([target.stdout], [], [], 10)[0]:
        raise RuntimeError("target readiness timeout")
    if target.stdout.readline().strip() != f"{threads} threads ready":
        raise RuntimeError("target readiness mismatch")
    if len(list(Path(f"/proc/{target.pid}/task").iterdir())) != threads:
        raise RuntimeError("target thread count mismatch")


def accounting_check():
    trials = []
    with start_target(32, "busy") as target:
        ready(target, 32)
        for backend in ("sync", "uring", "uring"):
            result = run_reader(target.pid, backend, 100, 100)
            begin, end, teardown = (result[key] for key in
                                    ("cpu_begin", "cpu_end", "cpu_after_teardown"))
            reader = end["reader_ns"] - begin["reader_ns"]
            workers = end["visible_worker_ns"] - begin["visible_worker_ns"]
            process = result["process_cpu_ns"]
            usage = end["getrusage_ns"] - begin["getrusage_ns"]
            # Snapshot enumeration is outside collection but costs reader CPU.
            tolerance = max(2_000_000, int(0.10 * max(process, reader + workers)))
            same_workers = sorted(begin["worker_ids"]) == sorted(end["worker_ids"])
            inclusion = (same_workers and workers >= 0 and
                         abs(process - reader - workers) <= tolerance and
                         abs(process - usage) <= tolerance)
            if backend == "uring":
                inclusion = inclusion and bool(end["worker_ids"]) and workers > tolerance
            # This tests that aggregate process charges do not disappear at exit.
            exited = bool(end["worker_ids"]) and not teardown["worker_ids"]
            retained = (teardown["process_ns"] >= end["process_ns"] and
                        teardown["getrusage_ns"] >= end["getrusage_ns"] and
                        teardown["process_ns"] - teardown["reader_ns"] >=
                        end["process_ns"] - end["reader_ns"] - tolerance)
            trials.append({"backend": backend, "process_ns": process,
                           "getrusage_ns": usage, "reader_ns": reader,
                           "visible_worker_ns": workers, "tolerance_ns": tolerance,
                           "same_visible_workers": same_workers,
                           "inclusion_observed": inclusion,
                           "worker_exit_observed": exited,
                           "charges_retained": retained,
                           "cpu_begin": begin, "cpu_end": end,
                           "cpu_after_teardown": teardown,
                           "omitted": result["omitted"],
                           "read_completion_errors": result["read_completion_errors_including_warmup"]})
    proved = all(t["inclusion_observed"] and t["charges_retained"] and
                 (t["backend"] == "sync" or t["worker_exit_observed"])
                 for t in trials)
    return {"status": "OBSERVED_INCLUDED" if proved else "UNAVAILABLE",
            "total_cpu_coverage": "observed reader and io-wq on this kernel" if proved else "unavailable",
            "limits": "Non-atomic snapshots; transient/unseen workers and whole-system CPU are not proved. "
                      "Process CPU remains the primary measured metric. No total-CPU gain is claimed.",
            "trials": trials}


def compare(threads, ticks, rate, repeats, workloads):
    accounting = accounting_check()
    trials = []
    for workload in workloads:
        with start_target(threads, workload) as target:
            ready(target, threads)
            initial_tids = sorted(int(p.name) for p in Path(f"/proc/{target.pid}/task").iterdir())
            for repeat in range(repeats):
                for backend in (("sync", "uring") if repeat % 2 == 0 else ("uring", "sync")):
                    result = run_reader(target.pid, backend, ticks, rate)
                    result.update(workload=workload, repeat=repeat,
                                  target_tids=initial_tids,
                                  total_cpu_coverage=accounting["total_cpu_coverage"])
                    trials.append(result)
            for backend in ("sync", "uring"):
                result = run_reader(target.pid, backend, ticks, rate, verify=True)
                result.update(workload=workload, repeat="correctness", target_tids=initial_tids)
                trials.append(result)
            final_tids = sorted(int(p.name) for p in Path(f"/proc/{target.pid}/task").iterdir())
            if initial_tids != final_tids:
                raise RuntimeError("fixed workload cohort changed during comparison")
    return {"cpu_accounting": accounting, "trials": trials}


def metadata():
    libraries = subprocess.check_output(["ldd", str(BINARY)], text=True)
    resolved = next((line.split("=>", 1)[1].split()[0] for line in libraries.splitlines()
                     if "liburing.so" in line and "=>" in line), None)
    return {"kernel": platform.release(), "machine": platform.machine(),
            "allowed_cpus": sorted(os.sched_getaffinity(0)),
            "revision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
            "source_tree_dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT)),
            "source_sha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                              for name in ("sampler/proc.hpp", "sampler/io.hpp",
                                           "sampler/experimental/uring.hpp",
                                           "sampler/experimental/runner.cpp",
                                           "tests/experimental_sampling.py",
                                           "tests/benchmark_target.cpp")},
            "build_options": (ROOT / "build/build_options").read_text(),
            "binary_sha256": hashlib.sha256(BINARY.read_bytes()).hexdigest(),
            "workload_sha256": hashlib.sha256(TARGET.read_bytes()).hexdigest(),
            "liburing_version": subprocess.check_output(["pkg-config", "--modversion", "liburing"], text=True).strip(),
            "liburing_path": resolved, "ldd": libraries,
            "workloads": {"quiet": "one busy main thread; workers sleep",
                          "wake": "one busy main; workers wake every 0.1-1.6 s and run 50 us",
                          "busy": "all threads busy at nice 19"},
            "limits": ["startup cohort only; rerun after PID/TID churn",
                       "schedstat only; no status fallback", "thread sampling only; no UDP or heavy scans",
                       "sync internal read/completion errors unavailable; omitted records counted",
                       "short shared-host trials; no affinity isolation or production gain claim"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--threads", type=int, default=64, choices=range(1, 501))
    parser.add_argument("--ticks", type=int, default=20, choices=range(1, 100001))
    parser.add_argument("--rate", type=int, default=10, choices=range(1, 1001))
    parser.add_argument("--repeats", type=int, default=2, choices=range(1, 11))
    parser.add_argument("--workloads", nargs="+", choices=("quiet", "wake", "busy"), default=["quiet", "wake", "busy"])
    parser.add_argument("--output", type=Path, default=ROOT / "build/experimental-comparison.json")
    args = parser.parse_args()
    report = {"schema_version": 1, "metadata": metadata(), "started_unix_s": time.time()}
    try:
        report.update(compare(args.threads, args.ticks, args.rate, args.repeats, args.workloads))
    except PermissionError as error:
        print(json.dumps({"status": "SKIP_SETUP", "reason": str(error)}))
        return 77
    report["complete"] = True
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    failures = [r for r in report["trials"] if r["verification_misses"] or
                r["verification_unavailable"] or r["omitted"] or r["pending_at_end"] or
                r["read_completion_errors_including_warmup"] or r["optional_errors"]]
    print(json.dumps({"status": "FAIL" if failures else "PASS", "output": str(args.output),
                      "trials": len(report["trials"]), "failed_trials": len(failures),
                      "cpu_accounting": report["cpu_accounting"]["status"]}))
    return int(bool(failures))


if __name__ == "__main__":
    sys.exit(main())
