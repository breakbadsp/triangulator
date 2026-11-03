# Sampler parsing measurements

Measured on 2026-11-02 with baseline revision `e1425460`. The host was an
Intel i5-9500 with six logical CPUs, Linux `7.2.8-9-omarchy`, GCC 16.2.1,
and the `powersave` CPU governor. Other host activity was present. These are
host-specific observations, not performance guarantees.

`parser-means.json` holds the mean wall time of each parser case. They come
from Hyperfine 2.0.0 runs: 15 runs and three warm-ups per case, with timed
processes pinned to CPU 3. `combined/metadata.json` records the settings. The
raw Hyperfine output is not kept.
The same behavior checks ran against each parser before timing. The cases
parse one million stat lines, ten million numbers, or three million
scheduler or I/O records. The wall times include process startup and the
benchmark's fixed behavior checks.

| Case | Before (ms) | After (ms) | Reduction |
| --- | ---: | ---: | ---: |
| Thread stat | 358.928 | 306.840 | 14.5% |
| Number, short | 102.452 | 82.185 | 19.8% |
| Number, mixed | 141.824 | 108.101 | 23.8% |
| Scheduler counters | 120.524 | 100.062 | 17.0% |
| I/O counters | 218.741 | 147.947 | 32.4% |

`sampler-multi-comparison.json` records three alternating 12-second trials
per binary, each after a 5-second warm-up. One sampler monitored 16 processes
with 50 threads each at 5 Hz and a 100% CPU budget. Each target had one busy
thread; its other threads slept. The targets shared one CPU, and the sampler
and UDP receiver each used another. The receiver checked complete chunks,
sequence continuity and the exact thread IDs in every completed sample.
The observed means were 3.751% before and 3.853% after, of one core. The
third "after" trial delivered 59 of 60 samples per target, with 275 ms of
receiver lag. The other five trials delivered all 60. The trials do not show a
whole-sampler improvement.

On 2026-11-03, the full-path capacity benchmark from PR #235 compared the
same sampler sources with and without the PR #233 parser. It used one
100-thread target, an unlimited benchmark build, CPUs 0–3, and three
alternating 35-second trials per variant after 5 seconds of warm-up. Median
capacity was 140,984 thread records/s before and 140,945 after. Trial ranges
were 137,727–143,907 and 135,750–141,343 respectively. This result does not
show a capacity improvement; it covers one target shape on one host.

A separate production-sampler regression run used 16 processes with 50
threads each at 5 Hz. Two 12-second trials per variant received all 60
samples per target. The receiver checked exact thread IDs, complete chunks,
and sequence continuity. This does not cover every production workload.

The repeat profile used the same workload for two 30-second trials per
binary, with 5 seconds of warm-up. Before CPU was 3.761% and 3.779%; after
CPU was 3.741% and 3.800%. Each trial delivered 150 complete samples for
every target. `profile-measurements.json` contains the per-trial
measurements. The driver and the detailed `perf` reports are not kept.
The user-mode profiles do not measure kernel execution. Compiler
inlining and symbol changes prevent a direct comparison of individual
function shares. These trials also do not establish a whole-sampler gain.

A separate sampling benchmark timed 200 production sampling batches against a live 500-thread target. The first
ordering measured 790.3 ± 44.0 ms before and 846.0 ± 79.4 ms after. Reversing
the order measured 743.9 ± 25.7 ms before and 721.4 ± 28.5 ms after. The
variation and ordering effect prevent a reliable overall speedup claim.

The buffer experiment used the same sampling benchmark and an isolated patch
on the original revision. The first ordering used 120 batches and measured
507.5 ± 5.3 ms before and 545.3 ± 44.3 ms with a shared buffer. The reversed
ordering used 200 batches and measured 759.3 ± 28.5 ms before and
825.6 ± 37.2 ms with the shared buffer. Because it did not show a benefit,
the patch was not applied. The patch and raw results are not kept.

To repeat the parser comparison, install `hyperfine` and run:

```sh
python3 tests/benchmark_parsing.py --base e1425460 --cpu 3 --runs 15 \
  --warmup 3 --output build/parsing-comparison
```

Select an available CPU on the test host. This builds the current benchmark
sources against both the base and working-tree parser, runs their behavior
checks, and writes Hyperfine JSON. To repeat the 16-target test, build the
original and current sampler in separate worktrees, build
`build/benchmark-victim` in the current worktree, and run:

```sh
python3 tests/benchmark_sampler_multi.py --before /path/to/original/sampler \
  --after build/triangulator-sampler --output build/sampler-multi.json
```

Run `python3 scripts/render_sampler_parsing_results.py` to regenerate
`summary.svg` from the recorded JSON. Rewrite `parser-means.json` from new
Hyperfine output first if you repeat the parser comparison. The isolated
candidate comparisons, including the rejected second stat parser, are not kept.
