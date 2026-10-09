# Pressure, limits and socket buffers

Status: implemented, including process memory, cgroup limits and interface
drops. The ordinary `/proc` sampler sends a **resource sample**
every `resource_interval_s` seconds (default 5). The collector stores it and
serves it live, and the dashboard's **Pressure, limits & sockets** section and
assessment read it. No privileges, eBPF or application changes are needed.

This document explains what is measured, why a support team needs it, how to
read it during an incident, and where the measurements stop.

## Why these signals

Thread samples show what each thread is doing: running, waiting for a CPU,
blocked in the kernel. They cannot tell *why* a healthy-looking process is
slow, or warn before it starts failing. Most production incidents that reach a
support team come down to a handful of shared resources:

| Symptom reported | Thread view shows | What explains it |
|---|---|---|
| Requests are slow, CPU is low | threads sleeping or in `D` state | **I/O or memory pressure** (PSI): time lost waiting for disk or reclaim |
| Latency spikes under load | run delay | **CPU pressure** in the cgroup: contention or a CPU quota |
| "Too many open files", failed accepts | nothing unusual | **descriptor headroom** against `RLIMIT_NOFILE` |
| Clients time out or get resets connecting | idle acceptor thread | **accept queue** full: `ListenOverflows`, listener backlog |
| Consumer lag, growing memory | busy reader thread | **receive queues** filling: the app is not reading fast enough |
| Writers block, a downstream is "slow" | threads waiting in socket wait | **send queues** full or a **zero window** from the peer |
| Missing UDP messages, metrics gaps | nothing | **UDP receive buffer errors** |
| Intermittent stalls on every connection | nothing | **TCP retransmissions** or **TCP memory pressure** |
| Slow leak of connections and descriptors | nothing | **CLOSE-WAIT** sockets the app never closes |

Each signal separates *the app is behind* from *something it depends on is
behind*, which decides who has to act.

## What is collected

