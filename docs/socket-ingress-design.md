# Socket I/O and application message completion

Status: implemented as an optional eBPF source, raw C++ collector storage,
and a separate read-only reporting executable used by the dashboard. The ordinary `/proc`
sampler still works without BPF or extra permissions. The Python backup
collector does not ingest the new socket protocol.

## Review findings and measurement contract

TCP diagnostics count transport receipt before an application reads the data.
They cannot attribute consumption or writes to individual threads. Unix socket
diagnostics do not supply equivalent general byte counters. Thread `/proc/io`
counters mix other I/O with sockets and miss some receive APIs. None of these
sources can truthfully implement per-thread socket traffic or processing counts.

Use kernel socket-length tracepoints instead. `sock_recv_length` and
`sock_send_length` run after the socket operation and expose its actual result,
socket, and receive flags. These tracepoints also cover the internal paths
used by batched `sendmmsg`/`recvmmsg`; probing only public `sock_sendmsg` and
`sock_recvmsg` would miss the security-check bypass used by subsequent messages.

The first implementation measures **successful socket operation results**:

- Received bytes: the nonnegative byte count reported by an observed receive.
- Sent bytes: the nonnegative byte count accepted by an observed send, including
  partial sends. This does not prove peer delivery or peer processing.
- Receive/send operations: positive stream operations and nonnegative Unix
  datagram/seqpacket operations, including zero-length datagrams. Stream EOF
  and zero-progress stream operations do not count.
- Messages processed: calls to an explicit application completion marker,
  once per successfully completed application message. No marker means the
  metric is unavailable, rather than zero.

The original phrase “all bytes consumed” is too strong: a truncated datagram
may discard bytes beyond the operation's returned count. With `MSG_TRUNC`,
Linux may return the original datagram length instead of the copied length.
The counters follow the kernel result in both cases, not bytes parsed by the
application. Peeks and error-queue receives are excluded. Failed operations
contribute no bytes or operations. UDP is excluded.

## Source and coverage

`socket_sampler/socket.bpf.cpp` is a freestanding C++ BPF program. It filters
by host PID and the process's `/proc` starttime before updating counters.
Records distinguish TCP IPv4, TCP IPv6, Unix stream, Unix datagram and Unix
seqpacket. The executing thread's kernel start time distinguishes TID reuse.
The thread name is captured when its counter is created, so retired generations
are not relabeled with the name of a newly reused TID.

A monotonically assigned observer-local socket ID distinguishes socket
lifetimes. The `sk_free` fentry hook retires the pointer-to-ID mapping before
that address can be reused; kernel pointers are never sent or stored.
Counter keys include thread start time, TID, socket ID and kind. Multiple
threads using shared descriptors therefore retain their own actual operations.
Counter maps retain final values after socket closure and thread exit.

The source has a bounded hash map of 4,096 lifetime thread/socket counters
and a separate map of 4,096 active socket identities. It never evicts a retired
counter. Failed counter/identity updates or required kernel-field reads
increment a cumulative loss counter. After a loss, totals are explicitly lower
bounds and lifetime averages are unavailable. Restarting the source creates
a new monitoring period; the previous period remains queryable by observer ID.

Coverage is intentionally explicit:

- Ordinary read/readv, write/writev, recv/recvfrom/recvmsg/recvmmsg and
  send/sendto/sendmsg/sendmmsg paths through these tracepoints are covered.
- Kernel TLS, protocol-specific bypass paths and receive splice are not claimed
  to be complete. Send paths that reach the tracepoint count their result;
  zero-copy peer completion is not measured.
- Asynchronous operations are attributed to the thread executing the kernel
  operation when its TGID matches the target. Work in another process/kernel
  worker is excluded; the submitting application thread is not reconstructed.
- The metric represents only the supported paths, even when no updates were
  lost. It does not advertise complete coverage of arbitrary application I/O.
- Map values are scanned during live execution. Each individual counter is
  atomic, but the entire process snapshot is not an atomic stop-the-world read.
  One-second rates are approximate sampling-window rates, not instantaneous
  peaks. A final orderly snapshot detaches probes before reading the maps.
- Sudden source death cannot recover updates since the last complete snapshot.
  A normal source shutdown or detected target exit sends one final snapshot.
- The source observes a fixed PID generation. Restart it for a new process.
  Run it in the target's PID namespace with readable `/proc` and a compatible
  kernel BTF view. The collector can run on another host.

## Build and run

The normal build has no libbpf dependency:

```sh
make
make check
```

For the optional source, install a C++ compiler, clang with the BPF backend,
libbpf development headers/library, and the usual collector SQLite development
library. Then:

```sh
make socket-sampler
build/triangulator-socket-sampler PID 127.0.0.1:9400 build/socket.bpf.o
```

This source requires kernel BTF, the two socket-length tracepoints, a traceable
`sk_free`, and existing privileges to load/attach BPF tracing programs (typically
root or CAP_BPF plus CAP_PERFMON, subject to kernel policy). Older kernels without
the tracepoints are unsupported. The loader attaches every required probe before
it enables collection and fails with an error if any is unavailable. It never
changes capabilities, sudo policy or sysctls. The `/proc` sampler can run alongside
it for scheduler data. Send both sources from the configured `sampler_ip` to the
C++ collector's existing UDP port.

## Counting messages after processing

The application needs a stable, uninlined function called once after successful
message processing. For example:

```cpp
extern "C" __attribute__((noinline, visibility("default")))
void TriangulatorMessageProcessed()
{
  asm volatile("" ::: "memory");
}
```

Call it only after the application finishes processing one message. Keep the
symbol in the ELF symbol table; `-rdynamic` is useful for executables. For a shared
library, pass that library's path. Then start:

