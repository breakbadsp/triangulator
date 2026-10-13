# Efficiency profiling

Use profiling to locate the cost of completed work. Use benchmarks without a
profiler to validate an improvement. Lower CPU use is useful only when the
program completes the same work with the same correctness and sample coverage.

[Native sampler results and charts](profiling/runs/20261013T033348Z-a83a97f/report.md)
identify system CPU and parsing as the first investigation targets. See the
[performance TODO list](../TODO.md#performance-optimizations) for planned experiments.

## Profiling agent

The [Efficiency Profiler definition](../.codex/agents/efficiency-profiler.toml)
contains the workflow. The [profile-efficiency skill](../.agents/skills/profile-efficiency/SKILL.md)
starts one agent and supports runtimes without named custom agents. Both files
are local to this repository. They inherit the session model and reasoning
settings. New agent discovery can require a new session.

Example requests:

- `Use $profile-efficiency to compare profiling methods for this revision.`
- `Use $profile-efficiency to profile the sampler at 1, 5, and 10 Hz. Use the available benchmark thread counts. Rank CPU and memory costs. Do not change production code.`
- `Use $profile-efficiency to profile collector ingest, SQLite rollups, replay, and /api/live under the same input. Limit measurements to 10 minutes.`
- `Use $profile-efficiency to test GCC PGO after profiling. Train on representative workloads and validate on separate cases.`

Custom agent files follow the [official OpenAI agent schema](https://learn.chatgpt.com/docs/agent-configuration/subagents#custom-agent-file-schema).
The definition owns the workflow. This document owns the technique comparison
and command examples.

## Method selection

| Technique | Evidence | Use and limits |
| --- | --- | --- |
| Native benchmark and `/proc` | CPU time, completed work, latency, RSS/PSS, I/O | Establish and validate efficiency. No function attribution. Short runs can miss periodic work. |
| `perf stat` | Instructions, cycles, branches, faults, context switches | First native cost check. Hardware events depend on the CPU and permissions. Check counter multiplexing. IPC alone is not an efficiency score. |
| `perf record`, `report`, `annotate` | Sampled CPU stacks and source/assembly attribution | Preferred CPU attribution. Requires valid unwind data and symbols. Sampling omits blocked time and can miss short functions. |
| Callgrind/Cachegrind | Instruction counts, call paths, simulated cache/branch events | Useful for small repeatable cases and a fallback when `perf` is unavailable. Slower execution changes live timing. No kernel instruction cost; cache results are simulated. |
| Allocation tests, Massif, heaptrack | Allocation invariants, heap peaks, allocation paths | Run existing allocation checks first. Massif can include stacks or mapped pages in separate modes. heaptrack needs working allocation interception. Heap size is not RSS/PSS. |
| `strace -c` | Syscall counts, errors, and syscall timing | Explain repeated `/proc` reads, UDP sends, or SQLite writes. Tracing can change timing substantially. Blocking elapsed time is not CPU time. |
| `perf sched`, eBPF/bpftrace | Scheduling, lock, and I/O wait events | Use when CPU profiles do not explain wall latency. Requires appropriate tracepoints and permissions. Filter to the component and bound the capture. |
| `gprof` with `-pg` | Instrumented call graph and sampled user CPU | Secondary option. Requires a different build. Kernel work, blocking, and threaded behavior need other evidence. |
| GCC/Clang compiler PGO | Compiler decisions from execution profiles | Test after workload coverage is established. Training can favor one case and regress another. Profile formats are compiler-specific. |
| Sample PGO, LLVM BOLT | Sample-based compiler feedback or binary layout | Later options for a measured CPU or instruction-layout problem. Require compatible toolchains, profile conversion, and binary metadata. Do not add them to the default build without evidence. |

Sources: [perf tutorial](https://perfwiki.github.io/main/tutorial/),
[Callgrind](https://valgrind.org/docs/manual/cl-manual.html),
[Massif](https://valgrind.org/docs/manual/ms-manual.html),
[heaptrack](https://github.com/KDE/heaptrack),
[bpftrace](https://bpftrace.org/docs/release_024/stdlib),
[gprof](https://sourceware.org/binutils/docs/gprof/Introduction.html), and
[LLVM BOLT](https://github.com/llvm/llvm-project/blob/main/bolt/README.md).

Start with native measurements and CPU sampling. Add a second technique only
when it answers a specific unresolved question. Use compiler PGO after the
profile identifies relevant paths and the training workload covers them.

## Build and workload scope

Run commands from an isolated worktree. Keep the default optimization level,
warning checks, and linkage for the first profile. Add debug information:

```sh
make CXX=g++ CXXFLAGS='-O2 -g -Wall -Wextra -Werror -Wconversion -Wshadow' all
```

Select an installed compiler with C++23 library support. The sampler is fully
static by default. The collector embeds the C++ runtime and uses dynamic libc
and SQLite. Do not assume that preload-based allocation tools see the static
sampler. A dynamic diagnostic build with `SAMPLER_LDFLAGS=` can help allocation
analysis. Record this linkage change and confirm conclusions on the normal build.

Use DWARF unwinding for the first native CPU capture. A frame-pointer diagnostic
build can use `-fno-omit-frame-pointer` with `--call-graph fp`. This changes code
generation. Dependencies can still lack frame pointers. Check stack quality and
measure the build's cost before comparing it with a release build.

Inspect the benchmarks present in the requested revision. The sampler benchmarks
from [PR #72](https://github.com/breakbadsp/triangulator/pull/72) are now in master.
The agent also supports older revisions without these drivers. Check the current
`--help` output when the drivers are present:

```sh
python3 tests/benchmark_sampler.py --help
python3 tests/benchmark_sampling.py --help
```

`benchmark-sampler` measures the real sampler's CPU and memory at configured
rates. `benchmark-sampling` measures the thread sampling loop without rate
limiting. The latter excludes UDP, resource samples, and memory maps. Its helper
keeps four `/proc` files open per thread. A result from this helper does not
establish the efficiency of the complete sampler. Never use a helper's compiler
PGO profile as a profile for the production executable.

If a benchmark is absent, use an owned workload with separate sampler and
collector configurations. Count completed records or datagrams. State the
missing coverage. Run long enough for enabled resource, memory-map, rollup,
and replay intervals. Include startup and retained-memory measurements separately
from steady-state CPU attribution.

For each component, compare CPU nanoseconds per completed work item. Derive this
from user plus system CPU time divided by completed work. Also report CPU as a
percentage of one core, throughput, latency percentiles with sample counts,
missed ticks or drops, RSS/PSS, allocation counts, and I/O bytes when available.
Do not compare only percentages or report unavailable metrics as zero.

## Native CPU commands

Create a unique output directory, then select a verified component PID. Warm up
the workload before capture. `profile_pid` below is the sampler or collector PID,
not the benchmark driver or target workload PID.

```sh
mkdir -p build/profiles
profile_dir=$(mktemp -d "$PWD/build/profiles/run-XXXXXX")
profile_pid=12345
perf stat -p "$profile_pid" -o "$profile_dir/stat.txt" \
  -e task-clock,cycles,instructions,branches,branch-misses,context-switches,page-faults \
  -- sleep 30
perf record -p "$profile_pid" -o "$profile_dir/perf.data" \
  -e cpu-clock -F 99 --call-graph dwarf,16384 -- sleep 30
perf report -i "$profile_dir/perf.data" --stdio --no-children \
  > "$profile_dir/self.txt"
perf report -i "$profile_dir/perf.data" --stdio --children \
  > "$profile_dir/inclusive.txt"
perf annotate -i "$profile_dir/perf.data" --stdio > "$profile_dir/annotate.txt"
```

The placeholder PID must be replaced before execution. Check all command exit
statuses and stderr. Attach and launch modes have different permission rules.
If hardware events are unavailable, try permitted software events and mark the
hardware measurements unavailable. If attachment is blocked, use an owned launch
when permitted. Do not change host permissions to make a profile work.

Keep the exact binary and symbols before rebuilding. Record their SHA-256 and
ELF build ID with `sha256sum` and `readelf -n`. Retain stderr, event coverage,
sampling frequency, lost-sample counts, and unknown-symbol fractions. Check
profiler overhead against a comparable capture without a profiler.

Use self cost to locate direct work. Use inclusive cost to find expensive call
paths. Inclusive values overlap. Inspect user and kernel cost separately. A low
CPU fraction with high latency requires wait evidence, such as a focused scheduler
or syscall trace. CPU sampling cannot establish time spent waiting for a lock.

## Instruction and memory commands

Use a bounded invocation of the relevant component or benchmark executable:

```sh
valgrind --tool=callgrind \
  --callgrind-out-file="$profile_dir/callgrind.out.%p" \
  ./build/triangulator-sampler "$profile_dir/sampler.toml"
```

The sampler configuration must select an owned target and a test receiver.
The sampler runs until signalled. Stop only this test process with SIGTERM after
the requested interval and wait for the profile to be written. For steady-state
attribution, use `callgrind_control -z PID` after warm-up and request a dump with
`callgrind_control -d steady-state PID` before shutdown. Analyze the correct dump,
not a sum of startup, steady-state, and shutdown profiles. Use control commands
only for the verified test PID. Instrument the C++ component directly; wrapping
the Python driver does not profile its children by default.

Select one completed dump. Replace the example filename with its actual name:

```sh
profile_dump="$profile_dir/callgrind.out.12345.1"
callgrind_annotate --inclusive=no --auto=no --threshold=100 "$profile_dump"
callgrind_annotate --inclusive=yes --tree=both --auto=no --threshold=100 "$profile_dump"
```

Start with instruction counts; enable cache and branch simulation only when
needed. Treat simulated misses as a hypothesis for a native counter check.
Live runs under Valgrind can miss sampling deadlines. Record this distortion.
Enable `--cache-sim=yes --branch-sim=yes` for a focused simulation run.
After a counter reset, Callgrind can report synthetic `(below main)` entries
with impossible self costs. The full threshold exposes the function table even
when these entries exceed the default threshold. Exclude synthetic root entries
from bottleneck rankings and check the profile's event totals.

For heap attribution, use a separate run:

```sh
valgrind --tool=massif --stacks=yes \
  --massif-out-file="$profile_dir/massif.out.%p" \
  ./build/triangulator-collector "$profile_dir/collector.toml"
```

Use test-only ports and a separate data directory. Bound the run and stop it
normally. For mapped reservations, use a separate Massif run with
`--pages-as-heap=yes` instead of `--stacks=yes`. Compare these findings with
`/proc/PID/smaps_rollup`. Heap, mapped address space, RSS, and PSS are different
quantities. Check static-link compatibility before using heaptrack. Preserve
the [sampler allocation rules](tigerstyle-adaption.md) and
[collector allocation exclusions](collector-allocations.md).
Use `ms_print FILE` with the actual completed Massif file.

## Compiler PGO experiment

Use a new experiment worktree. Retain an ordinary optimized binary as the
baseline. Keep the same compiler, source, non-profile flags, linkage, and output
paths for profile generation and use. Do not disable `-Werror` to accept stale
or missing profiles. Check compiler diagnostics and profile file contents.

For GCC, add `-fprofile-generate=DIR -fprofile-update=atomic` at compilation
and linking. Train the production executable with representative inputs. Stop
it through its normal signal handler so it exits and writes `.gcda` files.
Rebuild with `-fprofile-use=DIR`. Use a separate absolute profile directory for
each executable. GCC encodes output paths in profile filenames; an output name
change can make data unavailable. The Makefile tracks changed compiler flags
and rebuilds affected binaries. See [GCC profile options](https://gcc.gnu.org/onlinedocs/gcc/Instrumentation-Options.html)
and [profile use](https://gcc.gnu.org/onlinedocs/gcc/Optimize-Options.html).

For Clang, compile and link with `-fprofile-instr-generate`. Use
`LLVM_PROFILE_FILE="$profile_dir/train-%m-%p.profraw"` for training processes.
Add `-fprofile-update=atomic` for threaded training when supported by the
installed compiler. Merge completed
profiles with the matching `llvm-profdata` version:

```sh
llvm-profdata merge -o "$profile_dir/train.profdata" "$profile_dir"/train-*.profraw
```

Rebuild with `-fprofile-instr-use=FILE`. Do not mix GCC and Clang profile formats.
See the [Clang PGO procedure](https://clang.llvm.org/docs/UsersManual.html#profile-guided-optimization).

Keep training and validation inputs separate. Training must cover realistic
thread counts, rates, periodic work, and relevant configuration modes. Include
error and recovery paths where relevant. Compare ordinary and PGO binaries
without profiling instrumentation. Interleave repeated runs on the same host.
Keep feature settings and completed-work checks equal. Run `make check` for the
candidate build. Report CPU/work, memory, throughput, tail latency, drops, binary
size, spread, and regressions before proposing adoption. Sample PGO or BOLT needs
a separate compatibility check and evidence of a relevant code-layout cost.

## Findings record

Store raw data under `build/profiles/<UTC-time>-<revision>/`. Keep a small report
beside it. Include environment and binary identity, exact commands, workload
coverage, baseline metrics, repetition spread, and profiling overhead.

For each finding, give the component, symbol/source line, absolute cost per work
item, self/inclusive cost, evidence path, confidence, proposed experiment, and
tradeoff. Label measurements and hypotheses separately. Include failed captures
and unavailable tools. Estimate the maximum total benefit from the affected cost
fraction. Validate any candidate with native benchmarks and correctness checks.
Commit a summary under `docs/profiling/runs/` only when requested. Keep bulk data
and binaries out of Git.
