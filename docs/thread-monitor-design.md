# Thread Monitor: Final Design (v1)

## 1. Goal

A rough, low-cost view of a production process's threads, built only from OS-provided data (`/proc`), with no change to the target application.

1. **Current state**: what each thread is doing right now, roughly.
2. **Worst-case alerts**: a thread that is
   - using too much CPU,
   - starved (runnable but not getting CPU),
   - blocked forever (stuck on a lock or an untimed wait), or
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
- R5. The sampler runs as the target's UID, hardened (section 6). If the host's ptrace policy requires it, it gets exactly one capability, `CAP_SYS_PTRACE`.
- R6. All interpretation (groups, thresholds, alerts) lives in the collector.
- R7. The system tolerates UDP loss, reordering and sampler restarts.
- R8. Alerts are delivered to a person (webhook or email), and the monitor alerts on its own silence.

Out of scope for v1: throughput or "slow but not hot" detection, multi-host, exact state timelines, stacks, which-lock identification, local buffering on prod. Prometheus and Grafana are deliberately not used.

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
- Per thread, keep `/proc/<pid>/task/<tid>/{stat,schedstat,syscall}` open and read with `pread`. Rescan `task/` each tick for new and exited threads; close descriptors for exited threads.
- Parse `stat` from the last `)`, because `comm` (field 2) can contain spaces and parentheses.
- Send with non-blocking `sendto`. On `EAGAIN` or `ENOBUFS`, drop the datagram.
- Send over the management network, not the data-path NIC.
- **Target selection:** pid or exact process name, from the config file. If the name matches several processes or none, the target is treated as absent.
- **Target absent:** the sampler keeps polling and sends a header-only datagram each tick with the `target_absent` flag. This tells the collector "sampler alive, target gone", which is different from sampler silence.
- **Session id:** a random 64-bit value, regenerated when the sampler starts or when the target's `(pid, starttime)` changes. `starttime` is `stat` field 22, so pid reuse is detected.
- **Startup check:** if `syscall` is unreadable for every thread (`EPERM`), the sampler logs a clear error (rate-limited) and keeps sending, with the unreadable sentinel set, so the collector can show it.
- Config file (rate, collector address and port, target), re-read on `SIGHUP`.
- Run with `Nice=19`, systemd `CPUQuota` and `MemoryMax`. Log only to journald, rate-limited.

### Data per thread per tick

| Field | Source |
|---|---|
| `tid`, `comm` (thread name), state, `utime`, `stime` | `stat` |
| run delay (ns), timeslices (times scheduled on a CPU) | `schedstat` (fields 2 and 3) |
| syscall number, futex op, futex timeout flag | `syscall` |

All counters are raw and cumulative; the collector computes deltas.

`syscall` file values: a number plus arguments when the thread is blocked in a syscall; `running` when on CPU; `-1` when not in a syscall. For futex, the arguments are `uaddr op val timeout`; the sampler keeps `op` and whether the `timeout` pointer is non-zero. The futex address is not sent in v1.

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

**Thread record (60 bytes):**

| Field | Type |
|---|---|
| `tid` | u32 |
| state character (`R S D T Z ...`) | u8 |
| flags: futex timeout set | u8 |
| syscall number | i16 (`-1` not in syscall, `-2` running, `-3` unreadable) |
| futex op (raw, with flag bits) | u32 |
| `utime`, `stime` (clock ticks) | u64, u64 |
| run delay (ns), timeslices | u64, u64 |
| `comm` | 16 bytes, NUL-padded |

At 60 bytes per record, one datagram carries 19 threads, so a 100-thread tick is 6 datagrams. Bandwidth is about 7 KB/s at 1 Hz and 70 KB/s at 10 Hz.

- Thread key: `(session id, tid)`.
- UDP is unauthenticated and plaintext. Restrict by firewall, or use WireGuard.

## 6. Prod host hardening

### Reading `syscall` needs ptrace-attach permission

Reading `/proc/<pid>/task/<tid>/syscall` is checked like a ptrace attach. Being the same UID is not enough when Yama `ptrace_scope` is 1 (the Ubuntu default): a non-ancestor process gets `EPERM`. `stat` and `schedstat` are not affected.

Decision, in order:
1. Test as the target's UID on the real host: `cat /proc/sys/kernel/yama/ptrace_scope` and `cat /proc/<pid>/task/<tid>/syscall`. If the read works, run with no capabilities.
2. If it fails, grant the sampler `CAP_SYS_PTRACE` only (`AmbientCapabilities=CAP_SYS_PTRACE`, `CapabilityBoundingSet=CAP_SYS_PTRACE`). Do not loosen `ptrace_scope` host-wide.

The capability is powerful: it lets a compromised sampler read other processes' memory through `/proc`. The sampler never calls `ptrace` (the `syscall` file read is a kernel permission check, not the syscall), so the extra controls below cut the risk down.

### systemd unit

- `User=<target uid>`, `NoNewPrivileges=yes`
- `CapabilityBoundingSet=` (empty), or `CAP_SYS_PTRACE` if step 2 above applies
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

### Syscall numbers

| Syscall | x86_64 | aarch64 |
|---|---|---|
| `futex` | 202 | 98 |
| `read` | 0 | 63 |
| `recvfrom` | 45 | 207 |
| `recvmsg` | 47 | 212 |
| `poll` / `ppoll` | 7 / 271 | - / 73 |
| `epoll_wait` / `epoll_pwait` / `epoll_pwait2` | 232 / 281 / 441 | - / 22 / 441 |

Verify against the target's headers. The architecture is a collector config setting.

### Futex waits

Futex args are `uaddr op val timeout`. Compare `op & 127` (this strips the private flag 128 and the clock flag 256). On glibc 2.25 and newer:

