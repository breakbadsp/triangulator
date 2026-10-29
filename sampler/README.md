# Sampler

Read Linux thread and resource data. Send samples to the collector over UDP.

<p align="center">
  <img src="../docs/assets/sampler-flow.svg" alt="The sampler reads the target process through /proc, samples threads at 0.2 to 10 Hz, and sends UDP datagrams to the collector." width="100%">
</p>

## Design constraints

The sampler must keep its overhead on the target host negligible. Run exactly
one sampler on each host, and keep it single-threaded. See
[Sampler constraints](../AGENTS.md#sampler-constraints) and the
[multi-target design](../docs/multi-target-design.md).
One sampler monitors several targets and their threads.

## Quick start

Run these commands from the repository root as the target process user.

1. Start both programs:

   ```sh
   scripts/start.sh
   ```

2. Select a process name or PID:

   ```sh
   scripts/set-target.sh ghostty
   ```

3. Set the sample frequency:

   ```sh
   scripts/set-rate.sh 5
   ```

The default frequency is 5 Hz. The range is 0.2–10 Hz.
Resource samples run every 2 seconds, and memory-map samples every 30 seconds.
Set `resource_interval_s` or `memory_interval_s` to `0` to disable that source.
Both intervals are limited by the thread sampling frequency. See
[target impact](../docs/target-impact.md) for measured costs and limits.

## Run separately

Use an existing local configuration:

```sh
make build/triangulator-sampler
build/triangulator-sampler --check-config ~/triangulator/config/sampler.toml
scripts/start.sh sampler
```

Set `target_process` or `target_pid` in the configuration.
File edits and atomic replacement apply automatically. `SIGHUP` also requests a reload.

[Configuration example](../config/sampler.toml) ·
[Design decisions](../docs/design-decisions.md) ·
[Measurement limits](../docs/measurement-limits.md) ·
[Collector](../collector/README.md)

## Multiple targets

Use one sampler process on each host. Put global settings before the target
tables. Use either the legacy selector or target tables.

```toml
collector = "127.0.0.1:9400"
rate_hz = 5.0

[[target]]
id = "orders"
process = "orders-api"

[[target]]
id = "billing"
pid = 1234
```

A configuration permits up to 16 targets. IDs must be unique and contain
1..31 letters, digits, dots, underscores, or hyphens. Each table needs an ID
and exactly one `process` or `pid`. A process name must be an exact, unique
Linux process name of at most 15 bytes.

Each target has its own session. A process restart changes only that session.
On SIGHUP, targets with the same ID and selector keep their sessions. A global
setting change starts new sessions for all targets. The sampler shares one
process-name scan and one descriptor budget. Resources and memory maps rotate
across targets; one tick runs at most one heavy scan. That caps all targets together at
`rate_hz` heavy scans per second. When the enabled intervals ask for more
(`targets * (1/resource_interval_s + 1/memory_interval_s)` above `rate_hz`),
each source runs less often than configured, and there is no warning. At 5 Hz
with 16 targets and `resource_interval_s = 2`, resources alone ask for 8 per
second, so each target gets about one every 3 s. Raise `rate_hz` or the
intervals, or disable a source, to avoid the stretch. Exit-log reads share
one time limit of at most 50 ms for the full tick.

The sampler sends TTGT at session start and every 10 seconds. Upgrade the
collector first. Older collectors count TTGT as an invalid packet.

## CPU budget

`cpu_budget_pct` defaults to `1.0`, or 1% of one CPU core. The allowed range is
0.01..100. The sampler measures `CLOCK_THREAD_CPUTIME_ID` for all targets in
one fixed window of about five seconds. When use exceeds the budget, it lowers
the effective rate. It never goes below 0.2 Hz. At the minimum rate, the CPU
use can still exceed the budget if the targets cost too much to sample.

After CPU use stays below 60% of the budget for five seconds, the rate
increases by 25%, up to `rate_hz`. All targets use the same effective rate.
A rate change keeps their sessions. TMON reports the effective interval.
TTGT reports raw CPU and elapsed time counters, the configured and effective
rates, and the budget. The collector converts the counters to a percentage.

## Local discovery

The local `sampler.toml` owns production selection. Remove legacy selectors
before using the discovery lists in [the example](../config/sampler.toml).
`process_names` selects exact Linux comm names. `process_patterns` optionally
selects whole names with `*` and `?`, case-sensitive. Brackets and backslashes
are rejected. Each rule has 1..15 bytes, with at most 16 rules in total.
Exact names use letters, digits, dots, underscores, and hyphens. Linux keeps
only 15 bytes of a process name. It does not match the command line.
Empty lists are valid and keep discovery active. Do not mix lists with
`target_pid`, `target_process`, or `[[target]]`.

`max_targets` reserves 1..16 instance slots, default 8. Configure at least
one slot per exact name. Each running PID and start time gets its own
session and ID. Overlapping rules collect it once. Rule-only reloads keep
selected instances and their sessions. An exact name without a process has
a waiting tile. A process restart starts a new session. IDs use the comm
name, replace non-ID bytes with `_`, and append `.2` and higher as needed.
An ID is fixed for the instance lifetime; it is not an instance count.

A scan starts no more often than once a second. Each sampling tick examines
at most 512 `/proc` directory entries, each with at most 16 bounded 15-byte
rule comparisons, one comm read, and one stat read for a match. At pass end,
at most 32 fixed candidates get one identity check. Admission selects the
lowest candidate PIDs, with reserved waiting-name slots first. Existing
instances stay. Failed identity checks wait for another pass. The last
complete pass reports excluded matches in sampler logs and announcements.
The dashboard shows the sampler count, capped at 255, and collector drops.

For a readable process that stays alive through a full pass, with a slot
available, a conservative discovery bound is `1 second + 2 * ceil(P/512) * T`.
P includes all directory entries during a pass; T is the largest actual
sampling interval during these two passes. The two passes cover arrival
just after the cursor passed its PID. At 5 Hz and at most 512 entries this
is 1.4 seconds. CPU throttling can increase T to 5 seconds. Scheduling and
existing slow-probe delays add to T. Under unbounded process churn, repeated
read failures, or exhausted capacity there is no fixed admission deadline.
Run `python3 tests/benchmark_discovery.py` for reproducible local measurements.
The fixtures use at most 64 unrelated and 24 matching sleeping processes.

Inotify watches the parent directory through a non-blocking descriptor.
A tick reads at most four 4096-byte event buffers. Edits, atomic replacement,
overflow, and incomplete queue drains request a full reload. Reloads combine
at a limit of one each second. Invalid or unreadable files keep the previous
valid configuration. A lost watch queues a reload and retries after 10 seconds;
recovery queues another reload. `SIGHUP` works while the watch is unavailable.

Dashboard Add and Remove are local testing controls. Add in list mode needs
one exact name and persists in this file. Remove deletes that exact-name
rule and stops every matching instance. A pattern that also selects the name
blocks Remove. Edit patterns on the monitored host. The collector and helper
both check this restriction. A rename after admission also blocks Remove: the
ID keeps the old name, so the collector cannot name the current rule. Legacy table controls keep their existing form.
Upgrade the collector first: discovery uses the two TTGT reserved bytes for
selection, release, and a capped excluded count. Legacy packets keep zeroes.
UDP is lossy: five release notices reduce loss but cannot guarantee delivery.
The collector keeps history and rejects released sessions using its bounded
1024-entry retired-session cache. Idle expiry handles lost release notices.
