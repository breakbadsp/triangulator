# Measurement limits

These constraints affect interpretation. Exact fields, bounds, formulas, and
thresholds are defined in the [source map](architecture.md#code-entry-points).
The dashboard help explains each displayed metric.

## Sampling and history

- A sample is an observation at one time. Short-lived threads and brief queue
  pressure can occur between samples. Thread churn counts are lower bounds.
- Cumulative counters can preserve activity between samples. A missing value
  means unavailable, not zero. A counter reset needs a new rate baseline.
- Wait channels describe where a thread waits. They do not prove a deadlock,
  identify a lock owner, or establish whether a wait is a defect.
- Host and network namespace counters can include unrelated processes.
  Cgroup values apply to the cgroup, which can contain several processes.
- Rollups cannot reconstruct a complete process view. Replay needs recorded
  snapshots and uses more storage. A recording gap is not an idle interval.

Past assessments check selected recordings in the browser. Earlier periods use
wider sample intervals. A finding that starts and ends between two checks can
be missed. Each recording is assessed on its own; rules that need live trends
cannot run. A missing recording ends a finding episode because its state is
unknown. Thread episodes also keep the sampler session and thread generation
separate because Linux can reuse thread IDs. Findings are not stored; a page
reload checks the recordings again. Reading many full recordings can use
substantial network bandwidth. See
[dashboard.html](../collector/dashboard.html) for the checking schedule and rules.

## Memory and observer cost

Virtual address mappings do not show which pages are resident. RSS measures
resident memory for the process. Neither measurement proves a heap leak or
identifies allocation sites.

Reading `/proc/PID/maps` takes the target's `mmap_lock` for reading. This can
delay mapping changes and, on older kernels, page faults. Small incremental
reads limit each hold; they do not eliminate interference. Resource sampling
also grows with descriptor and namespace socket counts. Increase sample
intervals for large targets. Measure on the intended host before setting rates.
See [sampler configuration](../config/sampler.toml) and the benchmark drivers
in [build guidelines](build-guidelines.md#performance-checks).

## Sockets

Socket diagnostics describe queues and transport state. They do not attribute
application consumption to threads. The sampler must share the target's network
namespace to list its sockets. Run it inside the namespace when required.

The optional eBPF observer counts successful socket operation results on its
supported paths. A successful send does not prove peer delivery or processing.
Peeks, error-queue reads, unsupported paths, and work in another process are
outside that contract. Datagram truncation follows the returned kernel length.
Message completion requires an explicit application marker; without one, it is
unavailable. Map loss makes totals lower bounds. Concurrent snapshots are not
atomic process-wide observations. See [socket.bpf.cpp](../socket_sampler/socket.bpf.cpp)
and [the loader](../socket_sampler/main.cpp) for coverage and kernel requirements.

## Process exits

Kernel log access and kernel support determine the available evidence.
`/dev/kmsg` can be restricted or absent in a container. Allowing all users to
read kernel messages changes host policy; it is not a monitoring prerequisite.
PID file descriptor exit status depends on kernel support. An unknown reason
is not proof of a normal exit. A signal alone does not identify who sent it.
See [exit_status.hpp](../sampler/exit_status.hpp) and
[kernel_log.hpp](../sampler/kernel_log.hpp).
