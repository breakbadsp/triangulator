# Multi-target decisions

- Keep one sampler per host to share scans and bound total cost. See [sampler constraints](../AGENTS.md#sampler-constraints).
- Give each target its own session. This preserves existing packet and process-lifetime semantics.
- Share sampling intervals across targets. Per-target rates would complicate the single loop.
- Keep selection in each browser tab. The collector has no shared current target.
- Preserve single-target configuration and stored history during upgrades.
- The owner approved automatic throttling on 2026-10-20, with a default budget of 1% of one CPU core. This is the approved exception to raw-counter-only sampling.
- Keep the optional eBPF observer separate while its future is undecided. Merging it would make the ordinary sampler privileged.
- Open: keep or remove that second process; decide whether limited access to other users' targets is sufficient.
- Track unresolved budget and blocking-read choices in [TODO](../TODO.md).
- Configuration and behavior: [sampler README](../sampler/README.md#multiple-targets), [collector README](../collector/README.md#per-target-settings).
