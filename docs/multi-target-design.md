# Multi-target decisions

- Keep one sampler per host to share scans and bound total cost. See [sampler constraints](../AGENTS.md#sampler-constraints).
- Give each target its own session. This preserves existing packet and process-lifetime semantics.
- Share sampling intervals across targets. Per-target rates would complicate the single loop.
- Keep selection in each browser tab. The collector has no shared current target.
- Open the dashboard on a Targets overview: one tile per target with the Assessment verdict of its latest live view, worst first. Add and remove targets there. Tiles run the same rules in the browser; rules that need a trend kept in a tab do not run on tiles.
- Preserve single-target configuration and stored history during upgrades.
- The owner approved automatic throttling on 2026-10-20, with a default budget of 1% of one CPU core. This is the approved exception to raw-counter-only sampling.
- Open: decide whether limited access to other users' targets is sufficient.
- Track unresolved budget and blocking-read choices in [requirements](requirements.md) (REQ-0009 to REQ-0012).
- Configuration and behavior: [sampler README](../sampler/README.md#multiple-targets), [collector README](../collector/README.md#per-target-settings).
