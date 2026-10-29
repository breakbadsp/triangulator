# Requirements and pending work

This file is the one list of requirements and unresolved work. The
[TODO](../TODO.md) file is an index of the open IDs. Measurement
constraints: [limits](measurement-limits.md).

Each item has a permanent ID, `REQ-NNNN`. Give a new item the next free
number, and add it to the TODO index. When an item is done or no longer
needed, remove it from this file and from the TODO index. Never reuse or
renumber an ID; gaps are expected.

Status values: `Open` (ready for work), `Owner decision` (decide first,
then give the item to one agent), `Accepted` (design agreed, not built).

## Incident analysis

### REQ-0001: Agent access to incident history

Status: Accepted. Related: REQ-0006, REQ-0008.

#### Need

A production incident support team uses AI agents to find incidents, find
their root cause, find workarounds, and explain incidents. The agents must
answer these questions from the collected data:

- Was there an issue on a given day? What was it?
- Is something wrong now? What is the possible cause?
- When did it start? Is it still active? Is it getting worse?
- Which target, process, or thread is affected? Which other targets are affected?
- Is the cause in the application or in the host (for example, a noisy
  neighbour or pressure on the whole host)?
- Which resource is involved: CPU, scheduler, memory, I/O, or network?
- Did a process crash, restart, or get killed by OOM?
- What changed compared with the last good period?
- Did this happen before?
- Is the data complete enough for the answer?

#### Decisions

- Agents read history and a short summary of current state. They do not
  read the live stream: an agent step takes seconds, and raw ticks cost
  many tokens for little information.
- Incidents are found once, by a program, and stored as episodes. Agents do
  not find incidents again from raw metrics on each question. That would be
  slow, would cost many tokens, and could give different answers each time.
- The collector and its SQLite day files do not change. All new parts are
  separate programs that read the day files or the HTTP API, as
  `AGENTS.md` requires.
- No columnar database now. The questions need episodes, not faster scans.
  The collector appends small rows with autocommit, and columnar formats are
  slow for that. DuckDB also adds a dependency and allows only one writer.
  If analysis over many days becomes slow, use DuckDB to read the SQLite day
  files directly, or a nightly Parquet export by a separate program.
- Deploys, configuration changes, and application logs stay outside
  Triangulator. The agent combines the Triangulator tools with other tools
  for that data.

#### Scope

1. **Episode detector.** A separate program reads the day files and writes
   episodes: start, end, target, kind, severity, top contributing threads,
   comparison with a baseline, and references to the raw rows. Kinds include
   CPU saturation, run-queue delay, memory pressure or major faults, I/O
   stall, PSI pressure, process exit or OOM, thread stall, and socket
   backlog. Decide whether the alerting program is this detector, so that
   one rule set serves both alerts and agents.
2. **Agent tools.** One read-only program, for example an MCP server, with:
   - `list_targets`, `list_sessions`
   - `episodes(window)`, `episode_detail(id)`
   - `current_status()`: open episodes, and recent minutes compared with a
     baseline
   - `correlate(episode)`: first signal to move, contributing threads,
     exits, PSI, and changes compared with the last good period
   - `compare(window_a, window_b)`, `top_threads(metric, window, n)`
   - `timeseries(target, thread, metric, window, step)`, downsampled in the
     tool
   - read-only SQL with a row limit, and a schema glossary
3. **Runbook.** For each episode kind: likely causes and workarounds.
4. **Long-term tier.** Episodes and 1-minute rollups kept longer than the
   7-day raw retention, for recurrence and trend questions.

#### Acceptance criteria

- An agent answers "was there an issue on day X, and what was it?" with
  one episode query, without reading raw rows.
- Tools hide day-file sharding, rows with `valid = 0`, `generation`, and
  TID reuse. A thread identity is never mixed across sessions.
- Every tool result has a size limit.
- Every answer states data completeness: gaps, invalid samples, and sampler
  throttling in the window.
- The collector receive path and the sampler have no new work.

## Diagnostic accuracy

### REQ-0003: Thread-count history

Status: Open.

Store thread-count history in the collector so a new dashboard tab can
assess growth immediately.

### REQ-0004: Switches/s label

Status: Open.

Correct the "Switches/s" label to distinguish sampled timeslices from
fallback context switches.

### REQ-0005: Deadlock and lock-convoy severity

Status: Open.

Review deadlock and lock-convoy severity. Their hints can appear while the
top assessment says "Healthy". Keep uncertainty explicit.

## Production monitoring

