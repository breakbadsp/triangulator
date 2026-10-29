# Multi-target decisions

- Keep one sampler per host to share scans and bound total cost. See [sampler constraints](../AGENTS.md#sampler-constraints).
- Give each target its own session. This preserves existing packet and process-lifetime semantics.
- Share sampling intervals across targets. Per-target rates would complicate the single loop.
- Keep selection in each browser tab. The collector has no shared current target.
- Open the dashboard on a Targets overview: one tile per target with the Assessment verdict of its latest live view, worst first. Keep Add target and Remove for local testing. See [REQ-TARGET-001](#req-target-001-local-configuration-and-discovery). Tiles run the same rules in the browser; rules that need a trend kept in a tab do not run on tiles.
- Preserve single-target configuration and stored history during upgrades.
- The owner approved automatic throttling on 2026-10-20, with a default budget of 1% of one CPU core. This is the approved exception to raw-counter-only sampling.
- Keep the optional eBPF observer separate while its future is undecided. Merging it would make the ordinary sampler privileged.
- Open: keep or remove that second process; decide whether limited access to other users' targets is sufficient.
- Track unresolved budget and blocking-read choices in [TODO](../TODO.md).
- Configuration and behavior: [sampler README](../sampler/README.md#multiple-targets), [collector README](../collector/README.md#per-target-settings).

## REQ-TARGET-001: Local configuration and discovery

Status: planned. This section defines the required behavior. It does not
describe implemented configuration syntax. Today, a configured name follows
one unique process, including a process that starts after the sampler.
Multiple matches make that target unresolved. Configuration changes require
`SIGHUP`.

### Configuration on the monitored host

- The local sampler configuration owns the production target selection.
  Production target changes need no collector-to-sampler control channel,
  SSH access from the collector, HTTP, or TLS in the sampler.
- Keep target selection in `sampler.toml`. Adding an exact process name must
  require only one list entry. Require no target ID, PID, script, or repeated
  table for this common operation. Derive identifiers for discovered targets.
- Use the following proposed syntax. Exact names are the default. Patterns
  are optional and explicit. Do not use approximate spelling matches or
  require regular expressions.

```toml
process_names = [
  "orders-api",
  "billing",
]

# Optional: monitor every process whose Linux process name matches this glob.
process_patterns = ["worker-*"]
```

- Match the Linux process name, not the command line. Explain the Linux
  15-byte name limit in the shipped configuration example.
- Preserve existing PID and named-target configuration forms. Reject a
  configuration that combines legacy selectors with the new discovery lists.
  Name the conflicting settings in the error.
- Detect local file changes without repeated file reads in normal sampling
  ticks. Use a non-blocking file-change notification in the existing thread.
  Handle atomic file replacement as well as edits. Keep `SIGHUP` available.
- Validate a complete configuration before applying it at a reload boundary.
  Keep the previous valid configuration after an invalid or unreadable edit.
  Bound and combine repeated notifications to prevent repeated reloads from
  delaying sampling. Configuration edits must survive sampler restarts.

### Process discovery

- Monitor every matching PID as a separate target. Discover new matches even
  when the configuration file has not changed. Keep rules with no matches
  active, including when no targets are running.
- Share one `/proc` scan across all rules. Separate the discovery interval
  from the sampling rate. Define and document a finite maximum discovery
  delay. Choose the default interval from overhead measurements.
- Identify each process instance by PID and process start time. Preserve
  sessions for unchanged instances across discovery and target-only reloads.
  Process restarts and PID reuse must not combine different process histories.
- Collect each process once if several rules match it. Removing one rule
  must not remove an instance still selected by another rule.
- Apply hard limits to rules, matching work, and active targets. Preallocate
  instance capacity at startup or reload. Discovery must preserve the
  sampler's no-allocation tick path. Do not add threads, subprocesses,
  privileges, runtime dependencies, or sampler disk writes.
- Preserve admitted instances when additional matches exceed capacity. Use
  a deterministic admission order. Report excluded matches and the limit
  without stopping existing collection. The dashboard must also report
  matches that the collector cannot admit because of its own capacity limit.
- Measure unchanged discovery scans and process arrivals and exits. Include
  hosts with many unrelated processes and patterns with many matches.
  Report sampler CPU, memory, and sampling delays before release.

### Dashboard controls

- Keep Add target for testing when the collector and sampler run on the same
  host. The browser can run on another host. Browser location does not decide
  whether target control is local.
- Disable Add target for a remote sampler. Apply the same restriction to
  Remove and other target-selection mutations. Explain that the operator
  must edit the configuration on the monitored host.
- Verify that the intended sampler runs locally before enabling control.
  Do not trust a hostname or an incoming sample's claimed host identity.
  If locality is unknown, keep control disabled. Enforce this restriction in
  the API as well as the UI. In mixed deployments, permit only local changes.
- Local test additions must update the same configuration that discovery
  uses and survive reload and restart. Define how Remove handles a process
  selected by a pattern before implementing it. It must not remove another
  matching process or allow discovery to silently undo the user's action.
- Show each discovered instance separately. Distinguish waiting for a
  process, stale data, and a capacity limit. Do not show an endless loader
  for a configured name with no running process.

### Acceptance before implementation is complete

- Verify that adding one name needs only one configuration list entry.
- Start two processes with the same selected name after sampler startup.
  Both must appear within the documented discovery delay without a reload.
- Verify exact and glob matches, overlapping rules, exits, restarts, and
  PID reuse. Verify discovery when the sampler starts with no matches.
- Verify valid edits, atomic file replacement, invalid edits, `SIGHUP`, and
  restart persistence. Target-only edits must preserve unchanged sessions.
- Verify limits and allocation behavior during discovery and process churn.
  Existing instances must continue when capacity is exhausted.
- Verify enabled local controls with a remote browser, disabled remote
  sampler controls, rejected direct remote API mutations, and mixed hosts.
- Add contextual help and manual QA cases with the implementation. Leave
  unexecuted cases `NOT_RUN`. Run the required checks and overhead tests.

Before implementation, resolve the glob syntax, identifier format, discovery
interval, capacity admission order, and local Remove behavior for patterns.
Keep these decisions in this section.
