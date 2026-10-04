# Thread Monitor: Final Design (v1)

## 1. Goal

A rough, low-cost view of a production process's threads, built only from OS-provided data (`/proc`), with no change to the target application.

1. **Current state**: what each thread is doing right now, roughly.
2. **Worst-case alerts**: a thread that is
   - using too much CPU,
   - starved (runnable but not getting CPU),
   - stuck in the kernel (state `D`).

Rough is fine. Sustained problems matter; short blips do not.

Target process: async, queue-based, a thread per client connection. No thread should use much CPU.
- **IO threads** (`io-*`): mostly blocked on socket read. Their only other wait is the lock used to hand data to a worker queue.
- **Worker threads** (`worker-*`): idle in a timed condition variable wait; otherwise doing work. Any other wait, or a long mutex wait, means contention or starvation.
- **Sender threads** (`sender-*`) and **misc threads** (`misc-*`): same waiting mechanism as workers.

Threads are named with `pthread_setname_np`. The collector takes a list of thread-group name prefixes and groups threads by them.

## 2. Requirements

- R1. Sample every thread of the target process. Default 1 Hz, runtime-configurable between 0.2 and 10 Hz.
- R2. The sampler sends samples over UDP to a remote collector. Nothing is written to disk on prod.
- R3. The collector keeps recent samples in memory, stores rollups and alert events in SQLite, and serves a dashboard with:
  - **current state**: per thread, its name and group, latest state, state mix over the last ~10 s, CPU %; per-group thread counts;
  - **alerts**: open and recent;
  - **history**: per-thread timeline from rollups;
  - **monitor health**: sampler last seen, packet loss, target present or absent.
- R4. The sampler must never noticeably affect the target: non-blocking sends, no listener, no disk writes, bounded CPU and memory.
- R5. The sampler runs as the target's UID, hardened (section 6), with no capabilities. v1 reads only `/proc` files that the same UID can read without ptrace-attach permission.
- R6. All interpretation (groups, thresholds, alerts) lives in the collector.
- R7. The system tolerates UDP loss, reordering and sampler restarts.
- R8. Alerts are delivered to a person (webhook or email), and the monitor alerts on its own silence.

Out of scope for v1: privileged data (`/proc/<tid>/syscall`, `stack`), "slow but not hot" detection, multi-host, exact state timelines, stacks, which-lock identification, local buffering on prod. Prometheus and Grafana are deliberately not used.

## 3. Architecture

```
[prod host]                              [collector host]
 sampler (single thread)                  receiver
   -> UDP unicast (outbound only) ----->    -> in-memory window (live view, ~10 min)
                                            -> alert engine -> webhook / email
                                            -> SQLite, one file per day (rollups, alerts)
                                            -> dashboard
```

## 4. Sampler (prod host)

- Single thread. Loop on absolute deadlines (`clock_nanosleep` with `TIMER_ABSTIME`). If a tick overruns, skip to the next future deadline; never catch up in a burst.
- Per thread, keep `/proc/<pid>/task/<tid>/{stat,schedstat,io,wchan}` open and read with `pread`. Rescan `task/` each tick for new and exited threads; close descriptors for exited threads.
- Parse `stat` from the last `)`, because `comm` (field 2) can contain spaces and parentheses.
- Send with non-blocking `sendto`. On `EAGAIN` or `ENOBUFS`, drop the datagram.
- Send over the management network, not the data-path NIC.
- **Target selection:** pid or exact process name, from the config file. If the name matches several processes or none, the target is treated as absent.
- **Target absent:** the sampler keeps polling and sends a header-only datagram each tick with the `target_absent` flag. This tells the collector "sampler alive, target gone", which is different from sampler silence.
- **Session id:** a random 64-bit value, regenerated when the sampler starts or when the target's `(pid, starttime)` changes. `starttime` is `stat` field 22, so pid reuse is detected.
- **Access check:** the kernel reports a hidden `wchan` as `0`, the same as a running thread. If every sleeping thread (`S` or `D`) has an empty wait channel, the sampler logs a rate-limited warning and keeps sending; the collector shows those threads as "no access". If `io` is unreadable, the record carries an `io_unavailable` flag.
- Config file (rate, collector address and port, target), re-read on `SIGHUP`.
- Run with `Nice=19`, systemd `CPUQuota` and `MemoryMax`. Log only to journald, rate-limited.

