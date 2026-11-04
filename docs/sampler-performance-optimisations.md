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

## Quiet threads: two reads, not four

Measured on 2026-11-05 on the same host, with Linux `7.2.15-1-omarchy`. A
full read of a thread costs four `/proc` reads: stat (2.5 us), schedstat (1.1 us), io (1.4 us), and wchan
(1.5 us). Most target threads sleep for many ticks. The sampler reads
schedstat and wchan first. When both equal the kept full read, and that read
showed state S, the sampler sends the kept record again and does not read
stat and io.

- **schedstat, not stat, shows a run.** stat utime and stime move in 10 ms
  clock ticks: 3-6% of thread-ticks with an unchanged stat had a changed
  schedstat. The comparison includes the runtime (ns), not only run delay
  and timeslices. A thread alone on a core runs on with no new timeslice or
  run delay.
- **wchan covers a thread that was woken but has not run yet.** Such a
  thread keeps its schedstat and shows state R. The kernel's `get_wchan`
  returns 0 for a task that is running, waking, or on a run queue, so the
  wchan does not match and the sampler reads in full. A wchan of `0` or
  empty never matches, so a target whose wchan is hidden (another user, or
  `kptr_restrict`) gets full reads.
- **Not PSI.** An earlier design skipped only when the `/proc/pressure/cpu`
  "some" total did not grow. On 2026-11-04 (Linux `7.2.8-9-omarchy`), at 5
  and 10 Hz the total grew between every pair of ticks in 16 runs (open in
  0% of ticks). The target's cgroup
  `cpu.pressure` was open in 0-6%. A growth threshold was not safe: it
  missed events at 36 us.
- **schedstat is read first in every full read.** A run during the full
  read then changes schedstat at the next tick, so the kept stat is never
  older than the kept schedstat.
- **Accepted limit.** Another thread can rename a sleeping thread through
  `/proc/PID/task/TID/comm`. schedstat and wchan do not change, so the old
  name is sent until the thread runs again.

To verify on a live process, run `build/skip-differential PID RATE_HZ
SECONDS`. It compares each sent kept record with a full read in the same tick
and exits with status 1 on a miss. Results over 20-second runs of a test
process with busy threads and nice-19 sleepers that wake every 0.1-1.6 s and
run for 50 us. "Pinned" means `taskset -c 0`, and "quota" means
`systemd-run --user --scope -p CPUQuota=50%`. A race is a thread that woke or
ran after the first read; the sampler sends what it saw first.

| Workload | Kept records at 5 Hz | Kept records at 10 Hz |
| --- | ---: | ---: |
| 300 sleepers | 74.6% | 86.9% |
| 1 busy, 100 sleepers | 74.0% | 86.1% |
| 6 busy, 100 sleepers | 70.4% | 82.0% |
| 12 busy, 100 sleepers | 66.7% | 77.6% |
| Pinned, 1 busy, 100 sleepers | 73.9% | 86.1% |
| Pinned, 3 busy, 100 sleepers | 72.4% | 84.3% |
| Pinned, 300 sleepers | 74.5% | 86.8% |
| Quota, 4 busy, 100 sleepers | 70.4% | 83.8% |

The 16 runs had 370,500 thread-ticks, 0 misses, and 6 races. A target of
another user (wchan hidden) had 0% kept records. With the comm rename, the
only differences were the names.

Sampler CPU, measured with `tests/benchmark_sampler.py --rates 5 10
--threads 100 300 500 --duration 30 --repeats 2`: the master binary
(`ce31a804`) against this change. "Quiet" is the default target, whose
sleeping threads never wake. "Waking" adds `--wake`: each sleeping thread
wakes every 0.1-1.6 s and runs for 50 us. "Busy" is `--busy`: every thread
burns CPU at nice 19, so the sampler can skip none. Kept records is the share
that `build/skip-differential` measured in separate 20-second runs on the same
kinds of target (the timed runs do not report it).

