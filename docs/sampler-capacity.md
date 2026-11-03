# Sampler capacity benchmark

Run on an otherwise idle Linux host, with no other sampler:

```
make benchmark-capacity
```

This builds `build/triangulator-sampler-capacity`. It compiles the CPU-budget
update and deadline wait out of the real sampler loop. The ordinary sampler
has no runtime switch for this mode. Do not deploy the capacity binary.
The benchmark requires more than 10 ticks/s and more than 10% of one CPU core
for each measured window. The configured 1% CPU budget cannot limit this build.
Each window lasts at least six seconds, beyond the budget's five-second window.

The workload has exactly 100 threads by default: one busy thread and sleeping
threads. The driver checks their actual `/proc` IDs before and after measurement.
It checks every TMON packet, exact thread coverage, chunk completeness, session,
sequence, and effective interval, including warmup and the trailing sample.
Packet loss, unexpected warnings, or insufficient throughput fail the run.
Resource and memory-map schedules remain enabled at 5 and 30 seconds. The
default 35-second windows include memory-map work in every repetition. Short
windows are smoke checks and can omit this work. TMON keeps its nominal 100 ms
interval field; throughput uses actual monotonic sample times.

The metric is complete thread records delivered per second at continuous load.
It includes discovery, proc reads, encoding, and loopback UDP. This is local
full-path capacity for this workload, with receiver and host contention. It is
not collector ingestion capacity or a guaranteed production rate. The Python
receiver can limit results; packet loss fails instead of producing a capacity
claim. A CPU-constrained host can also fail the minimum CPU check. The existing
`benchmark_sampler.py` reports delivered throughput at configured production
rates; `benchmark_sampling.py` measures only the continuous read path.

The run also reports tick latency: the last kernel receive time of a tick's
datagrams minus the sampler's wall-clock stamp of that tick. It covers proc
reads, encoding, and loopback UDP. It excludes receiver scheduling and the
resource and memory-map work that follows a tick. The sampler is saturated, so
this is the cost of one tick at full speed, not latency at a production rate
(`benchmark_sampler.py` measures that). A 35-second window holds thousands of
ticks, so p99 is stable, but `max_ms` is the single worst tick. A window fails
if wall time and monotonic time differ by more than 5 ms, because a clock step
would invalidate the values.

The report also gives sampler CPU use (percent of one core, over the window)
and peak RSS (`VmHWM`: the kernel's high-water mark for the sampler since its
start, so it includes warm-up and the resource and memory-map work). The JSON
has these per run and as a summary. A baseline without latency data still
compares throughput. The console summary looks like this:

```
Capacity benchmark: 100 threads, 3 runs of 35 s (warm-up 5 s)
  Throughput   median <records/s> thread records/s (min <records/s>, max <records/s>)
  Tick latency median of runs: p50 <ms> ms, p95 <ms> ms, p99 <ms> ms; worst <ms> ms
  Sampler CPU  median <percent>% of one core (max <percent>%)
  Peak RSS     <MiB> MiB (sampler, whole run)
  Report: build/capacity.json
  Markdown: build/capacity.md (paste into the pull request)
```

The run also writes `build/capacity.md` beside the JSON: a table of the four
headline values and bar charts of tick latency and of throughput per run. It
is GitHub Markdown. Paste it into the pull request that changes the sampler.

For repeatable comparisons, keep hardware, affinity, load, compiler, flags,
thread count, and timing parameters fixed. The JSON includes raw sample times,
CPU use, binary/source hashes, source diff, revision, and machine/build metadata.
The median, minimum, and maximum describe repetitions; they are not confidence
limits. CPU frequency, thermal state, virtualization, and other host activity
can change results. Inspect repetition spread before accepting a change.

```
python3 tests/benchmark_capacity.py --threads 101 --duration 35 --warmup 5 --repeats 3 --output build/new-capacity.json --baseline build/old-capacity.json
TRIANGULATOR_TEST_CAPACITY=1 python3 -m unittest discover -s tests -p test_capacity_benchmark.py -v
```

Comparison rejects different protocol, workload, timing, build flags, kernel,
CPU model, or CPU affinity. Retain the original JSON for each revision. Run
sequentially: the driver checks for active samplers and locks other capacity
drivers for the same user. A separately started sampler can race this check;
reserve the host for the run. Do not run this benchmark with the full test suite.
