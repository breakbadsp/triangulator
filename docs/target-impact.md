# Sampler impact on the target

The sampler uses little CPU, so the open question is what each tick does to the
process it samples. A tick is one burst on one core: it lists the target's threads and
reads four `/proc` files for each. Some of those reads take locks inside the target.
This page records how the burst looks and what the target feels. Run
`make benchmark-target-impact` to repeat it.

## Result

- **Thread-sample latency:** 4.4 ms at 500 threads, once per tick. At
  10 Hz the sampler uses 4.4% of one core; at 1 Hz, 0.45%. The 95th percentile and
  maximum (9–32 ms) were as noisy on this desktop host as the idle baseline, so do not
  read a tail guarantee from them.
- **Sampler on its own core:** no effect on the target was distinguishable from the
  host's own noise, at 1 or 10 Hz, on any probe.
- **Sampler sharing a core with a busy thread:** at 10 Hz that thread lost 6.7% of its
  time, against 1.7% without the sampler, and saw about 1900 stalls of 1 ms or more per
  minute, against 41. Each 8 ms thread sample (half the core, so twice as long) is cut
  into several stalls. At 1 Hz the difference was within noise.
- **Sampler sharing a core with a sleeping, latency-sensitive thread:** its 1 ms timer
  wake-ups were 1 ms or more late about twice as often (927 per minute against 475; 694
  against 346 in an earlier run) and the 99th percentile doubled.
- **Lowering the priority does not fix sharing.** At `nice 19` next to a busy thread, the
  sampler fell to 3.1 Hz with 250 ms thread samples, so samples are lost, and the busy thread
  still lost 3.3% of its time. Next to a sleeping thread, `nice 19` did not improve the
  wake-up delays (967 per minute).
