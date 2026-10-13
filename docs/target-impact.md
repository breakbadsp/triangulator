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