### Data per thread per tick

| Field | Source |
|---|---|
| `tid`, `comm` (thread name), state, `utime`, `stime`, major faults, last CPU | `stat` (fields 3, 12, 14, 15, 39) |
| run delay (ns), timeslices (times scheduled on a CPU) | `schedstat` (fields 2 and 3) |
| bytes read and written through read- and write-family syscalls (`rchar`, `wchar`) | `io` |
| wait channel: the kernel function a sleeping thread waits in | `wchan` |

All counters are raw and cumulative; the collector computes deltas.

`wchan` holds a kernel symbol such as `futex_do_wait`, `do_epoll_wait`, `poll_schedule_timeout`, `__skb_wait_for_more_packets` or `anon_pipe_read`, and `0` when the thread is running or the reader lacks access. The sampler drops compiler suffixes (`.constprop.0`, `.isra.0`) and sends at most 32 bytes.

**Why not `syscall`:** `/proc/<tid>/syscall` would distinguish timed from untimed futex waits and lock from condition waits, but reading it is checked like a ptrace attach. Under Yama `ptrace_scope = 1` (the common default) a same-UID, non-ancestor reader gets `EPERM`, so the sampler would need `CAP_SYS_PTRACE`. v1 does without it (section 11). `stat`, `schedstat`, `status`, `io` and `wchan` need only ptrace *read* access, which a same-UID process has under every Yama setting.

**Fallback if `schedstat` is unusable** (see section 12): the sampler sets a header flag and fills the two `schedstat` fields with `nonvoluntary_ctxt_switches` and `voluntary_ctxt_switches` from `status`. Use this only when needed; it costs one more read per thread.

## 5. Wire format

Every datagram is self-contained, since UDP can lose and reorder. Little-endian, fixed-size binary. Each datagram stays under about 1200 bytes to avoid IP fragmentation.

**Header (48 bytes):**

| Field | Type |
|---|---|
| magic `"TMON"`, version | u32, u8 |
| flags: `target_absent`, `status_fallback` | u8 |
| chunk index, chunk count | u8, u8 |
| session id | u64 |
| tick sequence number | u32 |
| thread records in this datagram | u16 (+2 pad) |
| sampler monotonic ns, wall-clock ns | u64, u64 |
| sample interval (ms) | u32 |
| target pid | u32 |

**Thread record (112 bytes, wire version 2):**

| Field | Type |
|---|---|
| `tid` | u32 |
| state character (`R S D T Z ...`) | u8 |
| flags: `io_unavailable` | u8 |
| last CPU | u16 |
| `utime`, `stime` (clock ticks) | u64, u64 |
| run delay (ns), timeslices | u64, u64 |
| major faults | u64 |
| bytes read, bytes written (`rchar`, `wchar`) | u64, u64 |
| `comm` | 16 bytes, NUL-padded |
| `wchan` | 32 bytes, NUL-padded |

At 112 bytes per record, one datagram carries 10 threads (1,168 bytes), so a 100-thread tick is 10 datagrams. Bandwidth is about 12 KB/s at 1 Hz and 120 KB/s at 10 Hz.

- Thread key: `(session id, tid)`.
- UDP is unauthenticated and plaintext. Restrict by firewall, or use WireGuard.

## 6. Prod host hardening

### No capabilities

Every file the sampler reads needs only ptrace *read* access, which a process running as the target's UID has. Yama restricts only ptrace *attach*, so its setting does not matter. The sampler never needs `CAP_SYS_PTRACE`; granting it would only add risk.

### systemd unit

- `User=<target uid>`, `NoNewPrivileges=yes`
- `CapabilityBoundingSet=` (empty)
- `SystemCallFilter=@system-service` and `SystemCallFilter=~@debug` (blocks `ptrace` and `process_vm_*`)
- `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`
- `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` (UNIX is for journald)
- `IPAddressDeny=any`, `IPAddressAllow=<collector ip>`
- `Restart=on-failure`
- Binary and config owned by root, not writable by the app UID.

Behavior rules in code: read-only, send no signals, never `open()` through `/proc/<pid>/fd/N` or `/proc/<pid>/mem`, no listening socket.