- **Locks:** the signal-lock probe and the address-space-lock probe (the locks the
  sampler's `stat` and `maps` reads are expected to take) showed no effect that
  repeated. The address-space result applies to this kernel only; see the limits.

**Guidance for production hosts:** keep the sampler off the cores that run the target's
latency-critical threads, for example with `taskset` or systemd `CPUAffinity=`. With the
sampler on its own core the measurement shows nothing to tune. On a shared core, priority
is not a substitute.

## Method

`build/benchmark-victim` stands in for the target. It has sleeping threads plus four
probe threads, each pinned to its own core. All four record their delays in exact
threshold counters and power-of-two histograms.

| Probe | What it does | What a delay means |
| --- | --- | --- |
| spin | Reads the clock in a tight loop | Time the core spent on other work; the sum of gaps of 10 µs or more |
| wake | Sleeps on a 1 ms absolute timer | Wake-up lateness |
| lock | Changes the signal mask twice | Wait for the process signal lock |
| mmap | Maps and unmaps one page | Wait for the address-space lock |

The driver, `tests/benchmark_target_impact.py`, starts the victim, then the real sampler
at the chosen rate and core, waits for a warm-up, and runs the probes for 30 s. Each
scenario runs three times in rotating order, after the `off` scenario that has no
sampler. Thread-sample latency is the time from a tick's stamp to the arrival of its
last thread-sample datagram (rescan, reads, encoding, loopback UDP). It excludes the
resource and memory-map work that the sampler does after the thread sample in the same
tick, so the extra memory-map reads of `maps-1s` do not appear in it; they appear in the
CPU column and the probes. CPU is the sampler's scheduler runtime.

## Results

Host: Intel Core i5-9500 (6 cores, `powersave` governor), Linux 7.2.5, desktop session
running. Sampler build from this repository, 500 target threads, six cores: one for each probe,
one for the sampler, and one for the driver. Measured on 2026-10-13.

Sampler (`apart` is its own core; `shared-spin` and `shared-wake` share the spin and
wake probes' core; `nice19` runs the sampler at that niceness; `maps-1s` reads the memory
map every second instead of every 30 s):

| Scenario | Rate (Hz) | CPU (% of one core) | Thread-sample latency p50 (ms) | p95 (ms) | Max (ms) |
| --- | ---: | ---: | ---: | ---: | ---: |
| apart-1hz | 1.00 | 0.45 | 4.4 | 18.2 | 29.1 |
| apart-10hz | 10.00 | 4.43 | 4.4 | 9.4 | 24.9 |
| apart-10hz-maps-1s | 10.00 | 4.45 | 4.4 | 14.0 | 32.3 |
| shared-spin-1hz | 1.00 | 0.44 | 8.3 | 9.4 | 9.6 |
| shared-spin-10hz | 10.00 | 4.32 | 8.4 | 9.3 | 28.8 |
| shared-spin-10hz-nice19 | 3.13 | 1.39 | 250.8 | 299.3 | 497.5 |
| shared-wake-10hz | 10.00 | 4.39 | 4.5 | 9.1 | 18.5 |
| shared-wake-10hz-nice19 | 9.99 | 4.37 | 4.4 | 10.1 | 146.2 |

Target probes, counts per minute of probe time:

| Scenario | Spin: time lost (%) | Spin: stalls ≥1 ms /min | Wake: p99 late (µs) | Wake: ≥1 ms /min | Lock: ≥1 ms /min | Mmap: ≥1 ms /min |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| off | 1.7 | 41 | 1,049 | 475 | 220 | 26 |
| apart-1hz | 2.2 | 221 | 1,049 | 413 | 25 | 168 |
| apart-10hz | 2.3 | 178 | 1,049 | 610 | 82 | 156 |
| apart-10hz-maps-1s | 2.1 | 99 | 1,049 | 318 | 142 | 212 |
| shared-spin-1hz | 2.1 | 177 | 1,049 | 382 | 7 | 13 |
| shared-spin-10hz | 6.7 | 1885 | 1,049 | 562 | 121 | 197 |
| shared-spin-10hz-nice19 | 3.3 | 572 | 1,049 | 557 | 97 | 117 |
| shared-wake-10hz | 1.5 | 10 | 2,097 | 927 | 21 | 51 |
| shared-wake-10hz-nice19 | 1.5 | 28 | 2,097 | 967 | 29 | 12 |

## Resource and memory-map intervals

The thread tick is not the only thing the sampler does. Every `resource_interval_s` it
reads PSI, cgroup limits, descriptors and a sock_diag dump of the network namespace
(a resource sample). Every `memory_interval_s` it reads `/proc/PID/maps` and four
small files (a memory-map sample). Both ride on a thread tick, after the thread sample.
This section measures what one of each costs and what a shorter interval would add.
Repeat it with `make benchmark-slow-samples` and the commands at the end of the section.

**Result:** resource samples are cheap enough to run every 2 s (the default): 0.23% of
a core for a target with 500 descriptors, more with many descriptors and sockets. Memory-map samples stay at
30 s: they cost little CPU, but they take the target's address-space lock, the
measurement does not cover older kernels, and the data they carry changes slowly.

### Cost of one sample

The production `ResourceProbe` and `MemoryProbe` ran in a loop against a target with 500
threads (no UDP, no collector, one pinned core, 5 repeats of 1,000 samples; 3 repeats of
300 for `many-sockets`). The sampler has one thread, so CPU time equals wall time within
0.1 ms; the table gives wall time. The host's own namespace holds about 1,300 more
sockets, which sock_diag also lists.

| Target | Descriptors / sockets | Maps lines | Resource sample p50 / p95 / max (ms) | Memory sample p50 / p95 / max (ms) | Longest single maps read p50 / max (µs) |
| --- | --- | ---: | ---: | ---: | ---: |
| threads only | about 5 / 0 | 59 | 0.30 / 0.36 / 0.59 | 0.07 / 0.09 / 0.18 | 17 / 56 |
| service | 506 / 200 | 5,063 | 4.53 / 5.13 / 6.20 | 3.23 / 3.56 / 5.20 | 39 / 714 |
| large | about 1,800 / 800 | 30,060 | 7.65 / 8.48 / 19.00 | 18.91 / 19.87 / 34.37 | 57 / 4,133 |
| many sockets | about 10,300 / 10,000 | 5,060 | 35.56 / 38.88 / 81.70 | 3.20 / 3.53 / 4.75 | 26 / 1,318 |

A resource sample costs mostly per descriptor and per socket in the namespace. A
memory-map sample costs mostly per maps line (about 0.6 µs a line). The longest single
read is the longest time one 4 KiB `read()` of maps took, which includes any time the
sampler was descheduled.

The share of one core that follows from these, at the intervals under discussion:

| Interval | Resource sample, service / many sockets | Memory sample, service / large |
| ---: | ---: | ---: |
| 1 s | 0.45% / 3.6% | 0.32% / 1.9% |
| 2 s | 0.23% / 1.8% | |
| 5 s | 0.09% / 0.7% | 0.06% / 0.38% |
| 10 s | | 0.03% / 0.19% |
| 30 s | | 0.011% / 0.063% |

A full resource sample plus the thread sample is about 9 ms with 500 threads and the
service target, 40 ms with many sockets, against a 200 ms tick at 5 Hz. Neither
overruns a tick.

### Whole sampler at 5 Hz

The real sampler on its own core, 500-thread target, 30 s per run, three runs
per row, CPU as a share of one core. The baseline uses resource samples every
5 s and memory-map samples every 30 s. The current resource default is 2 s.
Each group changes one interval and keeps the other at its baseline value.

| Target | Resource 5 s (baseline) | Resource 2 s (default) | Resource 1 s | Maps 30 s (baseline) | Maps 10 s | Maps 5 s | Maps 1 s |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| service (5,063 lines) | 2.34 | 2.48 | 2.71 | 2.34 | 2.36 | 2.39 | 2.68 |
| large (30,060 lines) | | | | 2.39 | 2.55 | 2.77 | 4.36 |

The differences match the table above: 5 s to 2 s adds 0.14 points (predicted 0.14),
5 s to 1 s adds 0.37 (predicted 0.36), and reading 30,000 lines every second adds about
2 (predicted 1.9). The median thread-sample latency, the late-tick count (zero) and the tick rate did
not change in any scenario.

### Effect on the target

Two measurements, both with the probes from the first part of this page.

- **The real sampler at each interval** (same runs as above, `apart` and `shared-spin`
  rows). The probe counts did not follow the interval. For example the address-space
  probe's stalls of 1 ms or more per minute were 351 with the baseline intervals, 204
  with resources every 2 s, 19 with resources every 1 s, 331, 381 and 215 with maps every
  10, 5 and 1 s. The target without a sampler ranged from 26 to 502 across runs of
  the same host. The interval effect, if there is one, is smaller than that noise.
- **A reader that does nothing but read maps** (`maps-loop`, 4 KiB reads, no pause, 97
  to 99% of its core, 3 runs of 30 s). This is the most address-space-lock traffic one
  core can make. The address-space probe saw 247 stalls of 1 ms or more per minute
  against 46 with no reader on the 5,000-line target, and 438 against 53 on the
  30,000-line one. The signal-lock probe, which maps does not touch, also rose, so part
  of this is the reader's presence and not the lock. The total rise is about
  3 to 6 more stalls a second with the continuous reader. These measurements
  do not show lock occupancy or establish a relation between sampling
  interval and added target stalls. Total sample time includes work outside
  the maps reads. The `maps_read_us` values also include waits and time when
  the sampler did not run. Neither value measures lock occupancy.

### Limits of this section

- Same host, kernel and noise as the rest of the page: Linux 7.2.5, `powersave`
  governor, desktop session running, measured on 2026-10-14. Differences smaller than the
  host's run-to-run spread are not claimed.
- Maps reads on this kernel may not take the lock the way older kernels do. Before
  Linux 6.4 page faults wait for the same lock, and RHEL 8 or 9 kernels were not
  measured. The target's work during the runs was sleeping threads plus the probes; a
  target that maps and faults heavily would feel more.
- The target is idle apart from the probes, so its threads are cheap to read. A busy
  target's `stat` reads and a larger sock_diag dump cost more.
- Commands: `python3 tests/benchmark_target_impact.py --scenarios off apart-5hz
  apart-5hz-res-2s apart-5hz-res-1s apart-5hz-maps-10s apart-5hz-maps-5s apart-5hz-maps-1s
  --victim-options mappings=5000 files=300 sockets=100`, the same with `mappings=30000`,
  and `--scenarios off maps-loop` for the reader.

## Limits

- **Noise is large.** The same scenario moved from 0 to 221 spin stalls per minute
  between two full runs, and the `off` baseline has 475 late wake-ups per minute on this
  desktop. Only differences several times larger than that, which repeated in both runs,
  are claimed above. Everything else is inconclusive. A quiet host with isolated cores
  would resolve smaller effects.
- **One host, one kernel.** How `/proc/<pid>/maps` reads interact with the address-space
  lock differs between kernel versions, and I did not check how this one does it. The
  memory-map result may not hold on RHEL 8 or 9 kernels, so repeat it there. Hyperthread
  siblings, other sockets, and a busy target were not tested; the target's non-probe
  threads sleep.
- **Probe resolution.** Percentiles are the upper bound of a power-of-two bucket (a
  reported 1,049 µs means "at most 1,049 µs"), so small shifts cannot show in them.
  Counts of stalls are exact.
- **RHEL 8.** The driver reuses the receiver of `tests/benchmark_sampler.py`, which needs
  kernel receive timestamps from Linux 5.1. On the 4.18 kernel it stops with "kernel
  receive timestamp is missing"; the timestamp fallback is still to do.
