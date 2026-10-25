<p align="center">
  <img src="docs/assets/banner.svg" alt="Triangulator: see what every thread of a Linux process is doing, live and recorded." width="100%">
</p>

<p align="center">
  <a href="#quick-start">Start</a> ·
  <a href="#dashboard-tour">Tour</a> ·
  <a href="#how-it-works">Architecture</a> ·
  <a href="#time-travel">Replay</a> ·
  <a href="#performance">Performance</a> ·
  <a href="#documentation">Docs</a> ·
  <a href="https://github.com/breakbadsp/triangulator/releases">Downloads</a>
</p>

Monitor a Linux process, its threads, CPU demand, wait channels, memory, and socket I/O.
Inspect live activity or return to a recorded moment.
One sampler monitors several targets on each host. See the
[multi-target decisions](docs/multi-target-design.md).

## Dashboard tour

<p align="center">
  <img src="docs/assets/dashboard-tour.gif" alt="Dashboard tour: process overview, thread activity, resource pressure, and thread details." width="880">
</p>

The animation shows an earlier layout. The current dashboard opens on
**Targets**: one tile per monitored process, with its assessment. Select a
tile to open that process on **Summary**: Assessment, key measurements,
process load, and memory use.
Use the section links for **Threads**, **Resources**, **Sockets**, **Memory**,
**Monitor**, and **Settings**. Open **Timeline** below the summary charts for
recordings and past assessments.

Assessment lists the most severe findings first. Select **Show … more findings** to read
the rest. Use **Settings** to edit watched-thread rules. Use **Theme** in the
header to select **System**, **Light**, or **Dark**. Metric help includes a
**Source** line and a detailed **Source** section.

<p align="center">
  <img src="docs/assets/features.svg" alt="Animated examples: thread states, wait timelines, and resource pressure." width="100%">
</p>

- Read metric help in the dashboard for sources, units, and interpretation.
- See [measurement limits](docs/measurement-limits.md) before drawing conclusions from samples.
- See [collector settings](config/collector.toml) for watched threads.

## Quick start