## 7. Collector

- **Receiver:** read UDP; merge chunks by `(session, tick seq)`; tolerate gaps and reordering using the tick sequence and sampler timestamps; use partial ticks as they are. Detect session changes and reset deltas.
- **Thread restarts:** if a cumulative counter goes backwards for a `(session, tid)`, treat it as a new thread (tid reuse).
- **Group mapping:** match `comm` against the configured prefixes, first match wins; no match means group `ungrouped`.
- **Live view:** raw samples for the last ~10 minutes in memory.
- **History (SQLite, one file per day, WAL mode):**
  - `thread_rollup`: one row per thread per 5 s window: ts, session, tid, name, group, cpu %, run-delay %, sample counts per state (running, socket, idle, lock, condition, kernel, other), timeslices delta.
  - `alert_event`: ts, rule, group, tid, name, detail, opened or resolved.
  - Size: 100 threads is about 1.7M rollup rows per day, roughly 150 to 250 MB (estimate). Retention is deleting whole day files (default 7 days, configurable).
  - Optional `store_raw` flag (off by default) keeps raw rows too: about 8.6M rows per day at 100 threads and 1 Hz, so it is only worth it if you want to replay history against new thresholds.
- **Processing:** deltas from raw counters, state inference, alert rules (section 8).
- **Alert delivery:** webhook (HTTP POST, JSON) and/or SMTP email; at least one configured. An alert notifies when it opens, reminds every 30 min while open (configurable), and notifies when it resolves. Alert identity is `(rule, group, tid)`.
- **Collector liveness (optional):** ping an external dead-man's-switch URL every minute, so someone is told if the collector itself dies.

## 8. Interpretation

### Current state, from each sample (evaluated in this order)

| Sample | Shown as |
|---|---|
| State `D` | Kernel wait |
| State `R` | Running |
| State `T` or `t` | Stopped |
| Empty `wchan` while sleeping | No access |
| `wchan` contains `futex` | Futex wait |
| `wchan` contains `epoll`, `poll` or `select` | Poll / epoll |
| `wchan` contains `skb`, `sk_wait`, `sock`, `unix_stream`, `inet_csk`, `tcp_` or `udp_` | Socket wait |
| `wchan` contains `pipe` or `eventfd` | Pipe / eventfd |
| `wchan` contains `nanosleep` | Sleep |
| Anything else | Other (raw `wchan` shown) |

Wait-channel names are kernel symbols and change between kernel versions, so matching is by substring and the raw name is always shown alongside. A futex wait cannot be split into lock, condition variable or timed idle without `syscall`. A thread that wakes between the `stat` and `wchan` reads can briefly show as "no access".

### Alerts

Starvation deltas are computed over 5 s windows (configurable, 5 to 10 s). A window needs at least half of its expected samples, otherwise it is skipped; the condition must hold for 3 consecutive windows to open an alert and be clear for 2 windows to resolve it. CPU and kernel-wait alerts use durations instead.

| Case | Signal | Alert when |
|---|---|---|
| **Too much CPU** | Delta(`utime`+`stime`) / delta t, measured at every sample over the trailing second | Above 50% (warn) or 90% (critical, spin or runaway) continuously for 5 s (`cpu_sustain_secs`); resolves after 5 s below. A sampling gap restarts the duration. |
| **Starved** | Delta run delay / delta t | Above 20% of the window |
| **Stuck in kernel** | State `D` in every sample | For more than 5 s |

Waits do not alert. A futex wait cannot be told apart from an idle thread pool without `syscall`, and an alert on it fires for every parked worker. The dashboard instead shows each thread's state and wait channel.

**Starvation fallback** (only if `schedstat` is unusable): state `R` in most samples while CPU stays under 10%, with `nonvoluntary_ctxt_switches` rising.

### Monitor health alerts

| Case | Alert when |
|---|---|
| Sampler silent | No datagram from the sampler for 10 s |
| Target absent | Sampler heartbeats carry `target_absent` for 5 s |
| Packet loss | Sequence gaps above 20% over 1 min (warning) |
| Access lost | Most threads show "no access" (hidden `wchan`) |

Thresholds are starting points; tune them from real data. At 1 Hz, detection is on a seconds scale; raise the rate at runtime when investigating.