| Condition | Meaning |
|---|---|
| timeout set | Timed wait. For workers this is the normal idle wait on the condition variable. |
| no timeout, `op & 127 == 0` | Waiting on a **lock** (mutex) |
| no timeout, `op & 127 == 9` | Untimed **condition variable** wait |
| any other op (PI mutexes, requeue) | Other futex (op shown) |

This mapping depends on the libc; confirm it with `strace` in staging (section 12).

### Current state, from each sample (evaluated in this order)

| Sample | Shown as |
|---|---|
| State `D` | Kernel wait |
| State `R`, or syscall `running` | Running |
| Futex, timeout set | Idle (timed wait) |
| Futex, lock | Waiting on lock |
| Futex, untimed condition wait | Waiting on condition |
| `read` / `recvfrom` / `recvmsg` / `poll` / `ppoll` / `epoll_*` | Waiting on socket |
| Syscall unreadable (`-3`) | No access |
| Anything else | Other (syscall number) |

"Waiting on socket" is a guess from the syscall: a pipe or eventfd looks the same. Accepted for v1.

### Alerts

Deltas are computed over 5 s windows (configurable, 5 to 10 s). A window needs at least half of its expected samples, otherwise it is skipped. Unless noted, a condition must hold for 3 consecutive windows to open an alert and be clear for 2 windows to resolve it.

| Case | Signal | Alert when |
|---|---|---|
| **Too much CPU** | Delta(`utime`+`stime`) / delta t | Above 50% (warn) or 90% (critical, spin or runaway) on any thread |
| **Starved** | Delta run delay / delta t | Above 20% of the window |
| **Blocked forever** | Untimed futex wait (lock or condition) in every sample, timeslices unchanged, CPU unchanged | For more than 15 s (configurable 10 to 30 s). The duration replaces the 3-window rule. |
| **Stuck in kernel** | State `D` in every sample | For more than 5 s |

Why "blocked forever" works: a healthy idle worker wakes on every timeout, so its timeslice count keeps rising. A thread stuck in an untimed wait shows the same syscall and a frozen count. This covers all groups, so an IO thread is flagged if it sits in an untimed futex wait, but an IO thread idle in `read` is normal and is not flagged.

Groups can set `allow_untimed_wait = true` to exempt threads that legitimately wait forever (for example a misc thread that sleeps until shutdown).

**Starvation fallback** (only if `schedstat` is unusable): state `R` in most samples while CPU stays under 10%, with `nonvoluntary_ctxt_switches` rising.

### Monitor health alerts

| Case | Alert when |
|---|---|
| Sampler silent | No datagram from the sampler for 10 s |
| Target absent | Sampler heartbeats carry `target_absent` for 5 s |
| Packet loss | Sequence gaps above 20% over 1 min (warning) |
| Access lost | Most threads report `-3` (unreadable) |

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
arch        = "x86_64"
retention_days = 7
store_raw   = false

[alerts]
window_s = 5
sustain_windows = 3
cpu_warn_pct = 50
cpu_crit_pct = 90
starve_run_delay_pct = 20
blocked_secs = 15
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
allow_untimed_wait = false
```

Linux thread names are limited to 15 characters, so prefixes must be short and thread names must not be truncated into each other.

## 10. Known limitations

- No throughput visibility: a thread that is slow because of a slow downstream, with normal waits and low CPU, looks idle.
- Sampling misses stalls shorter than the interval; state is approximate by design.
- A mutex wait and a long untimed wait cannot be told apart from who holds the lock; the futex word does not carry the owner.
- Socket waits are inferred from the syscall, not the fd type.
- CPU is measured in clock ticks (usually 10 ms), which is fine for 5 s windows.
- UDP loss: if the collector or network is down, data for that period is gone.
- With `CAP_SYS_PTRACE` granted, the sampler is a more sensitive binary; keep it small.

## 11. Later, only if needed

- Which-lock identification: send a hashed futex address and show "N threads waiting on the same lock or condition".
- Small bounded flight-recorder ring on prod (`/dev/shm`) for outage backfill.
- eBPF `sched_switch` and futex wait-time histograms, run on demand when an alert fires.
- Stack sampling, app-level counters.
- Rollups for longer history.

## 12. Checks before building

1. **ptrace access:** as the target's UID, `cat /proc/sys/kernel/yama/ptrace_scope` and `cat /proc/<pid>/task/<tid>/syscall`. Decides whether `CAP_SYS_PTRACE` is needed (section 6).
2. **`schedstat`:** `cat /proc/<pid>/task/<tid>/schedstat` on the target box. It needs `CONFIG_SCHED_INFO`, and on some kernels `kernel.sched_schedstats` must be enabled. When unsupported it reads as zeros, so check that run delay is non-zero under load, not only that the file exists.
3. **Futex ops:** `strace -f -e trace=futex` in staging (never on prod) to confirm the op values for mutex waits, untimed and timed condition waits with your libc.
4. **Thread names:** confirm all thread groups are named and the names fit in 15 characters.
5. **Network:** confirm the path from prod to the collector and the firewall or WireGuard setup.
6. **Operations:** choose the alert channel, retention period and collector disk budget.

## Changes from the draft

- Added the ptrace/Yama requirement and the capability decision.
- Mutex waits and untimed condition waits are now separate states.
- Added monitor-health alerts, `target_absent` heartbeats and alert delivery.
- Thread names now define groups; the behavior-based category heuristic is removed.
- `status` is read only in the fallback; `schedstat` timeslices replace voluntary switches.
- SQLite stores 5 s rollups and alert events; raw rows stay in memory (optional raw storage).
- Removed dedupe, core pinning and priority tuning.
- Session id covers pid reuse; `stat` parsing starts at the last `)`.