Use Linux and run as the monitored process user.
Source builds need a C++23 compiler with `std::expected` and `std::format`, Make,
SQLite development files, and static C/C++ runtime libraries.
Target control needs Python 3.11+. Building the collector needs Node.js 24+ and npm.
Prefer binaries? See [release packages](#release-packages).

```sh
git clone https://github.com/breakbadsp/triangulator.git
cd triangulator
scripts/start.sh
scripts/set-target.sh 1234  # Replace 1234 with your process ID.
```

Open **<http://127.0.0.1:9401>**. On the **Targets** overview, use **Add target**
and the **Remove** button on a tile to change the monitored processes. The
target selector on a process page changes only the current tab.

| Default | Value |
| --- | --- |
| Sampling | Threads: up to 5 Hz · CPU budget: 1% of one core · Resources: 2 s · Memory: 30 s |
| History | Recordings: 1 s · Retention: 7 days · Raw samples: enabled |
| Runtime files | `~/triangulator/` |

Use `scripts/stop.sh` to stop. Use `scripts/restart.sh all` after source changes.
Active configuration, logs, and data are under `~/triangulator/`.
Use `TRIANGULATOR_HOME` for an isolated installation.
Raw samples and recordings can use substantial disk space; configure retention
in [collector.toml](config/collector.toml).

Monitor several processes with one sampler:

```sh
scripts/set-target.sh --add orders 1234
scripts/set-target.sh orders 5678
scripts/set-target.sh --remove orders
```

Use unique target IDs. Keep at least one target. See
[multiple-target configuration](sampler/README.md#multiple-targets) and
[per-target collector settings](collector/README.md#per-target-settings).

## How it works

<p align="center">
  <img src="docs/assets/architecture.svg" alt="The sampler reads /proc and sends UDP to the collector. The collector stores SQLite day files and serves the dashboard over HTTP. Alerting is not connected." width="100%">
</p>

[Design decisions](docs/design-decisions.md) ·
[Sampler impact](docs/target-impact.md) ·
[Sampler](sampler/README.md) · [Collector and API](collector/README.md)

<details>
<summary>Inside the collector: animated data flow and packet recovery</summary>

<img src="docs/assets/collector-internals.svg" alt="UDP receive, tick assembly, per-thread state, five-second rollups, SQLite storage, and live HTTP snapshots." width="100%">

<img src="docs/assets/resilience.svg" alt="The collector reorders datagrams and uses partial ticks when packets are lost." width="100%">

[Measurement limits](docs/measurement-limits.md) · [Wire format overview](docs/wire-format-overview.html) (open the HTML file locally)

</details>

## Time travel

<p align="center">
  <img src="docs/assets/replay.svg" alt="Animated replay: a timeline cursor selects a recorded moment and the thread tiles show the stored states." width="100%">
</p>

Open **Timeline** below the Summary charts. Open **Past assessments** and select
a finding, or drag the timeline handle back and release it, to inspect a
recorded moment. Filter past findings by severity and type. Scroll the list or
select **Load earlier** to check an earlier period. Select **Live** to return.
Past assessments check selected recordings in the browser. They can miss brief
problems and are computed again after a page reload.
[Recording and replay limits](docs/measurement-limits.md#sampling-and-history)

## Performance

<p align="center">
  <img src="docs/assets/performance.svg" alt="Benchmark at 1,000 threads and 10 Hz: C++ collector CPU use was 4.08% of one core versus 32.2% for the former Python collector. Dashboard p95 latency was 0.89 ms versus 78.8 ms." width="100%">
</p>

[Benchmark method, results, and limits](docs/collector-comparison.md)

### Sampler performance lab

[![Measured sampler latency and throughput for 100, 300, and 500 native threads at 10 Hz](docs/assets/sampler-benchmark.svg)](docs/sampler-benchmark.html)

[**Open the interactive benchmark page**](docs/sampler-benchmark.html).
Download the HTML file and open it in a browser, or serve the repository with
`python3 -m http.server 8000` and visit
`http://localhost:8000/docs/sampler-benchmark.html`. The page works offline.
Select **1, 2, 5, or 10 Hz** to compare latency, delivered thread records per
second, CPU, and resident memory. Inspect the frequency grid and all 12 cases.

Measured with 100, 300, and 500 native threads: one busy thread; all others
sleep. Each case has three 30-second trials after at least five seconds of
warm-up. Latency includes `/proc` reads and loopback UDP delivery. Throughput
is the delivered rate at the configured frequency. Results apply to this host
and workload. The page defines each metric and its limits.

The driver timestamps datagrams with the kernel (`SO_TIMESTAMPNS_NEW`), so it
needs Linux 5.1 or later (or a vendor backport). On older kernels, such as the
4.18 kernel in AlmaLinux 8, it stops with "kernel receive timestamp is missing".
A tick that starts late or has latency over one period is counted
(`late_ticks`, `latencies_over_period`) and stays in the percentiles. Only a
lost or incomplete tick stops the run.

```sh
make benchmark-sampler-matrix  # About 22 minutes; writes build/sampler-benchmark.json
```

[Raw trials and host details](docs/sampler-benchmark.json) ·
[Benchmark driver](tests/benchmark_sampler.py) ·
[Native thread workload](tests/benchmark_target.cpp)

### Thread sampling throughput and latency

Measured directly on the same host on 2026-10-12. Each target has one busy
thread; its remaining threads sleep. Each row contains **30,000 timed batches**:
three repeats of 10,000 batches, each after a 5-second warm-up.

| Threads | Thread records/s | Mean batch (ms) | p50 (ms) | p90 (ms) | p99 (ms) | p100 (ms) | Mean/thread (µs) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 64,539 | 0.015 | 0.015 | 0.015 | 0.031 | 0.054 | 15.494 |
| 100 | 160,215 | 0.624 | 0.614 | 0.656 | 0.747 | 1.106 | 6.242 |
| 200 | 154,751 | 1.292 | 1.244 | 1.437 | 1.669 | 4.974 | 6.462 |
| 300 | 149,685 | 2.004 | 1.901 | 2.337 | 2.641 | 5.725 | 6.681 |
| 500 | 153,726 | 3.253 | 3.152 | 3.525 | 4.435 | 9.008 | 6.505 |

A batch validates the PID, scans the thread list, reads each thread's `stat`,
`schedstat`, `io`, and `wchan`, and constructs its sample record. The benchmark
uses the production sampler functions and keeps their file descriptors open.
`CLOCK_MONOTONIC` measures each batch. Timing ends when the thread records are
complete. UDP, collector processing, resource scans, and memory-map scans are
outside this measurement.

Throughput is total thread records divided by total timed sampling duration.
The loop runs without a frequency limit. Percentiles use the nearest rank across
all three repeats; **p100 is the observed maximum**. Mean/thread is mean batch
time divided by the thread count, including the shared batch costs. All five
thread counts were measured directly. Keep host load comparable between runs.

Run the sampling benchmark:

```sh
make benchmark-sampling
```

After a performance change, rebuild and compare with the saved baseline:

```sh
make build/benchmark-sampling build/benchmark-target
python3 tests/benchmark_sampling.py --compare docs/sampling-performance.json
```

The test writes `build/sampling-performance.json` and prints throughput and
latency changes. It rejects comparisons with different case settings, host
metadata, build options, or target binaries. The saved results include summaries
for each repeat, pooled percentiles, source and binary hashes, and the method.
[Saved baseline](docs/sampling-performance.json) ·
[Test driver](tests/benchmark_sampling.py) · [Timed sampling path](tests/benchmark_sampling.cpp)

## Test results

Run `make check` for the normal checks. The dashboard check includes the pinned
`777cf3a` parity oracle. It needs no Git history or network after dependencies
are installed. Run `npm --prefix dashboard run check:controls` to verify that
incorrect average timing, an early RSS PID filter, and an undefined help link
are rejected. `npm --prefix dashboard run check:oracle-source` verifies the
fixture extraction and needs that pinned Git commit locally.

After `make check`, run `node tests/prove_dashboard.mjs` for the real collector
and Chromium proof. It uses owned fixtures and ports. Set `CHROMIUM` to select
the browser executable. This script does not record manual package QA passes.

Manual browser QA results are kept in the repository and checked in CI. Each case links to a
dated run record with its package version, steps, and evidence.
These results describe the tested versions. Cases marked `NOT_RUN` have no
recorded execution result.

<!-- qa-summary:start -->
| Status | Cases | Case IDs |
| --- | ---: | --- |
| PASSED | 46 | - |
| FAILED | 6 | QA-004, QA-060, QA-061, QA-071, QA-075, QA-078 |
| BLOCKED | 16 | QA-006, QA-008, QA-012, QA-013, QA-014, QA-049, QA-050, QA-051, QA-066, QA-084, QA-086, QA-089, QA-090, QA-091, QA-093, QA-112 |
| NOT_RUN | 48 | QA-007, QA-009, QA-020, QA-021, QA-022, QA-023, QA-024, QA-025, QA-026, QA-028, QA-029, QA-030, QA-031, QA-034, QA-035, QA-036, QA-037, QA-038, QA-039, QA-045, QA-046, QA-048, QA-052, QA-053, QA-054, QA-055, QA-056, QA-057, QA-058, QA-062, QA-063, QA-064, QA-067, QA-068, QA-069, QA-070, QA-079, QA-080, QA-081, QA-094, QA-095, QA-096, QA-097, QA-098, QA-099, QA-100, QA-121, QA-122 |
| **Total** | **116** | |
<!-- qa-summary:end -->

[All case results](docs/qa/test-cases.md#current-results) ·
[Run records](docs/qa/runs/) ·
[CI check](https://github.com/breakbadsp/triangulator/actions/workflows/qa-results.yml) ·
[How QA runs](docs/manual-qa.md)

## Documentation

- [Design decisions](docs/design-decisions.md) and [multi-target decisions](docs/multi-target-design.md).
- [Measurement limits](docs/measurement-limits.md) and [C++ standards](docs/cpp-coding-standards.md).
- [Sampler](sampler/README.md), [collector](collector/README.md), and [configuration](config/).
- [HTTP server animation](docs/dashboard-http-animation.html) and [wire format animation](docs/wire-format-overview.html).
- [Bug lab](bug-lab/README.md), [manual QA](docs/manual-qa.md), [test cases](docs/qa/test-cases.md), and [planned work](TODO.md).

## Release packages

- Download matching sampler and collector archives and their `.sha256` files from [Releases](https://github.com/breakbadsp/triangulator/releases).
- Choose `el8` or `el9` for the target platform. Install the sampler on the monitored host and the collector on the monitoring host.
- Check each archive with `sha256sum -c ARCHIVE.sha256`, then extract with `tar -xzf ARCHIVE -C ~`.
- On one host, run `~/triangulator/scripts/start.sh`, then `~/triangulator/scripts/set-target.sh PID`.
- For separate hosts, set the sampler's collector address and the collector's allowed sampler address in their active configuration. Set `clock_ticks` from `getconf CLK_TCK` on the sampler host.
- Keep HTTP on loopback. For remote access, use `ssh -L 9401:127.0.0.1:9401 USER@COLLECTOR_HOST` and open <http://127.0.0.1:9401>.
- Service examples: [deploy](deploy/). Optional socket observer: [startup script](scripts/watch-sockets.sh).

**Limits:** Socket observation requires optional eBPF setup. Message counts require an application marker.
[Alert delivery](alerting/README.md) is not connected. UDP and HTTP have no authentication;
use loopback HTTP and the SSH tunnel above.

[MIT license](LICENSE)
