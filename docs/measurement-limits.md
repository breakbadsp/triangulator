# Measurement limits

## Sampling and history

- Samples can miss brief activity and short-lived threads. Churn counts are lower bounds.
- Unavailable is not zero. Counter resets require a new rate baseline.
- Wait channels do not prove deadlock or identify a lock owner.
- Host, network namespace, and cgroup counters can include other processes.
- Rollups cannot reconstruct a complete process view. Replay needs recordings; a gap is not idle time.
- Past assessments inspect selected recordings. Brief findings can be missed, and rules that need live trends cannot run.
- Older periods use wider check intervals. A missing recording ends an episode because its state is unknown.
- Findings are computed again after reload. Session and thread generation must remain separate because Linux can reuse IDs.

## Memory and observer cost

- Virtual mappings do not show resident pages, heap leaks, allocation sites, or stack depth.
- Reading `maps` takes the target's `mmap_lock`. Incremental reads limit each hold but cannot remove interference.
- Older kernels can delay page faults during mapping reads. Measure on the intended host before choosing rates.
- Resource cost grows with descriptors and namespace sockets. See [target impact](target-impact.md).

## Sockets

- Diagnostics describe queues and transport state, not per-thread application consumption. The sampler must share the target's network namespace.
- eBPF counts successful operation results on supported paths. A successful send does not prove delivery or processing.
- Peeks, error-queue reads, unsupported paths, and work in another process are excluded. Truncation follows the kernel return length.
- Message completion needs an application marker. Without one, the value is unavailable.
- Lost map updates make totals lower bounds. Concurrent snapshots are not atomic process-wide observations.
- Exact coverage: [socket.bpf.cpp](../socket_sampler/socket.bpf.cpp) and [loader](../socket_sampler/main.cpp).

## Process exits

- Kernel logs can be restricted or absent. Broad log access is a host-policy change, not a monitoring requirement.
- Nested PID namespaces can require matching by process name because kernel messages use outer PIDs.
- Exit-status support depends on the kernel. An unknown reason does not prove normal exit; a signal does not identify its sender.
