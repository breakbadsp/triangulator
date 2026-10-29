# TODO

Open items, by ID. Details, status, and the ID rules are in
[Requirements and pending work](docs/requirements.md).

## Incident analysis

- [REQ-0001](docs/requirements.md#req-0001-agent-access-to-incident-history): Agent access to incident history

## Diagnostic accuracy

- [REQ-0003](docs/requirements.md#req-0003-thread-count-history): Thread-count history
- [REQ-0004](docs/requirements.md#req-0004-switchess-label): Switches/s label
- [REQ-0005](docs/requirements.md#req-0005-deadlock-and-lock-convoy-severity): Deadlock and lock-convoy severity

## Production monitoring

- [REQ-0006](docs/requirements.md#req-0006-host-cpu-and-memory-context): Host CPU and memory context
- [REQ-0007](docs/requirements.md#req-0007-filesystem-space-and-inodes): Filesystem space and inodes
- [REQ-0008](docs/requirements.md#req-0008-alerting-program): Alerting program

## Sampler rate and CPU budget (owner decisions)

- [REQ-0009](docs/requirements.md#req-0009-throttle-recovery-rule): Throttle recovery rule
- [REQ-0010](docs/requirements.md#req-0010-default-rate-and-budget-for-larger-targets): Default rate and budget for larger targets
- [REQ-0011](docs/requirements.md#req-0011-over-budget-at-the-minimum-rate): Over budget at the minimum rate
- [REQ-0012](docs/requirements.md#req-0012-tick-path-blocking-exceptions): Tick-path blocking exceptions

## Deployment dependencies

- [REQ-0014](docs/requirements.md#req-0014-sampler-impact-on-rhel-production-hosts): Sampler impact on RHEL production hosts
- [REQ-0015](docs/requirements.md#req-0015-oldest-supported-kernel): Oldest supported kernel

## Targets overview page

- [REQ-0017](docs/requirements.md#req-0017-previous-and-next-target-shortcuts): Previous and next target shortcuts
- [REQ-0018](docs/requirements.md#req-0018-trend-rules-on-tiles): Trend rules on tiles
- [REQ-0019](docs/requirements.md#req-0019-overview-cost-with-many-targets): Overview cost with many targets
- [REQ-0020](docs/requirements.md#req-0020-control-state-poll-rate): Control-state poll rate

## Release QA

- [REQ-0021](docs/requirements.md#req-0021-package-upgrade-test): Package upgrade test
- [REQ-0023](docs/requirements.md#req-0023-bug-lab-capture-after-sigcont): Bug lab capture after SIGCONT
