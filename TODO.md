# TODO

See [monitoring coverage](docs/linux-monitoring.md) for metric details and
the [bug lab report](docs/bug-lab-report.md) for known limits.

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

- [ ] Add host CPU and memory context: per-core CPU, steal time, runnable
  load, available memory, swap activity, and reclaim.
- [ ] Monitor available bytes and free inodes on configured filesystems,
  including collector history storage.
- [ ] Connect a separate alerting program to existing health signals. Add
  delivery, recovery, cooldowns, and an independent check for monitoring failure.

## Deployment dependencies

- [ ] Measure sampler impact on production Xeon hosts with RHEL 8 and 9.
  Add the RHEL 8 receive-timestamp fallback to the benchmark receiver first.
  Test isolated cores and document sampler CPU placement from the results.
- [ ] Define the oldest supported kernel and test release binaries there.
  Document required kernel features and behavior when they are unavailable.

## Release QA

- [ ] Test package upgrades (QA-006) when a second release is available.