All reads are of files and interfaces readable by the target's own user, as
the sampler already requires ([no-privilege rule](../README.md#production-setup)).

### Pressure stall information (PSI)

Sources: `/proc/pressure/{cpu,memory,io}` (host) and
`/sys/fs/cgroup/<cgroup>/{cpu,memory,io}.pressure` (the target's cgroup v2,
from `/proc/PID/cgroup`). See the
[PSI documentation](https://docs.kernel.org/accounting/psi.html).

- **some**: share of time at least one task was stalled waiting for the
  resource. Work was delayed.
- **full**: share of time *every* non-idle task was stalled at once. No work
  got done; this is lost throughput. The host-wide CPU `full` line is always
  zero and is reported only for compatibility.
- The sampler sends the kernel's `avg10` and the cumulative stall `total`.
  The collector turns totals into the exact stall share **over each sample
  interval**, which is what the dashboard charts and stores. `avg10` covers
  the first sample of a session.
- The cgroup view is what matters in containers and systemd services: a busy
  neighbour shows in host pressure, but the target's own stalls show in its
  cgroup. The dashboard uses the cgroup when it reports, and the host
  otherwise.

How to read it: I/O `some` above about 10% means some requests wait on storage
a noticeable part of the time; I/O `full` above about 5% means the workload is
stalled on storage. Memory `some` means reclaim, swap-in or refaults are
delaying tasks; any sustained memory `full` means thrashing. CPU `some` in a
cgroup with no host CPU pressure points to the cgroup's CPU quota (`cpu.max`).

### Descriptors

Sources: `/proc/PID/fd` (count, and which entries are sockets) and
`/proc/PID/limits` (`Max open files`, soft and hard). At the soft limit,
`accept()`, `open()` and `socket()` fail with `EMFILE`. Growth with steady
traffic usually means a leak; see also CLOSE-WAIT below. `FDSize` in
`/proc/PID/status` is the table size, not the open count, so it is not used.

### Process storage I/O

Source: `/proc/PID/io`, process-wide including exited threads.
`read_bytes`/`write_bytes` are what the process made the block layer read and
write; `rchar`/`wchar` count all read/write syscalls, including sockets, pipes
and the page cache. Use the block-layer rates with I/O pressure: high pressure
with little I/O from the target means it is suffering from someone else's I/O.

### The target's sockets: queues and buffers

Source: the kernel's sock_diag netlink interface
([sock_diag(7)](https://man7.org/linux/man-pages/man7/sock_diag.7.html)), the
same source as `ss -tmi`. It needs no privileges and lists the sampler's
network namespace; the sampler keeps the sockets whose inodes appear in
`/proc/PID/fd`. TCP (IPv4/IPv6), UDP and unix stream/datagram/seqpacket
sockets are covered.

For each socket:

- **Recv-Q**: bytes received but not yet read by the app. For a listener:
  connections that completed the handshake but wait for `accept()`.
- **Send-Q**: bytes the app wrote that are not yet sent or acknowledged. For
  a listener: the effective backlog, `min(listen() backlog, somaxconn)`.
- **Buffer fill**: queued memory against the socket's limit (`SO_RCVBUF`,
  `SO_SNDBUF`; `SO_MEMINFO`). A full receive buffer means the kernel prunes
  and then drops incoming data; a full send buffer makes writers block or get
  `EAGAIN`. Fill can pass 100% briefly because the kernel accounts in whole
  buffers.
- **Drops**: packets this socket dropped (`sk_drops`).
- TCP only (`TCP_INFO`, [tcp(7)](https://man7.org/linux/man-pages/man7/tcp.7.html)):
  smoothed RTT, retransmissions, bytes not yet sent, the peer's advertised
  window (Linux 6.2+), zero-window probes, and the share of time sending was
  limited by the **peer's receive window** (the peer is slow) or by the
  socket's **own send buffer** (raise `SO_SNDBUF`).

The sampler sends totals for all of the target's sockets, TCP state counts,
and the 24 sockets with the fullest buffers (listeners by backlog use).

How to read it:

| What you see | Meaning | Who acts |
|---|---|---|
| Receive buffer near 100%, Recv-Q growing | the app is not reading this socket fast enough | the app's owner: the reading thread is busy or blocked |
| Drops on a socket, `TCPRcvQDrop`, `RcvPruned` | data is being thrown away at a full receive buffer | the app's owner; a larger `SO_RCVBUF` only buys time |
| Send-Q growing, peer window 0, zero-window probes | the peer stopped reading | the peer's owner |
| Send buffer full, no zero window, high RTT or retransmits | the network path is slow or lossy | network team |
| "Limited by its own send buffer" | `SO_SNDBUF` too small for the path's bandwidth × delay | the app's owner: raise the buffer (capped by `wmem_max`) |
| Listener backlog full, `ListenOverflows` growing | the accept loop is too slow or the backlog too small | the app's owner; check `somaxconn` too |
| Cgroup hits `memory.max`, OOM kill | the container's memory limit is too small, or the app grew | the app's owner or whoever sets the limit |
| CPU throttled % high with idle cores | `cpu.max` quota too small for the burst | whoever sets the limit |
| Interface drops or errors growing | loss at the network card or driver | network / host team |
| Many CLOSE-WAIT sockets | peers closed but the app never closed its end: a leak | the app's owner |

### Network namespace counters

Sources: `/proc/PID/net/{snmp,snmp6,netstat,sockstat}`, read through the
target's PID so they describe *its* namespace even in a container. They are
shared by every process in that namespace, so they say "this host or
container is dropping", not "this process is dropping". Combine them with the
per-socket view to attribute.

- Accept path: `ListenOverflows`, `ListenDrops` (all listen drops, overflows
  included), `TCPReqQFullDrop`, `SyncookiesSent`.
- Slow readers: `TCPRcvQDrop`, `TCPBacklogDrop`, `TCPZeroWindowDrop`,
  `PruneCalled`, `RcvPruned`, `OfoPruned`.
- Path quality: `RetransSegs` against `OutSegs`, `TCPTimeouts`,
  `TCPAbortOnTimeout`, `EstabResets`, `AttemptFails`.
- Memory: `TCPMemoryPressures`, `TCPAbortOnMemory`, UDP `MemErrors`, and
  sockstat TCP/UDP memory against `net.ipv4.tcp_mem`/`udp_mem` (pages,
  host-wide). Under TCP memory pressure the kernel shrinks every socket's
  buffers, which slows all connections.
- UDP (IPv4 and IPv6 summed): `RcvbufErrors` (dropped at a full receive
  buffer), `SndbufErrors`, `InErrors` (includes `RcvbufErrors`), `NoPorts`.

The collector reports each as a total, its growth in the last interval and a
rate. See the [network statistics guide](https://docs.kernel.org/networking/statistics.html)
and [snmp counter descriptions](https://docs.kernel.org/networking/snmp_counter.html).

### Process memory

Source: `/proc/PID/status`: `VmRSS` split into `RssAnon` (heap and stacks),
`RssFile` (mapped files) and `RssShmem`, the high-water mark `VmHWM`, and
`VmSwap`. RSS counts memory shared with other processes in full, and the
dashboard shows its growth rate per interval; a steady climb with flat traffic
suggests a leak, and swap above zero together with memory pressure means the
process is paging.

### Cgroup limits, throttling and kills

Source: the target's own cgroup v2 files (ancestors' limits are not followed):
`memory.current`, `memory.max`, `memory.high`, `memory.events` (`max`,
`oom_kill`), `cpu.max`, `cpu.stat` (`nr_periods`, `nr_throttled`),
`pids.current` and `pids.max`. See the
[cgroup v2 interface](https://docs.kernel.org/admin-guide/cgroup-v2.html).

- **OOM kills** and **limit hits** (`memory.events`): the cgroup reached
  `memory.max`; a limit hit forces reclaim and stalls allocations before a kill
  happens. `memory.current` includes reclaimable page cache, so a high value
  alone is only a warning.
- **CPU throttling**: the share of CPU periods in the interval in which the
  quota ran out. Throttled threads wait even when cores are idle; this is the
  usual cause of latency spikes in containers with a CPU limit, and shows as
  cgroup CPU pressure but not as host pressure.
- **Processes and threads** against `pids.max`: at the limit `fork()` and
  thread creation fail.
- "max" (no limit) is unavailable, shown as "no limit".

### Network interface errors and drops

Source: `/proc/PID/net/dev`, summed over every interface in the namespace except
`lo`. Counted at the network card, before any socket sees the packet, so they
explain loss that no socket counter does. Bridges and veth pairs are counted
once each, so read the sum as "this namespace is dropping", not as an exact
packet count.

### Limits

`net.core.rmem_max`/`wmem_max` (the largest `SO_RCVBUF`/`SO_SNDBUF` an app may
set), `net.core.somaxconn` (the backlog cap), `net.ipv4.tcp_mem` and
`udp_mem`, and the page size. They are read from the sampler's namespace and
only when it is the target's.

## Rules of thumb in the dashboard

The assessment adds these findings. Like the thread rules, they point at where
to look; they are not a diagnosis, and the collector evaluates no alert rules.

| Finding | Level |
|---|---|
| I/O pressure `full` ≥ 5% / `some` ≥ 10% | serious / warning |
| Memory pressure `full` ≥ 2% / `some` ≥ 5% | serious / warning |
| CPU pressure `some` ≥ 20% | warning |
| Descriptors ≥ 90% / ≥ 75% of the soft limit | critical / warning |
| Listen drops or overflows in the last interval | serious |
| A listener's backlog ≥ 80% full | warning |
| A receive buffer ≥ 80% full (with drops: serious) | warning |
| A send queue with a zero peer window or a buffer ≥ 80% full (ESTABLISHED, CLOSE-WAIT, FIN-WAIT-1 and LAST-ACK sockets only; the window is unreported before Linux 6.2) | warning |
| UDP receive buffer errors in the last interval | serious |
| TCP receive-queue, backlog or zero-window drops | warning |
| Retransmissions ≥ 1% of segments sent (≥ 100 sent) | warning |
| TCP memory pressure | serious |
| 10 or more CLOSE-WAIT connections | warning |
| OOM kill in the last interval | critical |
| Cgroup hit `memory.max` / is ≥ 90% of it | warning |
| CPU quota throttled ≥ 25% / ≥ 5% of periods | serious / warning |
| `pids.current` ≥ 90% of `pids.max` | warning |
| Interface drops or errors in the last interval | warning |

They are implemented in `assessResources()` in `collector/dashboard.html` and
covered by `tests/dashboard_test.js`.

## Limits of the measurement

- **Unavailable is not zero.** Missing files (no PSI with `psi=0` or
  `CONFIG_PSI=n`, cgroup v1, no IPv6), unreadable descriptor links (another
  user, or a non-dumpable process) and failed netlink requests leave values
  unavailable, and flags in each sample say why.
- **Network namespaces.** sock_diag lists the sampler's namespace. When the
  target is in another one (a container), its sockets are not listed and the
  sample says so; run the sampler inside the target's namespace. Namespace
  counters are still the target's, through `/proc/PID/net`.
- **Unlistable sockets.** Netlink, raw and packet sockets, and UDP sockets that
  were never bound or connected, are not in sock_diag's tables. They are
  counted as "not listable".
- **Sampling.** Queues are point-in-time readings every interval; a burst that
  fills and drains between two samples is missed. Counters (PSI totals, drops,
  retransmissions) are cumulative, so their growth is exact even between
  samples. Per-socket counters for sockets outside the reported 24 are only in
  the totals.
- **Bounds.** At most 65,536 descriptor links are read per sample; beyond that
  sockets are not matched and the sample says so. A sock_diag dump stops after
  one million sockets. Dumps skip TIME-WAIT and half-open entries, which no
  descriptor owns. Each dump times out after one second.
- **Cost.** A sample reads about 20 small files plus one netlink dump per
  protocol of the whole namespace. On a desktop with about 1,200 sockets in the
  namespace, a sample took about 3 ms; at the default 5-second interval this is
  well under 0.1% of a core. The cost grows with the namespace's socket count
  (TIME-WAIT excluded); lengthen `resource_interval_s` on hosts with very many
  sockets.

## Transport, storage and API

- **Wire format.** `common/resource_wire.hpp`, magic `TRES`, version 1,
  separate from the thread format. A sample is a 1,232-byte summary datagram
  (a 64-byte header, 130 u64 values named in `kSummaryFields`, and the cgroup
  path) and up to four datagrams of six 160-byte socket rows. All stay
  under 1,400 bytes, so none is fragmented on a 1,500-byte MTU. Samples share the thread ticks'
  session id, so the two streams can be matched.
- **Reassembly.** The collector waits up to two seconds for a sample's parts,
  then uses what arrived (missing socket parts are flagged). Rates use the
  previous sample of the same session and process, up to three intervals
  back; counters that went backwards give no rate.
- **Storage.** One `resource_sample` row per sample in the same daily SQLite
  files, with the stall shares, descriptor counts, I/O rates, queue totals,
  fullest-buffer percentages and counter growth as columns
  (`kResourceColumns` in `collector/storage.hpp`), plus the busy sockets as
  compact JSON (about 200 bytes per busy socket, at most eight). Older day
  files gain the table when opened. A sample takes under half a kilobyte when no
  socket is busy, so the default 5-second interval adds under 10 MB a day.
- **Live.** `GET /api/live` has a `resources` object: the latest sample with
  rates, the fullest sockets, namespace counters and limits.
- **History.** `GET /api/resources?start=UNIX_SECONDS&end=UNIX_SECONDS`
  (default: the last 15 minutes) returns stored samples combined into at most
  about 1,000 buckets aligned to the epoch: gauges keep their peak, counter
  growth and elapsed time add up. Reports and the future alerting module can
  read the same table directly.