### REQ-0006: Host CPU and memory context

Status: Open.

Add host CPU and memory context: per-core CPU, steal time, runnable load,
available memory, swap activity, and reclaim.

### REQ-0007: Filesystem space and inodes

Status: Open.

Monitor available bytes and free inodes on configured filesystems,
including collector history storage.

### REQ-0008: Alerting program

Status: Open. Related: REQ-0001.

Connect a separate alerting program to existing health signals. Add
delivery, recovery, cooldowns, and an independent check for monitoring
failure.

## Sampler rate and CPU budget

Each change must follow the sampler constraints in `AGENTS.md`, measure
sampler overhead, and update QA-060. Evidence: QA run in PR #121 (ISS-15
and the sampler overhead notes).

### REQ-0009: Throttle recovery rule

Status: Owner decision.

`sampler/budget.hpp` raises the rate only when the sampler's CPU use is
below 0.6 × `cpu_budget_pct`. At a 0.1% budget and 5 Hz, the rate fell to
4.07 Hz and never recovered: idle CPU use was 0.069–0.076%, above the 0.06%
threshold. Options: raise the rate when the projected CPU use at the next
rate (current use × next rate ÷ current rate) is below 0.9 × budget; or keep
the rule and set a higher minimum for `cpu_budget_pct` (now 0.01..100); or
keep the rule and document the lowest budget that can recover.

### REQ-0010: Default rate and budget for larger targets

Status: Owner decision.

CPU use scales with the rate: 0.79% at 5 Hz and 1.44% at 10 Hz on a
7-thread target. The default 1% budget throttles a 10 Hz configuration to
about 6 Hz. Decide whether to keep the 1% default and the 10 Hz maximum,
and record the cost for each thread and each hertz with the benchmark
results.

### REQ-0011: Over budget at the minimum rate

Status: Owner decision.

Decide what the sampler does when the 0.2 Hz minimum rate still exceeds the
budget, as on a large target. Options: also slow the heavy scans
(resources, memory maps), or only report the excess on the dashboard.

### REQ-0012: Tick-path blocking exceptions

Status: Owner decision.

Decide on the two tick-path exceptions that wait for owner review: the
`/dev/kmsg` read for exit reports (at most 50 ms), and the netlink
`sock_diag` dump (up to 1 s per `recv`, no total time limit). Keep them, or
give them a time budget.

### REQ-0013: Future of the eBPF socket sampler

Status: Owner decision.

The optional eBPF `socket_sampler/` is the one second process on a host.
Decide whether it stays. It stays separate while undecided, because a merge
would make the ordinary sampler privileged.

## Deployment dependencies

### REQ-0014: Sampler impact on RHEL production hosts

Status: Open.

Measure sampler impact on production Xeon hosts with RHEL 8 and 9. Add the
RHEL 8 receive-timestamp fallback to the benchmark receiver first. Test
isolated cores and document sampler CPU placement from the results.

### REQ-0015: Oldest supported kernel

Status: Open.

Define the oldest supported kernel and test release binaries there.
Document required kernel features and behavior when they are unavailable.

## Targets overview page

The dashboard opens on the Targets overview: one tile per target.

### REQ-0017: Previous and next target shortcuts

Status: Open.

Add previous and next target shortcuts on the target dashboard, in the
order of the overview, so support can step through problem targets.

### REQ-0018: Trend rules on tiles

Status: Open. Depends on REQ-0003 or a per-target collector summary.

Run the trend rules (thread growth, thread churn, long futex waits) for
tiles. They need history: store thread-count history in the collector
(REQ-0003), or let the collector send a short summary per target. A
deadlocked process shows "Healthy" on its tile today.

### REQ-0019: Overview cost with many targets

Status: Open.

Measure the overview cost with many targets. Each poll reads the full live
view of every target (about 330 KB with 1,000 threads). If it is too much,
add a collector summary endpoint with a few numbers per target and run only
the rules that need threads in the browser.

### REQ-0020: Control-state poll rate

Status: Open.

Poll the target control state less often. Each overview poll (5 s) reads
`/api/targets/control`, which starts the Python control helper on the
collector host.

## Release QA

### REQ-0021: Package upgrade test

Status: Open.

Test package upgrades (QA-006) when a second release is available.

### REQ-0023: Bug lab capture after SIGCONT

Status: Open.

Make `bug-lab/run-lab.sh` capture QA-120 after `SIGCONT`, so the run shows
the recovered state (ISS-11 in PR #121).
