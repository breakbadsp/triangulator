# Monitoring TODO

See [Linux monitoring coverage and priorities](docs/linux-monitoring.md) for
what is implemented, Linux sources, measurement limits and acceptance criteria.
These are planned additions; optional socket monitoring is already implemented.

## P0 — first batch

- [x] Process memory: RSS, breakdown, high-water mark, swap and growth.
- [ ] Optional slower PSS sampling (`smaps_rollup`).
- [x] Host CPU/memory/I/O pressure (PSI), including availability reporting
  (also the target's cgroup; see docs/resource-monitoring.md).
- [x] Cgroup memory/CPU/pids limits, CPU throttling, memory limit hits and OOM
  kills (the target's own cgroup; ancestors' limits and cgroup v1 are not
  followed).
- [ ] Host context: per-core CPU, steal, runnable load, available memory,
  swap activity and reclaim.
- [x] Process open FD count, soft limit, headroom and growth.
- [ ] System-wide file handles (`/proc/sys/fs/file-nr`).
- [ ] Configured filesystem available bytes and inode headroom, including
  collector history storage.
- [ ] Connect separate alerting and delivery for existing thread/monitor health
  signals; extend rules as new resource metrics land, with recovery and an
  independent dead-man check. The resource rules of thumb (pressure,
  descriptors, socket buffers, drops) are in the dashboard; alerting can
  read the `resource_sample` table.

## P1 — bottlenecks and application impact

- [x] Process storage-byte/syscall counters.
- [ ] Device throughput, IOPS, average request time and queue metrics.
- [x] TCP retransmissions, UDP errors, listen overflows and socket
  queue/buffer/RTT diagnostics for the target's sockets.
- [x] Network interface errors/drops (summed, namespace-wide).
- [ ] Per-interface breakdown and speed/duplex.
- [ ] Thread/process churn and restart counts, minor faults, scheduler
  priority/affinity and explicit context-switch rates. Correct the current
  “Switches/s” label so normal-mode timeslices and fallback context switches
  are distinguished.
- [ ] Application latency, throughput, errors, timeouts and queue backlog
  using explicit instrumentation.

## P2 — optional diagnostics

- [ ] On-demand perf/eBPF profiling and latency distributions.
- [ ] Hardware temperatures/power, thermal/frequency signals and relevant
  disk/GPU health.
- [ ] Separate service/log/dependency health helpers.

## Deployment dependencies

Goal: deploy by copying binaries. See
[Deployment dependencies](README.md#deployment-dependencies).

- [x] Sampler: zero runtime dependencies. Link it fully statically (glibc,
  libstdc++, libgcc) and replace `getaddrinfo` with `inet_pton`, since only
  numeric addresses are accepted, so static glibc needs no NSS libraries at
  run time.
- [x] `make release`: build the three normal deployable binaries statically and
  reject dynamic loaders and dependencies with `readelf`.
- [ ] Define the oldest supported kernel and validate release binaries there.
- [x] Run `make check STATIC=1`'s end-to-end tests against the release binaries.
- [x] Collector and `triangulator-socket-report`: compile in SQLite from its
  single-file amalgamation (public domain) instead of linking
  `libsqlite3.so`, and link statically where it works (`SQLITE_SOURCE=...`).
- [ ] Optional eBPF socket sampler: link libbpf, libelf, zlib and zstd
  statically if their static libraries are available; otherwise document the
  packages it needs.
- [ ] Document the kernel features each source needs (PSI, sock_diag modules,
  BTF for eBPF) and what the dashboard shows when one is missing.

## Gaps found by the bug lab

From [docs/bug-lab-report.md](docs/bug-lab-report.md). The cheap fixes are done;
these need a core change, a privilege, or a decision.

- [ ] Count threads ever created. Short-lived threads (under one sample
  interval) can be missed, so thread churn is only a lower bound. No
  unprivileged per-process counter exists (measured in the report); needs an
  application hook, a privilege, or a new versioned wire field.
- [ ] Per-thread throughput or "waited on a lock" signal, to tell a deadlock
  or lock convoy from an idle pool. Today's hints are heuristics at info
  level; they miss a deadlocked pool of 4 or more threads and a single
  self-deadlocked thread.
- [ ] Return the sampler session with each `/api/resources` row, so the RSS
  trend can tell a restarted process from a reused pid.
- [ ] Send `RLIMIT_NPROC` (`ulimit -u`) and `kernel.threads-max`, so the
  thread-growth finding can name limits other than the cgroup's `pids.max`.
- [ ] Keep thread-count history in the collector, so a freshly opened
  dashboard tab can judge thread growth and idle time at once instead of
  after about two minutes.
- [ ] Report a yield or poll loop that does not reach 90% CPU (for example on
  a contended host); today only saturated threads get the kernel-time wording.
- [ ] Decide the severity of the deadlock and convoy hints: at info level
  the top badge still says "Healthy".

## Required before adding new resource sources

- [ ] Define scope, identity, units, missing-data behavior, sampling budget,
  versioned transport, storage and API for the first new metric batch.
- [ ] Keep reports and alerting separate; add reset/permission/namespace tests
  and measure sampling overhead for each implementation.

## Manual QA

- [ ] Resolve QA-001 from the v0.1.0 package run: it is PASSED, but its expected
  result requires browser diagnostics with no application error, and the run
  could not capture them. Re-run with console and network capture, or mark the
  case BLOCKED and update the counts in the run record.
- [ ] Re-run the four browser-blocked cases from the v0.1.0 package run (QA-004,
  QA-005, QA-102, QA-118) in a browser where clicks, typing and snapshots work.
  The run blocked them on T3 preview interaction failures, not product
  behavior. Update their statuses and the counts in the run record.
- [ ] Run QA-006 (upgrade) once a second published package exists; v0.1.0 has
  no earlier release to upgrade from.
