# Sampler performance: 16 targets

Measured on 2026-11-02 at sampler revision `997a79ff`. The host was an Intel
Core i5-9500 with six logical CPUs and Linux `7.2.8-9-omarchy`. The sampler was
a static `-O2 -flto=auto` build. Its SHA-256 was
`6b93e656a974f439c160d3a5f3a203f04f8cbaa632da7f6521f4f4843a5b578e`.

These measurements describe this host and workload. The original temporary
trace and measurement files are no longer available. The values below were
recorded from the run output; they cannot replace the raw files for an audit.
The profiling revision predates this document's base revision.

## Thread sampling

Each target had one busy thread and sleeping threads. All target processes
shared one CPU. The sampler and UDP receiver ran on separate CPUs. The host
also ran other work; its CPUs were not isolated. Thread counts include each
process's main thread.

The sampler was configured for 5 Hz, resource samples every 2 seconds, and
memory-map samples every 30 seconds. The CPU budget was raised to 100% to
measure cost at 5 Hz. Each trial had a 5-second warm-up and a 10-second
measurement window. CPU is a percentage of one core, measured from
`/proc/PID/schedstat`.

| Processes | Threads per process | CPU trial 1 | CPU trial 2 | Mean CPU |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 50 | 0.468% | 0.480% | 0.474% |
| 4 | 50 | 1.203% | 1.296% | 1.250% |
| 4 | 200 | 3.580% | 3.898% | 3.739% |
| 16 | 50 | 3.840% | 3.750% | 3.795% |

The two 800-thread shapes had similar CPU costs in this workload. A 1-process,
800-thread case was not measured: the workload fixture permits at most 500
threads per process. These short trials do not cover a full 30-second
memory-map interval.

In a separate 20-second 16-by-50 run, 99 complete sampling cycles had a median
of 6.71 ms and p95 of 7.24 ms. This measures from the first target's thread
sample timestamp to the last target's UDP packet arrival at the loopback
receiver. Arrival timestamps came from the kernel. It excludes work before
the first timestamp and heavy scans after thread delivery.

The packet checks found all configured targets, complete thread-record counts,
and no missing sequences in the checked measurement windows. They do not
establish behavior for fully busy threads, thread churn, or packet loss on a
remote network.

## Default CPU budget

With the same 16-by-50 workload, `rate_hz = 5` and the default
`cpu_budget_pct = 1`, the sampler used 0.957% of one core over a 20-second
window after a 25-second warm-up. Its reported interval was 873 ms, and the
observed rate was 1.145 Hz per target.

The configured 2-second resource interval also stretched. At 5 Hz with the
budget raised, the median observed interval was 3.2 seconds. In the settled
20-second budgeted window, each target received one resource summary. The
sampler permits one heavy scan per tick, so 16 resource scans requested every
2 seconds exceed the available capacity at 5 Hz; memory-map scans also share
that capacity.

## Profile and improvement candidates

- **Thread file reads:** In a 5.1-second steady trace, each of
  `/proc/PID/task/TID/stat`, `schedstat`, `io`, and `wchan` was read 20,000
  times. This is four reads per thread per tick. No thread-file opens appeared
  in that steady window. About 77% of sampler CPU time was system time in the
  separate 20-second profile. Investigate whether some counters can be read
  less often while preserving the required data and its freshness.
- **Parsing and clearing:** `perf` user-mode cycle samples attributed about
  57% to stat parsing, tokenization, trimming, and number parsing; memory
  clearing accounted for about 11%. Test a smaller parsing pass and less
  clearing. These percentages are shares of user-mode samples, not shares of
  total CPU time.
- **Heavy probes:** Reduce repeated work in resource and memory-map scans, and
  make the requested sampling intervals consistent with the available scan
  capacity. Any lower sampling rate changes data freshness and needs an
  explicit product decision.
- **Discovery:** The steady trace included about 420 process `stat` reads per
  second on this host. Test discovery on hosts with more processes and avoid
  repeated work without weakening the documented discovery bound.

The `strace` run changes execution time. Use its syscall counts to identify
work, not its timings as production latency. The user-mode `perf` profile had
about 1,000 samples and did not attribute kernel CPU time to kernel functions.
All candidates need a before-and-after measurement and must retain the
sampler's single-thread, bounded-work, and no-allocation constraints.

## Heavy-probe measurements

The existing probe benchmark measured one 500-thread target at a time. Each
row combines two runs of 100 samples after a 1-second warm-up. These are
isolated probe costs, not measurements of 16 simultaneous targets.

| Target shape | Resource CPU mean | Memory-map CPU mean |
| --- | ---: | ---: |
| Threads only, 60 map lines | 0.30 ms | 0.07 ms |
| 300 files, 100 sockets, 5,061 map lines | 4.14 ms | 3.00 ms |
| 1,000 files, 400 sockets, 30,061 map lines | 7.21 ms | 17.11 ms |

To repeat these probe tests at the measured revision, build
`build/benchmark-victim` and `build/benchmark-sampling`, then run:

```sh
python3 tests/benchmark_slow_samples.py --shapes threads-only service large \
  --iterations 100 --warmup 1 --repeats 2 --cpu 1 \
  --output /tmp/sampler-slow-samples.json
```

CPU 1 was available on the measured host. Select an available CPU on another
host. The multi-target run used one-off orchestration; there is no reusable
multi-target driver in this report.
