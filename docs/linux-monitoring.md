# Linux monitoring coverage and priorities

This is the implementation inventory and proposed roadmap as of 2026-10-06.
It describes repository capabilities, not which optional sources are running on
a particular deployment. Track unfinished work in [TODO.md](../TODO.md).

## What Triangulator monitors today

The ordinary sampler watches **one target process and its threads**, not the
whole host. The implemented sources are in `sampler/parsing.hpp` and
`sampler/proc.hpp`; derived metrics and history are in `collector/engine.hpp`.

- **CPU:** per-thread user and kernel CPU counters, combined CPU percentage
  relative to one core, and the last CPU the thread ran on.
- **Scheduling:** runnable time waiting for CPU and scheduling timeslices from
  `schedstat`. With configured `status_fallback`, voluntary and involuntary
  context-switch counters replace these; run-delay percentage is unavailable.
  Timeslices in normal mode are not the same measurement as context switches,
  although the dashboard currently labels the rate “Switches/s”.
- **Thread activity:** TID, name, group, thread counts, sampled scheduler state,
  wait-channel symbol, inferred socket/poll/futex waits, and recent state mix.
  These are approximate sampled observations, not exact blocked durations or
  identification of a lock's owner.
- **I/O syscall traffic:** per-thread `rchar`/`wchar` deltas and byte rates.
  These are neither disk-device bytes nor complete socket traffic counters.
- **Major page faults:** per-thread cumulative counters and fault rates.
  Memory usage and minor faults are not collected.
- **Monitor health:** sampler last seen/silence, target present/absent, session
  changes, packet counters, estimated UDP loss, and stale thread data.
- **History:** per-thread SQLite rollups and raw scheduler records by default.
- **Memory-map samples** (every `memory_interval_s`, default 30 s, no
  privileges): the address-space summary from `/proc/PID/status`, `stat` and
  `limits`, and the layout from `/proc/PID/maps`. See
  [memory-map.md](memory-map.md).
- **Resource samples** (every `resource_interval_s`, default 5 s, no
  privileges): host and cgroup v2 pressure stall information for CPU, memory
  and I/O; open descriptors against the soft and hard limits; process-wide
  `/proc/PID/io` (block-layer and syscall bytes, syscall counts); the target's
  own sockets through sock_diag (receive/send queues, buffer sizes and use,
  drops, TCP RTT, retransmissions, peer window and window-limited time, TCP
  state counts, listener backlogs); process memory (RSS split, peak, swap);
  the target's cgroup memory, OOM-kill, CPU-throttling and pids figures;
  interface errors and drops; its network namespace's TCP/UDP drop,
  overflow, retransmission and memory counters and sockstat; and socket
  memory sysctls. Details and limits are in
  [resource-monitoring.md](resource-monitoring.md).
- **Optional socket source:** eBPF observations of received/sent bytes and
  operations, process totals/rates, and thread/socket-kind breakdowns for TCP
  IPv4/IPv6 and Unix stream/datagram/seqpacket. UDP is excluded. Application
  messages completed require an explicit completion marker. Coverage and loss
  limits are documented in [socket-ingress-design.md](socket-ingress-design.md).

**Not implemented:** host CPU/memory context (`/proc/stat`, `meminfo`,
`vmstat`), PSS, ancestor cgroup limits and cgroup v1, disk capacity and device
statistics, per-interface statistics, or active alert delivery. `alerting/` contains starting code but is not connected.

## Most important additions

Priority reflects this project's process/thread troubleshooting focus. P0 means
the first implementation batch; P1 follows it; P2 is workload-dependent. A busy
CPU alone does not establish a problem: correlate usage with pressure, limits,
errors, and application latency.

### P0: memory, pressure, capacity and actionable alerts

