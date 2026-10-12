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

Monitor Linux process threads, CPU demand, wait channels, memory, and socket I/O.
Inspect live activity or return to a recorded moment.

## Dashboard tour

<p align="center">
  <img src="docs/assets/dashboard-tour.gif" alt="Dashboard tour: process overview, thread activity, resource pressure, and thread details." width="880">
</p>

<p align="center">
  <img src="docs/assets/features.svg" alt="Animated examples: thread states, wait timelines, and resource pressure." width="100%">
</p>

| Find the problem | Open the guide |
| --- | --- |
| CPU demand, busy threads, kernel waits | [Dashboard](docs/setup.md#dashboard) · [Metric help](collector/README.md#dashboard-help) |
| Memory use, address mappings, page faults | [Memory map](docs/memory-map.md) |
| CPU, memory, and I/O pressure; resource limits | [Resource monitoring](docs/resource-monitoring.md) |
| Socket bytes, rates, and message completion | [Optional eBPF setup](docs/setup.md#socket-io-and-messages-processed) · [Measurement limits](docs/socket-ingress-design.md) |

## Quick start

Use Linux and run as the monitored process user.
Install the [build requirements](docs/build-guidelines.md#dependencies), including Python 3.11+ for target control.
Prefer binaries? Use the [release package guide](docs/setup.md#install-from-a-release-package).

```sh
git clone https://github.com/breakbadsp/triangulator.git
cd triangulator
scripts/start.sh
scripts/set-target.sh 1234  # Replace 1234 with your process ID.
```

Open **<http://127.0.0.1:9401>**. Use **Change target** to select another process.

| Default | Value |
| --- | --- |
| Sampling | Threads: 1 Hz · Resources: 5 s · Memory: 30 s |
| History | Recordings: 1 s · Retention: 7 days · Raw samples: enabled |
| Runtime files | `~/triangulator/` |

[Stop and restart](docs/setup.md#stop-restart-and-change-settings) ·
[Settings and logs](docs/setup.md#active-files-and-logs) ·
[Storage costs](docs/collector-reference.md#historical-process-inspection)

## How it works

<p align="center">
  <img src="docs/assets/architecture.svg" alt="The sampler reads /proc and sends UDP to the collector. The collector stores SQLite day files and serves the dashboard over HTTP. Alerting is not connected." width="100%">
</p>

[Architecture](docs/architecture.md) · [Sampler design](docs/thread-monitor-design.md) ·
[Collector and API](docs/collector-reference.md) · [Deployment](docs/setup.md#production-setup)

<details>
<summary>Inside the collector: animated data flow and packet recovery</summary>

<img src="docs/assets/collector-internals.svg" alt="UDP receive, tick assembly, per-thread state, five-second rollups, SQLite storage, and live HTTP snapshots." width="100%">

<img src="docs/assets/resilience.svg" alt="The collector reorders datagrams and uses partial ticks when packets are lost." width="100%">

[Protocol and limits](docs/setup.md#how-it-behaves) · [Wire format overview](docs/wire-format-overview.html) (open the HTML file locally)

</details>

## Time travel

<p align="center">
  <img src="docs/assets/replay.svg" alt="Animated replay: a timeline cursor selects a recorded moment and the thread tiles show the stored states." width="100%">
</p>

Select **Inspect a moment**, step with **Previous** / **Next**, then select **Live** to return.
[Recording and replay limits](docs/collector-reference.md#historical-process-inspection)

## Performance

<p align="center">
  <img src="docs/assets/performance.svg" alt="Benchmark at 1,000 threads and 10 Hz: C++ collector CPU use was 4.08% of one core versus 32.2% for the former Python collector. Dashboard p95 latency was 0.89 ms versus 78.8 ms." width="100%">
</p>

[Benchmark method, results, and limits](docs/collector-comparison.md)

### Sampler with 500 target threads

Measured on 2026-10-12 with **500 native threads: one busy thread and 499 sleeping
threads**. The target used about 99.8% of one core. The host had an Intel Core
i5-9500 with six cores, Linux `7.2.5-3-omarchy`, and GCC 16.2.1. The sampler used
source `c92dcac`, `-O2`, and static linking.

| Rate | Sampler CPU (% of one core) | Mean RSS (MiB) | Max observed RSS (MiB) |
| --- | ---: | ---: | ---: |
| 1 Hz | 0.428% | 2.03 | 2.03 |
| 2 Hz | 0.843% | 2.03 | 2.03 |
| 5 Hz | 2.098% | 2.03 | 2.03 |
| 10 Hz | 4.107% | 2.03 | 2.03 |

CPU and mean RSS are averages of three 60-second runs per frequency. Each run
starts after a 5-second warm-up. CPU uses `/proc/PID/schedstat` execution time;
100% means one full core. RSS is resident process memory from
`/proc/PID/smaps_rollup`, read once per second and at the end. It excludes kernel
allocations. These results apply to this host and workload.

The sampler uses a target PID and the default settings: resources every 5 seconds,
memory maps every 30 seconds, and `status_fallback = false`. A loopback UDP
receiver checks all 500 thread IDs, sample continuity, and the actual frequency.
All 12 runs completed without lost thread samples or sampler warnings.

Repeat the full benchmark in about 13 minutes:

```sh
make benchmark-sampler
```

The test prints a table and writes `build/sampler-overhead.json`.
[Recorded measurements](docs/sampler-overhead.json) ·
[Test driver](tests/benchmark_sampler.py) · [Target workload](tests/benchmark_target.cpp)

## Test results

Manual browser QA results are kept in the repository and checked in CI. Each case links to a
dated run record with its package version, steps, and evidence.

<!-- qa-summary:start -->
| Status | Cases | Case IDs |
| --- | ---: | --- |
| PASSED | 32 | - |
| FAILED | 2 | QA-007, QA-105 |
| BLOCKED | 5 | QA-006, QA-008, QA-012, QA-013, QA-014 |
| NOT_RUN | 3 | QA-020, QA-021, QA-022 |
| **Total** | **42** | |
<!-- qa-summary:end -->

[All case results](docs/qa/test-cases.md#current-results) ·
[Run records](docs/qa/runs/) ·
[CI check](https://github.com/breakbadsp/triangulator/actions/workflows/qa-results.yml) ·
[How QA runs](docs/manual-qa.md)

## Documentation

| Task | Links |
| --- | --- |
| Install and run | [Setup guide](docs/setup.md) · [Release packages](docs/setup.md#install-from-a-release-package) · [Build](docs/build-guidelines.md) |
| Configure and deploy | [Configuration](docs/setup.md#configuration) · [Systemd services](docs/setup.md#production-setup) · [Files and logs](docs/setup.md#active-files-and-logs) |
| Understand measurements | [Linux metric coverage](docs/linux-monitoring.md) · [Resources](docs/resource-monitoring.md) · [Memory](docs/memory-map.md) · [Sockets](docs/socket-ingress-design.md) |
| Inspect data | [Dashboard](docs/setup.md#dashboard) · [Collector, storage, and API](docs/collector-reference.md) |
| Understand the code | [Architecture](docs/architecture.md) · [HTTP server animation](docs/dashboard-http-animation.html) · [Repository layout](docs/setup.md#layout) · [C++ standards](docs/cpp-coding-standards.md) |
| Test and contribute | [Bug lab](bug-lab/README.md) · [Manual QA](docs/manual-qa.md) · [Test cases](docs/qa/test-cases.md) · [Planned work](TODO.md) |

**Limits:** Socket observation requires optional eBPF setup. Message counts require an application marker.
[Alert delivery](alerting/README.md) is not connected. UDP and HTTP have no authentication;
use the [remote access setup](docs/setup.md#install-from-a-release-package).

[MIT license](LICENSE)