```sh
build/triangulator-socket-sampler PID 127.0.0.1:9400 build/socket.bpf.o \
  /absolute/path/to/application TriangulatorMessageProcessed
```

The uprobe attaches across threads and filters the target PID generation in BPF,
so already existing worker threads are included. The hook is at function entry:
its contract is a completion *notification*, not a generic handler that might
later fail. If a batch processes ten messages, invoke the marker ten times.
Internal retries should not invoke it until successful completion. The source
cannot discover protocol framing or processing success from socket traffic.

## Raw transport and storage

`TSIO` version 1 uses one 160-byte datagram per counter plus a heartbeat.
Fields use little endian. Byte offsets:

- 0 magic; 4 version (u32).
- 8 observer/reset identity (u64); 16 sample sequence (u64).
- 24 monotonic timestamp; 32 wall timestamp; 40 observer start monotonic time;
  48 process starttime in clock ticks; 56 cumulative lost updates (all u64).
- 64 PID; 68 part index; 72 total parts; 76 flags (all u32).
- 80 thread start in kernel boottime nanoseconds; 88 observer-local socket ID
  (both u64); 96 TID; 100 kind (both u32).
- 104 received bytes; 112 sent bytes; 120 receive operations; 128 send operations;
  136 completed messages (all u64); 144 thread comm (16 bytes).

Index zero is the heartbeat and has no counter/name data. Kinds 1–5 represent
the socket kinds above; kind 6 is the completion marker with socket ID zero.
Flag 1 means marker enabled; flag 2 means orderly observation end. All parts of
a snapshot carry the same header timestamps, identities, flags and loss count.
The existing `TMON` version 2 scheduler protocol is unchanged.

The C++ ingestion loop validates and stores each raw packet in
`socket_observation` in SQLite WAL day files, independent of `store_raw`.
Primary keys deduplicate observer/sequence/part. Files are selected by collector
receipt time, so sampler clock skew cannot choose retention filenames. The
record keeps source clocks and identities intact. Ingestion does not calculate
totals or rates. Daily retention follows the collector's configured policy.

## Reporting and dashboard

`build/triangulator-socket-report` reads day files with read-only SQLite
connections. A dedicated background bridge invokes this separate C++ program through
a bounded pipe (three-second timeout, eight-MiB output limit), without a shell.
Dashboard requests return cached reports immediately while the bridge refreshes
them; a slow helper cannot hold up other dashboard requests or UDP ingestion.
The bridge caches at most eight query identities. Install the helper next to
the collector binary. No reporting calculation runs in the
collector process or UDP ingestion loop. The reporting module
`metrics/socket_report.hpp` assembles complete snapshots,
including snapshots whose parts straddle midnight. Missing/inconsistent parts
and duplicate counter identities cannot become a valid snapshot. The newest
complete snapshot remains visible while a newer one is incomplete.

Totals sum the latest cumulative values, including retired thread/socket pairs.
They start at observer attachment, never at process startup. Total and identity
fields use decimal strings in JSON to preserve integers above JavaScript's exact
integer range. The UI shows human-readable units and exact values on hover.

Average is total divided by elapsed monotonic monitoring time. Current and
minimum/maximum rates use consecutive complete nominal one-second observation
windows whose actual elapsed time is 0.8–1.2 seconds. Counter regressions,
sequence gaps, delayed observations and source losses yield unknown rates.
Covered idle windows count as zero. Minimum/maximum and the chart concern the
most recent 60 intervals; the UI labels this recent range explicitly rather than
claiming lifetime extrema. Historical raw data is retained for separate reports.
Query work is bounded to 250,000 raw records and reports truncation/read errors.

The dashboard has received/sent/completed-message tabs, process cards, a recent
rate chart, socket-kind and thread filters, and a thread/kind breakdown. It
identifies the observer and monitoring duration, exposes unknown/unconfigured,
silent, ended and lower-bound states, and explains the completion-marker setup.
Filters affect the breakdown; cards/chart remain process-wide. Thread birth is
available on hover to distinguish reused TIDs. Current rates disappear after
source silence; lifetime totals remain visible.

[Dashboard screenshot](screenshots/socket-io.png) uses synthetic observations
for UI validation; it demonstrates the layout, not a validated kernel capture.

API examples:

```sh
curl 'http://127.0.0.1:9401/api/socket-io?pid=1234'
curl 'http://127.0.0.1:9401/api/socket-io?pid=1234&observer=123456789'
```

Without an observer ID, the report chooses the most recently received observer
for the PID (or any PID when `pid=0`). Each observer is a distinct monitoring
period; independent sources are not summed together.

## Validation

`make check` covers protocol rejection, large counters, resets, lost/duplicate/
reordered datagrams, incomplete snapshots, lower-bound coverage, idle windows,
TID reuse, SQLite persistence with `store_raw=false`, collector restart, and day
boundary assembly. `make socket-sampler` compiles both the libbpf loader and BPF
C++ object with warnings treated as errors.

A real-kernel test is opt-in because it needs the tracing privileges above:

```sh
make check-socket-kernel
```

It exercises TCP IPv4/IPv6 and Unix stream/datagram/seqpacket, ordinary/vectored/
message/batched APIs, peeks, failed receives/sends, partial sends, zero-length and
truncated datagrams, UDP exclusion, retired socket totals, existing worker-thread
attribution, and completion-marker counts. It fails rather than silently skipping
when explicitly invoked without the required kernel privileges. Standard
`make check` skips this privileged test.

References: [kernel socket implementation](https://github.com/torvalds/linux/blob/master/net/socket.c),
[socket tracepoints](https://github.com/torvalds/linux/blob/master/include/trace/events/sock.h),
[BPF documentation](https://docs.kernel.org/bpf/),
[perf tracing security](https://docs.kernel.org/admin-guide/perf-security.html).
