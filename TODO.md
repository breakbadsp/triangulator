# TODO

- Keep unresolved work here. Measurement constraints: [limits](docs/measurement-limits.md).

## Diagnostic accuracy

- [ ] Return the sampler session with each `/api/resources` row so RSS
  trends distinguish process restarts and reused PIDs.
- [ ] Store thread-count history in the collector so a new dashboard tab
  can assess growth immediately.
- [ ] Correct the "Switches/s" label to distinguish sampled timeslices
  from fallback context switches.
- [ ] Review deadlock and lock-convoy severity. Their hints can appear
  while the top assessment says "Healthy". Keep uncertainty explicit.

## Production monitoring

- [ ] Implement [REQ-TARGET-001: local target configuration and discovery](docs/multi-target-design.md#req-target-001-local-configuration-and-discovery).
  Keep dashboard target changes available only for a verified local sampler.
- [ ] Add host CPU and memory context: per-core CPU, steal time, runnable
  load, available memory, swap activity, and reclaim.
- [ ] Monitor available bytes and free inodes on configured filesystems,
  including collector history storage.
- [ ] Connect a separate alerting program to existing health signals. Add
  delivery, recovery, cooldowns, and an independent check for monitoring failure.

## Sampler rate and CPU budget (owner decisions)

Decide each item first, then give it to one agent. Each change must follow the
sampler constraints in `AGENTS.md`, measure sampler overhead, and update
QA-060. Evidence: QA run in PR #121 (ISS-15 and the sampler overhead notes).

- [ ] Decide the throttle recovery rule. `sampler/budget.hpp` raises the
  rate only when the sampler's CPU use is below 0.6 × `cpu_budget_pct`. At a
  0.1% budget and 5 Hz, the rate fell to 4.07 Hz and never recovered: idle CPU
  use was 0.069–0.076%, above the 0.06% threshold. Options: raise the rate
  when the projected CPU use at the next rate (current use × next rate ÷
  current rate) is below 0.9 × budget; or keep the rule and set a higher
  minimum for `cpu_budget_pct` (now 0.01..100); or keep the rule and document
  the lowest budget that can recover.
- [ ] Decide the default rate and budget for larger targets. CPU use scales
  with the rate: 0.79% at 5 Hz and 1.44% at 10 Hz on a 7-thread target. The
  default 1% budget throttles a 10 Hz configuration to about 6 Hz. Decide
  whether to keep the 1% default and the 10 Hz maximum, and record the cost
  for each thread and each hertz with the benchmark results.
- [ ] Decide what the sampler does when the 0.2 Hz minimum rate still exceeds
  the budget, as on a large target. Options: also slow the heavy scans
  (resources, memory maps), or only report the excess on the dashboard.
- [ ] Decide on the two tick-path exceptions that wait for owner review: the
  `/dev/kmsg` read for exit reports (at most 50 ms), and the netlink
  `sock_diag` dump (up to 1 s per `recv`, no total time limit). Keep them, or
  give them a time budget.

## Deployment dependencies

- [ ] Measure sampler impact on production Xeon hosts with RHEL 8 and 9.
  Add the RHEL 8 receive-timestamp fallback to the benchmark receiver first.
  Test isolated cores and document sampler CPU placement from the results.
- [ ] Define the oldest supported kernel and test release binaries there.
  Document required kernel features and behavior when they are unavailable.

## Targets overview page

The dashboard opens on the Targets overview: one tile per target. Work for
this page goes to the `feature/fleet-overview` branch first.

- [ ] Add a filter box and severity filters when there are more than about
  12 tiles, and keep the filter in the URL so a support link shows the same
  view.
- [ ] Add previous and next target shortcuts on the target dashboard, in
  the order of the overview, so support can step through problem targets.
- [ ] Run the trend rules (thread growth, thread churn, long futex waits)
  for tiles. They need history: store thread-count history in the collector
  (see Diagnostic accuracy), or let the collector send a short summary per
  target. A deadlocked process shows "Healthy" on its tile today.
- [ ] Measure the overview cost with many targets. Each poll reads the
  full live view of every target (about 330 KB with 1,000 threads). If it
  is too much, add a collector summary endpoint with a few numbers per
  target and run only the rules that need threads in the browser.
- [ ] Poll the target control state less often. Each overview poll (5 s)
  reads `/api/targets/control`, which starts the Python control helper on
  the collector host.

## Release QA

- [ ] Test package upgrades (QA-006) when a second release is available.
- [ ] Retest QA-004, QA-060, QA-071, and the QA-005 replay drawer (ISS-3 in
  PR #121) on a build that has PRs #122 and #123. Retest QA-068 step 3
  (collector-only restart).
- [ ] Make `bug-lab/run-lab.sh` capture QA-120 after `SIGCONT`, so the run
  shows the recovered state (ISS-11 in PR #121).