| Target | Threads | Rate | CPU before | CPU after | Change | Kept records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Quiet | 100 | 5 Hz | 0.459% | 0.264% | -42% | 97.0% |
| Quiet | 100 | 10 Hz | 0.907% | 0.482% | -47% | 98.0% |
| Quiet | 300 | 5 Hz | 1.225% | 0.623% | -49% | 97.7% |
| Quiet | 300 | 10 Hz | 2.477% | 1.196% | -52% | 98.7% |
| Quiet | 500 | 5 Hz | 1.984% | 0.989% | -50% | 97.8% |
| Quiet | 500 | 10 Hz | 3.993% | 1.960% | -51% | 98.8% |
| Waking | 100 | 5 Hz | 0.461% | 0.307% | -33% | 74.6% |
| Waking | 100 | 10 Hz | 0.876% | 0.501% | -43% | 86.4% |
| Waking | 300 | 5 Hz | 1.233% | 0.772% | -37% | 75.5% |
| Waking | 300 | 10 Hz | 2.422% | 1.343% | -45% | 87.0% |
| Waking | 500 | 5 Hz | 1.997% | 1.250% | -37% | 75.2% |
| Waking | 500 | 10 Hz | 3.997% | 2.182% | -45% | 87.2% |
| Busy | 100 | 5 Hz | 0.536% | 0.544% | +1.5% | 0.0% |
| Busy | 100 | 10 Hz | 0.964% | 0.986% | +2.3% | 0.0% |
| Busy | 300 | 5 Hz | 1.295% | 1.296% | +0.1% | - |
| Busy | 300 | 10 Hz | 2.484% | 2.499% | +0.6% | - |
| Busy | 500 | 5 Hz | 2.038% | 2.074% | +1.8% | 0.0% |
| Busy | 500 | 10 Hz | 3.982% | 4.021% | +1.0% | 0.0% |

The p50 latency of a complete 500-thread tick fell from 3.83 ms to 1.84 ms
(quiet, 5 Hz). RSS grew by less than 0.1 MiB: each thread keeps one record.
A kept record still costs two reads, so the cut stays near half of the CPU
even when almost every thread is quiet.

A target where every thread runs between ticks is the worst case: no record
is kept, and each thread still pays the reordered full read and the compare.
There the change costs 0.1-2.3% more sampler CPU than master (mean +1.2%, all
six cells positive; the two repeats of one cell differ by up to 2%, so the
size is near the noise). It is a small cost, not a saving. The busy target uses
about 570% of the 6 cores, so the sampler also competes for CPU there. The kept
share is 0.0% (0 misses, 0 races) at 100 and 500 threads; 300 threads was not
run separately.

## Historical 1% CPU budget

With the same 16-by-50 workload, `rate_hz = 5` and the then-default
`cpu_budget_pct = 1`, the sampler used 0.957% of one core over a 20-second
window after a 25-second warm-up. Its reported interval was 873 ms, and the
observed rate was 1.145 Hz per target.

The configured 2-second resource interval also stretched. At 5 Hz with the
budget raised, the median observed interval was 3.2 seconds. In the settled
20-second budgeted window, each target received one resource summary. The
sampler permits one heavy scan per tick, so 16 resource scans requested every
2 seconds exceed the available capacity at 5 Hz; memory-map scans also share
that capacity.

## 1 Hz with a 5% CPU budget

Measured on 2026-11-03 at revision `69c58c9c` on the same host, with 16
processes and 50 threads each. One thread per process was busy; the others
slept. The targets shared one CPU. The sampler and receiver used separate
CPUs. Each trial had a 5-second warm-up and a 30-second measurement window.
The configuration used `rate_hz = 1`, `cpu_budget_pct = 5`, resource and
memory-map intervals of 2 and 30 seconds, and `status_fallback = false`.

| Measurement | Trial 1 | Trial 2 |
| --- | ---: | ---: |
| Sampler CPU, one core | 0.889% | 0.868% |
| User CPU, one core | 0.233% | 0.233% |
| System CPU, one core | 0.633% | 0.600% |
| Mean frequency per target | 1.000000 Hz | 1.000012 Hz |
| Complete samples per target | 30 | 30 |

The packet checks verified exact thread IDs, complete chunks, and continuous
sequences. The sampler stayed at 1 Hz; the 5% budget did not visibly throttle
it. Total CPU came from `/proc/PID/schedstat`. User and system CPU came from
`/proc/PID/stat` ticks, so their lower resolution accounts for the difference
from total CPU. The host was not isolated.

The user-space `perf` profile recorded 258 samples per trial, with no reported
lost samples. `ParseStat` accounted for 45.49% and 39.83% of sampled user-mode
cycles; memory clearing accounted for 8.18% and 11.77%. These are not shares
of total sampler CPU, and kernel functions were not profiled. Compiler inlining
prevents a direct comparison with individual symbols in the earlier profile.

