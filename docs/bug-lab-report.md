# Bug lab: does the dashboard find real resource bugs?

We wrote one C program, [`bug-lab/bugbench.c`](../bug-lab/bugbench.c), that
reproduces 19 resource bugs on purpose (plus a healthy control). We pointed
Triangulator at each one and recorded what the dashboard said. The goal is not
to test the sample program. It is to find out where the product helps a person
find a real problem, and where it stays quiet.

**Result: 13 of 20 scenarios were found clearly (the control stayed quiet), 4
were found only in part, and 3 were not found at all.** We also found one
dashboard bug that shows wrong numbers (see [G2](#g2-rss-growth-is-averaged-over-time-before-the-leak)).

## How it was run

- An isolated copy of the product: its own runtime directory, UDP port 19400
  and HTTP port 19401. Nothing in `~/triangulator` was touched.
- Sampler at 2 Hz, resource samples every 2 s, memory-map samples every 5 s,
  replay recording every 5 s. The collector used `config/collector.toml` groups.
- Each scenario ran as its own process named `bb-<scenario>` for 70 s. A
  headless Chromium tab stayed open for the whole run, so the trend charts (which
  live in the browser tab) cover the run. The screenshot was taken at the end.
- `cpu-throttle` and `mem-oom` run inside `systemd-run --user --scope` with a
  50% CPU quota and a 240 MB memory limit. No privileges were used.
- Each scenario ran once, in sequence on one machine (6 cores, 15 GB). Sockets
  are loopback only. Reruns are listed under [Method notes](#method-notes).

To repeat it:

```sh
scripts/start.sh                      # with TRIANGULATOR_HOME set to a scratch directory
bug-lab/run-lab.sh                    # every scenario
bug-lab/run-lab.sh deadlock fd-leak   # chosen scenarios
```

## Scorecard

| Scenario | The bug | Verdict | What the dashboard said |
|---|---|---|---|
| `healthy` | none (control) | ✅ quiet | "No problems detected" |
| `cpu-spin` | hot loop in one thread | ✅ found | "worker-hot is saturating a core", 99.7% |
| `cpu-oversub` | 3× more busy threads than cores | ✅ found | "Threads are waiting for CPU": run delay 252% of CPU time |
| `cpu-throttle` | busy threads under a 50% CPU quota | ✅ found | "CPU quota throttled 100% of periods" (0.50 cores) |
| `yield-storm` | `sched_yield()` polling | 🟡 partial | Four threads "saturating a core" and 977 context switches/s, but nothing says the CPU is spent spinning in the kernel |
| `lock-convoy` | sleeping while holding one global lock | ❌ missed | "Healthy". Evidence is only 7 threads in `futex_do_wait` |
| `deadlock` | ABBA lock-order deadlock | ❌ missed | "Healthy". The stuck threads are hidden as idle |
| `mem-leak` | heap grows 8 MB/s | 🟡 partial | Memory section: "Resident memory grows without a plateau", +447.8 MB/min. The top assessment stays "Healthy" |
| `mem-oom` | leak inside a small cgroup memory limit | ✅ found | "Memory is thrashing (100.0% full stall)" and a thread in uninterruptible wait |
| `vm-bloat` | address space nearly at `RLIMIT_AS`, 100,000 mappings | 🟡 partial | Memory section: CRITICAL "Address space is close to RLIMIT_AS". The top assessment stays "Healthy" |
| `fd-leak` | `open()` without `close()` | ✅ found | "95.7% of file descriptors in use" (287 of 300), "Needs attention now" |
| `disk-sync` | `fsync()` after every write | ✅ found | "I/O is stalling all work 19.4% of the time", 4 threads in uninterruptible wait |
| `major-faults` | random `mmap` reads of evicted file pages | ✅ found | "12.2K major page faults/s" and I/O stall 23.5% |
| `tcp-slow` | slow reader, fast writer | ✅ found | "is not taking data": zero window, 131 KB waiting |
| `udp-drop` | UDP flood into a tiny buffer | ✅ found | "6423 UDP datagrams dropped", buffer 84.4% full |
| `close-wait` | accepted sockets never closed | ✅ found | "860 connections in CLOSE-WAIT" |
| `listen-full` | backlog 1, nobody calls `accept()` | ✅ found | "12 incoming connections dropped", accept queue 200% full (with one wrong extra, see [G6](#g6-a-syn-sent-socket-is-called-a-zero-window-peer)) |
| `thread-churn` | one new thread per task, ~150/s | ❌ missed | "Healthy". No churn shown at all |
| `thread-leak` | 600 threads wait forever | 🟡 partial | "Healthy", with an info note "High thread churn" (+511). No leak finding |
| `stopped` | process sent `SIGSTOP` | ✅ found | "5 stopped threads" |

## Where the product helped

These are the cases where a person reading the page would reach the cause
quickly. Each image is the overview section at the end of the run.

### CPU: `cpu-spin`, `cpu-oversub`, `cpu-throttle`

The assessment names the thread, the cause and what to do. The oversubscribed
and throttled cases look alike in thread states (many threads, all running or
waiting for a CPU), and the dashboard separates them: throttling reports the
cgroup quota, oversubscription reports run delay.

![cpu-spin overview](screenshots/bug-lab/cpu-spin-overview.png)

![cpu-oversub overview](screenshots/bug-lab/cpu-oversub-overview.png)

![cpu-throttle overview](screenshots/bug-lab/cpu-throttle-overview.png)

### Memory pressure: `mem-oom`

Process CPU is near zero, so a CPU-only tool would call this healthy. The
process load chart shows the thread blocked in the kernel (red area), and the
assessment reports a 100% full stall in the cgroup. The process did not get
killed in 70 s: it was held at `memory.high` and throttled, which is what a
real service does just before it is slow for no obvious reason.

![mem-oom overview](screenshots/bug-lab/mem-oom-overview.png)

### Storage: `disk-sync`, `major-faults`

Both show uninterruptible kernel wait and I/O pressure. `major-faults` also
names the faulting thread and gives the rate.

![disk-sync overview](screenshots/bug-lab/disk-sync-overview.png)

![major-faults overview](screenshots/bug-lab/major-faults-overview.png)

### Descriptors and sockets: `fd-leak`, `close-wait`, `tcp-slow`, `udp-drop`, `listen-full`

The resource section and the assessment agree, and the messages say who has to
act ("the app is not reading fast enough", "the peer is not reading").

![fd-leak overview](screenshots/bug-lab/fd-leak-overview.png)

![close-wait resources](screenshots/bug-lab/close-wait-resources.png)

![tcp-slow resources](screenshots/bug-lab/tcp-slow-resources.png)

![udp-drop resources](screenshots/bug-lab/udp-drop-resources.png)

![listen-full resources](screenshots/bug-lab/listen-full-resources.png)

### Stopped process: `stopped`

![stopped overview](screenshots/bug-lab/stopped-overview.png)

### Control: `healthy`

The control raised nothing, so the other results are not noise.

![healthy overview](screenshots/bug-lab/healthy-overview.png)

## Gaps the lab found

Ordered by how likely a real user is to be hurt.

### G1: Deadlocks and lock convoys look healthy

`deadlock` and `lock-convoy` are the two most common reasons for "the service
hangs and CPU is low". The dashboard answers "Healthy". For the convoy, the
assessment text even explains that futex waits are normal ("idle pool
workers"). For the deadlock, the two stuck threads are **not in the thread
table**: the default "Active" view hides them under "2 idle threads hidden (2
futex wait)". A person has to click "Show them" to find the thread that never
moves.

![deadlock threads](screenshots/bug-lab/deadlock-threads.png)

![lock-convoy threads](screenshots/bug-lab/lock-convoy-threads.png)

![deadlock overview](screenshots/bug-lab/deadlock-overview.png)

Ideas, not decided: show how long a thread has been idle in a futex wait while
its siblings work; call out the "many threads in one futex wait, throughput
down" shape for the convoy. A deadlock cannot be proved from `/proc`, so any
rule here would be a hint ("2 threads have waited on a futex for more than 60
s while the process is active"), not a verdict.

**Fixed** in commit `5e5952d` as dashboard hints (no collector or sampler change).
The assessment now lists two `info` notes. `deadlock`: "2 threads have waited on
a futex for over 67 s while other threads are active" (threads idle in futex wait
for 30 s or more next to active threads). `lock-convoy`: "8 of 8 "worker"
threads mostly wait on a futex but keep waking" (a family of four or more that
spends most of its time in futex wait, wakes at least 5 times a second and uses
at most 10% of a core). The idle summary over the thread table now ends with
"Longest futex wait: over 67 s.", and the profile sentence no longer calls long
futex waits normal. Both notes are worded as possibilities: a deadlocked thread
looks like an idle service thread in `/proc`, and a pool serving many tiny tasks
looks like a convoy. Families with an active member, and idle pools of four or
more, are skipped, so `healthy` and idle or partly busy futex pools stay quiet.
The verdict badge still says "Healthy", because the hints are `info`. Telling
the shapes apart for certain needs per-thread throughput, which is a core
collector metric and was not added.

![deadlock after the fix](screenshots/bug-lab/g1-after-deadlock.png)

![lock-convoy after the fix](screenshots/bug-lab/g1-after-convoy.png)

### G2: RSS growth is averaged over time before the leak

With history from other processes in the last 10 minutes (the case after a
restart or crash loop), the Memory section showed **+49.6 MB/min** for a leak
of about **450 MB/min**, and the "Resident memory grows without a plateau"
finding did not appear. The same leak against a clean history showed **+447.8
MB/min** and the warning.

| Previous process in the 10-minute window | Clean history |
|---|---|
| ![stale](screenshots/bug-lab/mem-leak-stale-history-memory.png) | ![clean](screenshots/bug-lab/mem-leak-memory.png) |

Cause, from `collector/dashboard.html` (`memorySlope`, and the finding in
`assessMemory`): the slope is `(last − first) / elapsed` over the last 600 s of
stored resource samples, and the finding needs 80% of the steps to rise. Points
from before the leak, or from an earlier process with a smaller RSS, drag the
slope down and break the "rises" test. Using only the current sampler session,
or the last minute or two, would give the right number.

### G3: Memory findings do not reach the top assessment

`vm-bloat` has a CRITICAL finding in the Memory section, and `mem-leak` has a
warning, but the top assessment, the first thing on the page, says "Healthy"
for both. A person who reads only the top panel misses them. The README says
resource findings join the assessment; memory-map findings do not.

![vm-bloat overview](screenshots/bug-lab/vm-bloat-overview.png)

![vm-bloat memory](screenshots/bug-lab/vm-bloat-memory.png)

### G4: Thread churn is blind to short-lived threads

`thread-churn` starts about 150 threads per second, each living a few
milliseconds. The dashboard showed no churn card and no finding. The sampler
sees threads only when it samples (here every 500 ms), so a thread that starts
and ends between two samples never exists. `thread-leak` (threads that stay)
does show "+511 / −1". This limit should be written in the docs: the churn
numbers are a lower bound, and short-lived threads are invisible at 0.2–10 Hz.

![thread-churn overview](screenshots/bug-lab/thread-churn-overview.png)

**Fixed in 4aaf095 (docs and labels, no sampler change).** Linux offers no unprivileged,
per-process count of threads ever created, so the blindness cannot be removed
without a privilege or an application hook. Measured on this machine, kernel
7.2: `/proc/PID/status`, `stat` and `sched` only carry the current thread count;
cgroup `pids.events` counts only failed forks and `pids.peak` is a high-water
mark; taskstats needs `CAP_NET_ADMIN`. The "last pid" in `/proc/loadavg` is
host-wide: with `thread-churn` running it advanced about 165 to 190 per second
(150 real threads/s), but an idle host advanced 25 to 135 per second, so the
signal is no better than the noise. At 2 Hz, a thread that lives 10 ms is seen
about 2% of the time. The dashboard now shows the "Thread churn" tile at all
times, labelled "lower bound", so `+0 / −0` cannot be read as "no churn"; its
help text and the finding ("At least N threads started...") state the limit and
suggest a higher sample rate or counting creations in the application. The README
and design notes carry the same limit. `thread-leak` still shows "+511 / −1",
`healthy` shows `+0 / −0`.

![thread-churn after](screenshots/bug-lab/g4-after-thread-churn.png)

### G5: Growing thread count is not flagged

`thread-leak` reached 602 threads, all waiting. The only note was "High thread
churn" at info level; the assessment says "Healthy". The pids and threads
meter exists in the limits section, but nothing compares thread count with its
own trend, so a leak that has not yet reached `pids.max` is silent.

![thread-leak overview](screenshots/bug-lab/thread-leak-overview.png)

### G6: A SYN-SENT socket is called a zero-window peer

In `listen-full` the client sockets are still in SYN-SENT, waiting for the
overflowing listener. The "Fullest sockets" table calls one of them "Peer window
is zero: the peer is not reading", and the assessment repeats it ("is not
taking data"). The true cause, the accept queue overflow, is also reported, so
the result is right but with a misleading extra line. The rule should skip
sockets that are not ESTABLISHED.

**Fixed** in commit `72bbbc1`. The window rules (zero window, "not taking data",
"limited by the peer's window") now apply only to sockets in a data-moving state
(ESTAB, CLOSE-WAIT, FIN-WAIT-1, LAST-ACK); SYN-SENT and SYN-RECV get their own
note instead. In the re-run `listen-full` shows "8 incoming connections dropped"
and no "not taking data"; `tcp-slow` still reports the zero window.

![listen-full sockets after the fix](screenshots/bug-lab/g6-after-listen-full-sockets.png)

### G7: Spin-wait loops look like ordinary computation

`yield-storm` is found only as "saturating a core". 977 context switches per
second is on the page, but the dashboard does not separate user time from
system time, so it cannot say "this CPU is burned in syscalls". Low priority.

## What a user cannot see by design

- Application logs. In `vm-bloat` the app printed `allocation failed: Cannot
  allocate memory` and in `fd-leak` it would print `open failed`. The only
  signs in the dashboard are the headroom meters.
- Whether anything is wrong with the *results* of the program (wrong output, slow
  requests). Triangulator sees resources, not behavior.

## Method notes

- The first run of `major-faults` did not produce major faults. After the first
  seconds the file stayed in the page cache, so the threads spun on minor
  faults and the dashboard correctly showed 0.0 major faults/s. The scenario
  was corrected to evict pages with `MADV_PAGEOUT`; the table uses the second
  run.
- The first run of `stopped` took its screenshot after the process had been
  resumed, so it showed nothing. The runner was fixed to stop the process shortly
  before the screenshot.
- `mem-leak` was run twice on purpose: once straight after other scenarios (the
  stale-history numbers in [G2](#g2-rss-growth-is-averaged-over-time-before-the-leak)),
  and once on a fresh history.
- `lock-convoy` and `deadlock` were run twice; both gave "Healthy".
- One machine, one run per scenario, loopback sockets, 2 Hz sampling. At the
  default 1 Hz some numbers would be coarser. The scenarios are meant to be
  obviously buggy, so a "found" here does not prove the product catches a subtle
  version of the same bug.
- The socket observer (eBPF) was not enabled, so the Socket I/O section was
  not part of this test.

## Suggested follow-ups

Nothing here was changed in the product. If you want to act on it:

1. Fix [G2](#g2-rss-growth-is-averaged-over-time-before-the-leak) first: it
   shows a wrong number.
2. Let Memory findings of warning level or higher appear in the top assessment (G3).
3. Decide what the product should say about futex waits that last a long time (G1).
4. Document the thread churn limit (G4) and add a growing-thread-count rule (G5).
5. Skip non-established sockets in the zero-window rule (G6).