## 9. Configuration sketch

**Sampler**

```
target_process = "mybackend"     # or target_pid = 1234
rate_hz        = 1.0             # 0.2 .. 10
collector      = "10.0.0.5:9400"
```

**Collector**

```
clock_ticks = 100
retention_days = 7
store_raw   = false

[alerts]
window_s = 5
sustain_windows = 3
cpu_warn_pct = 50
cpu_sustain_secs = 5
cpu_crit_pct = 90
starve_run_delay_pct = 20
kernel_wait_secs = 5
sampler_silent_secs = 10
webhook_url = "https://..."
# smtp = ...

[[group]]
name   = "io"
prefix = "io-"

[[group]]
name   = "worker"
prefix = "worker-"

[[group]]
name   = "sender"
prefix = "sender-"

[[group]]
name   = "misc"
prefix = "misc-"
```

Linux thread names are limited to 15 characters, so prefixes must be short and thread names must not be truncated into each other.

## 10. Known limitations

- No throughput visibility: a thread that is slow because of a slow downstream, with normal waits and low CPU, looks idle.
- Sampling misses stalls shorter than the interval; state is approximate by design.
- A mutex wait and a long untimed wait cannot be told apart from who holds the lock; the futex word does not carry the owner.
- Socket waits are inferred from the kernel wait channel, not the fd type, and wait-channel names vary by kernel version.
- Futex waits are not split into lock, condition and timed idle (this needs `syscall`, which needs `CAP_SYS_PTRACE`).
- Per-thread read/write bytes count syscall traffic (including sockets and page-cache hits), not device I/O.
- CPU is measured in clock ticks (usually 10 ms), which is fine for 5 s windows.
- UDP loss: if the collector or network is down, data for that period is gone.

## 11. Later, only if needed

- Optional privileged mode: read `syscall` with `CAP_SYS_PTRACE` to split futex waits into lock, condition and timed idle.
- Which-lock identification: send a hashed futex address and show "N threads waiting on the same lock or condition".
- Small bounded flight-recorder ring on prod (`/dev/shm`) for outage backfill.
- eBPF `sched_switch` and futex wait-time histograms, run on demand when an alert fires.
- Stack sampling, app-level counters.
- Rollups for longer history.

## 12. Checks before building

1. **Wait channels:** as the target's UID, `cat /proc/<pid>/task/*/wchan` while the target is idle and busy. Confirm that the names map to the expected states (section 8); add any new names to the collector table.
2. **`schedstat`:** `cat /proc/<pid>/task/<tid>/schedstat` on the target box. It needs `CONFIG_SCHED_INFO`, and on some kernels `kernel.sched_schedstats` must be enabled. When unsupported it reads as zeros, so check that run delay is non-zero under load, not only that the file exists.
3. **Idle waits:** confirm the wait channels each thread group normally sits in, so unusual block types stand out on the dashboard.
4. **Thread names:** confirm all thread groups are named and the names fit in 15 characters.
5. **Network:** confirm the path from prod to the collector and the firewall or WireGuard setup.
6. **Operations:** choose the alert channel, retention period and collector disk budget.

## Changes in wire version 2

- No capabilities: `syscall` is no longer read. State comes from `stat` plus the kernel wait channel (`wchan`).
- Futex waits are one state; lock, condition and timed idle are no longer distinguished. The "blocked forever" alert is removed; the dashboard shows each thread's wait instead.
- CPU alerts open after 5 s continuously over the threshold (per-sample check), instead of three 5 s windows.
- New per-thread data: wait channel, last CPU, major faults, and read/write bytes from `io`. Records are 112 bytes, 10 per datagram.
- The collector no longer needs `arch`.

## Changes from the draft

- Added the ptrace/Yama requirement and the capability decision.
- Mutex waits and untimed condition waits are now separate states.
- Added monitor-health alerts, `target_absent` heartbeats and alert delivery.
- Thread names now define groups; the behavior-based category heuristic is removed.
- `status` is read only in the fallback; `schedstat` timeslices replace voluntary switches.
- SQLite stores 5 s rollups and alert events; raw rows stay in memory (optional raw storage).
- Removed dedupe, core pinning and priority tuning.
- Session id covers pid reuse; `stat` parsing starts at the last `)`.
