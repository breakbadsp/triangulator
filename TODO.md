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

## Required before adding new resource sources

- [ ] Define scope, identity, units, missing-data behavior, sampling budget,
  versioned transport, storage and API for the first new metric batch.
- [ ] Keep reports and alerting separate; add reset/permission/namespace tests
  and measure sampling overhead for each implementation.
