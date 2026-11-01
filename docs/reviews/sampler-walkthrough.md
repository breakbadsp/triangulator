# Sampler code review

Reviewed revision: `cdeef9f1`. This review records risks and candidates for later changes. It does not propose a sampler code change. Run `scripts/review/sampler-evidence.sh` to reproduce the directory error result with a closed descriptor. Line links refer to that revision.

## Findings

### High: directory read errors look like a complete scan

`Directory::Next` returns the same empty result for end of directory and a `getdents64` error ([io.hpp](../../sampler/io.hpp#L85)). `ThreadCache::Rescan` then removes every thread not seen in the incomplete scan ([proc.hpp](../../sampler/proc.hpp#L366)). A later scan must rebuild the cache. `FindTargets` can also treat an incomplete name scan as a successful lookup, so it can select a name that is actually ambiguous, or report it absent ([proc.hpp](../../sampler/proc.hpp#L114)). Discovery can admit candidates and publish an exclusion count from an incomplete pass ([discovery.hpp](../../sampler/discovery.hpp#L185)). A descriptor scan can publish a partial count as complete ([resources.hpp](../../sampler/resources.hpp#L272)).

Return an error separately from end of directory. Callers should discard incomplete results and keep the last valid state where applicable. Add failure-injection tests for each caller. An interrupted syscall is retried today; this finding concerns other read errors.

### High: scans have no per-tick work limit in two modes

Configured name lookup walks all of `/proc` every tick ([proc.hpp](../../sampler/proc.hpp#L114)). The resource probe walks every entry in `/proc/PID/fd`, even after it stops reading links at `kMaxDescriptorLinks` ([resources.hpp](../../sampler/resources.hpp#L272)). The number of processes and descriptors is controlled by the host or target. A large host or target can therefore delay all target ticks. The discovery-mode limit does not cover these paths.

Use a bounded, resumable scan or another explicit work budget. Preserve ambiguity detection and mark incomplete descriptor counts as partial. Measure sampler overhead and tick latency with large process and descriptor counts before and after a change.

### Medium: a failed stat read can report a live process as ended

`ProcessEnded` treats every missing or unparseable stat as an exit, except descriptor exhaustion at open ([kernel_log.hpp](../../sampler/kernel_log.hpp#L529)). A transient read error, permission change, or truncated read can therefore create an exit report and reset the session for a live target when a lookup changes ([main.cpp](../../sampler/main.cpp#L178)). Name and PID lookups also collapse most read failures into absence. Distinguish confirmed disappearance, zombie state, or identity change from an unreadable identity. Keep the session and retry on an uncertain result. Test injected read and permission failures as well as real exit and PID reuse.

### Medium: cached process information can become stale

The sampler reads process information once per session and repeats that packet ([main.cpp](../../sampler/main.cpp#L329)). `exec`, `chdir`, credential changes, and changes to CPU affinity can occur without a new PID or start time. The collector can then show old executable, command, working directory, identity, or CPU information for the rest of the session. A transient failure on the first read is also cached. Define which fields represent an initial snapshot, and label them as such, or refresh them at a bounded interval. Test an exec and a change of working directory in the same process.

### Medium: rate-limited warnings can still block the sampler

`RateLimitedLogger::Warn` calls `fprintf` on stderr on the sampling thread ([io.hpp](../../sampler/io.hpp#L191)). A full pipe or a stalled log consumer can block indefinitely. Rate limiting controls frequency, not write duration. This can stop every target tick and conflicts with the sampler's non-blocking steady-state constraint. Use a bounded non-blocking logging path, and test with a full stderr pipe. Preserve useful diagnostics when writes fail.

## Simplification candidates

- `SendTick` repeats the non-blocking UDP send and error handling in `SendPart` ([main.cpp](../../sampler/main.cpp#L451), [main.cpp](../../sampler/main.cpp#L558)). A byte span over the tick packet could use the same helper, if the existing error message remains useful. Verify identical datagram sizes and drop behavior.
- `FindTarget` has a separate name scan while `FindTargets` implements another name scan ([proc.hpp](../../sampler/proc.hpp#L22), [proc.hpp](../../sampler/proc.hpp#L80)). Check all callers and tests before removing either path. A shared lookup must retain ambiguity and error semantics, and must not add allocation or a second scan per tick.
- `MemoryInterval` and `ResourceInterval` repeat the same zero-or-max calculation ([main.cpp](../../sampler/main.cpp#L355), [main.cpp](../../sampler/main.cpp#L466)). A small common function is only worthwhile if it makes the common rule easier to see; two short functions may be clearer than an abstraction.

The fixed buffers, cached descriptors, per-target state, and resumable memory scan serve the sampler constraints. Their size alone is not a reason to remove them.

## Scope and limits

The review traced the main loop, discovery, thread sampling, directory I/O, resource scans, memory sampling, process information, configuration watching, and exit detection. The findings above are code-path analysis; failure injection and performance measurements remain to be done. This is not proof that the remaining parser, protocol, kernel-log, and configuration code has no defects.