1. **Process memory.** Read `/proc/PID/status`: RSS, anonymous/file/shared RSS,
   RSS high-water mark, virtual size, and swap. Track growth, not just current
   size. RSS is approximate; optionally sample `smaps_rollup` at a much lower
   rate for PSS/private memory. Virtual size is not physical RAM usage, and
   memory shared by threads must be recorded once per process. See the
   [status manual](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html)
   and [proc documentation](https://docs.kernel.org/filesystems/proc.html).
2. **Host resource pressure.** *Done, with cgroup pressure, in resource
   samples.* Read `/proc/pressure/{cpu,memory,io}`: `some`,
   supported `full`, rolling averages and cumulative stall time. PSI tells us
   whether resource contention is stalling work. Mark unsupported fields as
   unavailable; system CPU `full` is not a meaningful signal. See
   [PSI documentation](https://docs.kernel.org/accounting/psi.html).
3. **Cgroup limits and throttling.** Resolve `/proc/PID/cgroup` against the
   visible cgroup mount. For v2 collect `cpu.stat`, `cpu.max`,
   `cpuset.cpus.effective`, `memory.current`, `memory.high`, `memory.max`,
   `memory.events`, swap usage/limit, `pids.current`, `pids.max`, `pids.events`,
   and cgroup PSI. Capture throttling, limit hits and OOM/OOM-kill increments;
   account for ancestor limits and unlimited values. Detect v1 explicitly and
   implement adapters separately. See the
   [cgroup v2 interface](https://docs.kernel.org/admin-guide/cgroup-v2.html).
4. **Host CPU and memory context.** Read `/proc/stat`, `/proc/loadavg`,
   `/proc/meminfo`, `/proc/vmstat`, and `/proc/swaps` for per-core usage,
   steal time, runnable load, available RAM, swap activity and reclaim.
   Load includes uninterruptible tasks; iowait is not a precise measure of
   application I/O delay. See the
   [proc documentation](https://docs.kernel.org/filesystems/proc.html).
5. **File-descriptor headroom.** *Done in resource samples, apart from the
   system-wide `file-nr`.* Count `/proc/PID/fd` entries and compare with
   the soft open-file limit in `/proc/PID/limits`. Track count and growth;
   `FDSize` is allocated table capacity, not the open FD count. Add system
   file-handle context from `/proc/sys/fs/file-nr`. See the
   [FD manual](https://man7.org/linux/man-pages/man5/proc_pid_fd.5.html) and
   [status manual](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html).
6. **Filesystem capacity.** Use `statvfs` for available bytes and free inodes
   on configured mounts, especially collector history and application data/log
   mounts. `/proc/PID/mountinfo` discovers mounts, but does not report free
   space. Full storage can stop both the application and its monitoring history.
   See [statvfs](https://man7.org/linux/man-pages/man2/statvfs.2.html).
7. **Working alerts.** Connect the separate alerting module: first sampler
   silence, target absence, sustained CPU/run delay and `D` state; then memory
   growth/pressure, cgroup OOM/throttling, FD headroom and disk capacity as their
   metrics become available. Add delivery, recovery, cooldowns and an independent
   dead-man check. Alert evaluation stays outside the collector's main loop.

### P1: disk and network bottlenecks

8. **Storage I/O.** *Process `/proc/PID/io` is done in resource samples;
   device statistics are not.* Collect process `/proc/PID/io` `read_bytes`, `write_bytes`,
   `cancelled_write_bytes`, `syscr` and `syscw` separately from existing
   `rchar`/`wchar`. Collect device `/proc/diskstats` for throughput, IOPS,
   average request time, in-flight requests and weighted queue time. Label
   these as interval averages, not latency percentiles. Avoid summing device,
   partition and device-mapper layers together; device busy time alone does not
   establish saturation on parallel devices. See the
   [process I/O manual](https://man7.org/linux/man-pages/man5/proc_pid_io.5.html)
   and [device I/O statistics](https://docs.kernel.org/admin-guide/iostats.html).
9. **Network health.** *Namespace TCP/UDP counters and per-socket queue,
   buffer and TCP diagnostics are done in resource samples; interface
   statistics are not.* Collect interface bytes/packets/errors/drops using
   rtnetlink or `/proc/net/dev`; add TCP retransmissions, connection failures,
   UDP errors and listen overflows from `/proc/net/{snmp,netstat}`. Inspect
   queues and TCP RTT/retransmission state through socket diagnostics netlink
   when permitted. Respect the target's network namespace: these totals are
   not automatically per-process traffic. Never infer application message
   completion from network bytes. See the
   [network statistics guide](https://docs.kernel.org/networking/statistics.html)
   and the existing [socket source contract](socket-ingress-design.md).
10. **Thread/process lifecycle and scheduler context.** Add minor faults,
    explicit voluntary/involuntary switch rates, thread creation/exit rates,
    restart counts, priority/nice and allowed CPUs. Existing session identities
    and thread counts provide part of this; lifecycle events between samples
    are missed, so churn from threads shorter-lived than the sample interval can
    be missed (see "Known limitations" in the thread monitor design; the
    dashboard labels thread churn as a lower bound). See the
    [proc documentation](https://docs.kernel.org/filesystems/proc.html).
11. **Application health.** Add instrumented request/message throughput,
    latency percentiles, errors, timeouts, queue depth and oldest queued-item
    age. These explain “slow but not hot” behavior that OS samples cannot.
    Extend the existing completion-marker contract or use a separate application
    metrics source; `/proc` cannot supply application semantics.

### P2: investigate when evidence points there

- **CPU/lock/I/O profiling:** on-demand perf/eBPF stacks, scheduler latency,
  lock waits and block-I/O latency distributions; privileges and kernel support
  must be checked. Keep continuous expensive tracing optional. See
  [perf security](https://docs.kernel.org/admin-guide/perf-security.html) and
  [BPF documentation](https://docs.kernel.org/bpf/).
- **Hardware:** temperatures, fans, voltages and power from `/sys/class/hwmon`;
  add thermal/frequency signals and device-specific disk/GPU health tools where
  relevant. Sensor availability depends on hardware and drivers. See the
  [hwmon interface](https://docs.kernel.org/hwmon/sysfs-interface.html).
- **Service and dependency health:** systemd unit state/restarts, kernel and
  application logs, endpoint probes, DNS/TLS checks and downstream latency via
  separate helpers. These complement resource counters and require their own
  event sources or application instrumentation.

## Implementation boundaries and acceptance criteria

- Collect process-wide gauges once per process and host gauges once per host;
  never duplicate shared memory or host totals across thread records.
- Keep performance-critical sampling, transport, ingestion and storage in C++
  or Rust. New metrics require an explicit versioned transport/storage design;
  do not repurpose fields in the existing thread protocol.
- Reports and richer dashboard calculations use separate programs reading
  SQLite read-only or the HTTP API. They never consume UDP or run inside the
  collector ingestion loop. Alerting remains a separate module.
- Start with configurable low sampling rates. Bound directory scans and caches;
  keep `smaps`, tracing and hardware probes off the per-thread sampling path.
- Record scope (host/process/thread/cgroup/device/interface), source identity,
  units and availability. Permissions, `hidepid`, namespaces, kernel options
  and exited targets can make data unavailable; that must not become zero.
- Use monotonic time for counter rates, detect resets/reboots/PID reuse, and
  preserve collection timestamps for correlation. Document CPU denominators
  and avoid double-counting shared resources and stacked devices.
- Each implementation needs parser/reset/unavailable-data coverage, live API
  and historical storage where applicable, and an overhead measurement.
  Build and pass `make check`; run `make format` for C++ changes.
