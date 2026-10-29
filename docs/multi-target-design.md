# Multi-target decisions

- Keep one sampler per host to share scans and bound total cost. See [sampler constraints](../AGENTS.md#sampler-constraints).
- Give each target its own session. This preserves existing packet and process-lifetime semantics.
- Share sampling intervals across targets. Per-target rates would complicate the single loop.
- Keep selection in each browser tab. The collector has no shared current target.
- Open the dashboard on a Targets overview: one tile per target with the Assessment verdict of its latest live view, worst first. Use local testing controls there. See [REQ-0024](#req-0024-local-configuration-and-discovery). Tiles run the same rules in the browser; rules that need a trend kept in a tab do not run on tiles.
- Preserve single-target configuration and stored history during upgrades.
- The owner approved automatic throttling on 2026-10-20, with a default budget of 1% of one CPU core. This is the approved exception to raw-counter-only sampling.
- Open: decide whether limited access to other users' targets is sufficient.
- Track unresolved budget and blocking-read choices in [requirements](requirements.md) (REQ-0009 to REQ-0012).
- Configuration and behavior: [sampler README](../sampler/README.md#multiple-targets), [collector README](../collector/README.md#per-target-settings).

## REQ-0024: Local configuration and discovery

Source identifier: REQ-TARGET-001 in PR194.

Status: implemented. This section is the requirement source. See the
[sampler operations](../sampler/README.md#local-discovery) for syntax, bounds,
and reload behavior.

### Configuration on the monitored host

- The local sampler configuration owns the production target selection.
  Production target changes need no collector-to-sampler control channel,
  SSH access from the collector, HTTP, or TLS in the sampler.
- Keep target selection in `sampler.toml`. Adding an exact process name must
  require only one list entry. Require no target ID, PID, script, or repeated
  table for this common operation. Derive identifiers for discovered targets.
- Use the following syntax. Exact names are the default. Patterns
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

### Implementation decisions

- Globs use whole-name, case-sensitive `*` and `?`. Brackets and escapes are
  rejected. Names use 1..15 portable ID bytes; patterns permit other comm bytes.
- Instance IDs are the sanitized comm name, then `.2`, `.3`, and so on.
  Admission fixes the ID for the instance lifetime. Overlap edits keep it.
- One pass starts no more often than once a second. Each tick examines at most
  512 directory entries. Fixed candidate storage selects the lowest PIDs at
  pass completion. Existing instances are never evicted. `/proc` directory
  enumeration order is not an admission-order guarantee.
- Remove deletes an exact-name rule and stops every instance of that name.
  A matching pattern blocks Remove. So does a rename: the process keeps the
  ID of its old name, so the ID no longer names the rule that selects it.
  The helper checks the current file again.
  Other rules stay unchanged. Removing the last name leaves a valid empty list.
- Network target mutations need `network_target_control = true` on the
  collector. It is off by default. Sampler locality is a separate mandatory
  check for loopback and network clients.