At 1 Hz, at most one heavy scan can run per second. The configured 2-second
resource interval requests eight scans per second across 16 targets, before
memory-map scans. The requested intervals therefore cannot all be met.

## Cache and branch misses in thread sampling

Measured on 2026-11-03 at `master` revision
`168bcb95648a3488188fb12272cb164b23c95ab2`, after the buffer zero-fill
change. The host was the Intel Core i5-9500 described above. The static
benchmark used `-O2 -flto=auto`. Its SHA-256 was
`b8e5a02d97cbdd4fc2c21f094de70593ee8dec958ec66512a744703f216fec23`.
The host was not isolated.

The existing sampling-loop benchmark read one process with 500 threads: one
busy thread and 499 sleeping threads. Each trial used a 1-second warm-up and
2,000 measured batches. The counters include startup and warm-up. They cover
user mode only, including the benchmark harness, but exclude kernel work. The
benchmark runs continuously and excludes UDP, resource scans, and memory-map
scans. It does not measure the full sampler or the 16-target workload above.

| Counter | Trial 1 | Trial 2 | Trial 3 |
| --- | ---: | ---: | ---: |
| User instructions | 7,842,335,237 | 7,849,189,527 | 7,869,471,676 |
| User cache references | 22,943,736 | 26,353,153 | 22,859,134 |
| User cache misses | 714,533 | 500,027 | 368,359 |
| Misses / references | 3.11% | 1.90% | 1.61% |
| User branches | 2,219,724,797 | 2,221,663,767 | 2,227,401,764 |
| User branch misses | 1,237,145 | 1,233,407 | 1,224,538 |
| Misses / branches | 0.056% | 0.056% | 0.055% |

`perf stat` reported 100% running time for each event. Generic cache events
are hardware-dependent and do not count every cache access. Cache misses
varied substantially across trials, while branch misses were stable. These
counts do not identify the responsible code or establish a speedup from a
change. Repeat and profile individual events before selecting an optimisation.
Run `bash scripts/profile-sampler-misses.sh /path/to/master-checkout` to
repeat; the script builds the two benchmark binaries in that checkout.

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

## C++ code candidates

Recorded on 2026-11-03 from a code reading at `master` revision `9a090fe5`.
That revision includes the parsing optimisation (`e59a2d3a`) and the
`constexpr` changes (#238, #239). Nothing below is measured. The order is the
expected effect on the profile above.

Worth trying:

- **Do not zero-fill read buffers.** `Thread::TakeSample` declares an 8 KB
  buffer with `{}` for each thread on each tick. `ReadProcessStat` does the
  same with a 4 KB buffer. `ReadAtStart` returns a view of only the bytes
  that `pread` wrote, so the zero-fill has no use. Remove the `{}`, or use the
  C++26 `[[indeterminate]]` attribute. This is the most probable source of
  the memory-clearing share.
- **`[[likely]]` and `[[unlikely]]` on error branches in the hot parsers.**
  The sampler has none now. Keep only the hints that the parsing benchmarks
  show to help.
- **C++23 `[[assume(...)]]` for proved bounds in `parsing.hpp`.** It can
  remove repeated length checks. A false assumption is undefined behavior, so
  use it only after a check that proves the bound.
- **A `Rescan` lookup table that needs no clear.** `ThreadCache::Rescan`
  clears a 64 KB table on each call. A table that keeps a generation number
  in each slot needs no clear. This has an effect only when thread lists change often.

Safety, with no expected speed gain:

- `std::unreachable()` in switches that cover every case.
- C++26 `std::inplace_vector` in place of a fixed array and a count, when the
  standard library supports it.
- C++26 contracts (`pre` and `post`) for preconditions, when compiler support
  is no longer experimental.

Larger gains that are not C++ features:

- **Fewer system calls.** Kernel time is the largest cost. Read `io` and
  `wchan` less often than `stat` and `schedstat`. This makes the data less
  fresh, so it needs a product decision. Batched reads with `io_uring` are in
  conflict with the "no async runtimes" sampler rule and need owner approval.
- **Profile-guided optimisation** with the existing benchmarks as the
  training run. This is a build change only.

Not recommended for the tick path: coroutines, `std::ranges` pipelines, and
`std::simd`. The `/proc` lines are short, so the gain is small, and the code
becomes harder to read.

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
