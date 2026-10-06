# TigerStyle adaption: sampler heap allocation review

## Result

The sampler allocates heap memory after initialization. It does not meet the
TigerStyle memory rule. TigerStyle requires all memory to be allocated at startup
and prohibits dynamic allocation after initialization.

Source: [TigerStyle, Safety](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md).

The project uses a less restrictive rule in
[the C++ coding standards](cpp-coding-standards.md#the-hot-path). It permits
allocation at startup and when a new thread appears. This report evaluates the
sampler against the stricter TigerStyle rule.

## Measurement method

The reviewed revision is `4965f92`. The measurements were made on 2026-10-06
with GCC 16.2.1 and glibc 2.44 on Linux. A separate test program called the current
sampler functions. It used one target thread and a seven-digit PID.

The program used `-O2 -std=c++23 -static` and linker wrappers for `malloc`,
`calloc`, and `realloc`. Static linking allowed the wrappers to count C++
allocation calls and libc directory-buffer allocation calls. The measurement
counters used volatile storage to prevent compiler reordering across allocation
calls. Counts were enabled only around the operation under test.

The program measured three consecutive steady ticks and resource samples. It
used these functions:

- `FindTarget` for PID and process-name selection.
- `ThreadCache::Rescan` and `Thread::TakeSample` for thread sampling.
- `ResourceProbe::Sample` for resource sampling.

The resource tests used the target's existing cgroup. The socket tests added one
UNIX socket pair, which supplied two socket descriptors. The process-name test
used the name `alloc-review`.

These are measured allocation requests, not a count of live heap blocks or
memory obtained from the operating system. This is a function-level measurement,
not an allocation trace of the complete sampler executable. It excludes packet
transmission, configuration loading, reloads, and most error paths. Counts depend
on the C++ library, libc, PID length, process list, cgroup path, and target sockets.

## Measured counts

- Thread cache construction: **1 allocation**, **122,400 requested bytes**.
- PID lookup: **1 allocation**, **31 requested bytes**.
- First thread scan and sample: **6 allocations**, **32,980 requested bytes**.
  This excludes PID lookup and thread cache construction.
- Steady PID tick, including lookup, thread scan, and cached thread reads:
  **3 allocations**, **32,878 requested bytes**.
- One thread sample without cached descriptors: **4 allocations**,
  **133 requested bytes**. This excludes target lookup and thread scan.
- Resource sample without target sockets: **36 additional allocations**,
  **34,992 requested bytes**, on each measured sample.
- First resource sample with two UNIX sockets: **43 additional allocations**,
  **101,600 requested bytes**.
- Subsequent resource samples with two UNIX sockets: **40 additional
  allocations**, **35,432 requested bytes**, on each measured sample.
- Process-name lookup: **147 allocations**, **37,342 requested bytes**, on
  each measured lookup. This replaces PID lookup and excludes the thread scan.
  The count changes with the processes in `/proc`.

At the default sampling rate of 1 Hz and resource interval of 5 seconds, the
measured steady PID case gives:

- No target sockets: `3 + 36 / 5 = 10.2` allocation requests per second.
- Two UNIX sockets: `3 + 40 / 5 = 11` allocation requests per second.

These rates exclude startup, thread changes, configuration reloads, and errors.
They do not apply to process-name selection or other machines without a new
measurement.

## Allocation sources

### Directory scans on each tick

[`ThreadCache::Rescan`](../sampler/proc.hpp) builds `/proc/PID/task` with
`std::format` and calls `opendir`. The directory buffer accounts for approximately
32 KiB of allocation requests on each measured tick. The path string also
allocates for the measured PID length.

Process-name selection in `FindTarget` additionally opens `/proc` on every
lookup and formats a `/proc/PID/comm` path for each candidate process. Its
allocation count increases with the process list and path lengths.

### Temporary path strings

[`FindTarget` and `Thread::ReadFile`](../sampler/proc.hpp) use `std::format` to
construct paths. Short strings can fit in the C++ library's internal string
storage. Longer strings require heap allocation.

Thread descriptors are normally retained. Cached reads do not construct paths
again. New threads, failed reads, and threads without retained descriptors
construct paths when they open files. The measured uncached successful thread
sample constructs four paths per tick.

### Socket map reconstruction

[`ResourceProbe::ReadDescriptors`](../sampler/resources.hpp) calls
`socket_fds_.clear()` and inserts socket inode entries on each resource sample.
Clearing the map releases its nodes. Retaining bucket capacity does not retain
node storage. New entries allocate nodes again. Bucket growth can add further
allocations.

### Socket vector growth and copying

[`ResourceProbe::ReadSockets`](../sampler/resources.hpp) adds matching sockets to
`matched_`. This vector retains its capacity between samples but can allocate
when the socket count grows.

It then copies `matched_` into the new `ResourceSample::sockets_` vector. A
nonempty result allocates storage on each sample. The sample releases that
storage after use.

The 24-socket output limit is applied after collection. It does not limit the
initial vector capacity to 24 sockets.

### Resource paths and cgroup text

[`ResourceProbe`](../sampler/resources.hpp) constructs temporary paths for
pressure, process, cgroup, and network reads. Some fixed path literals also
become temporary `std::string` objects because `Read` accepts `const
std::string&`. The new sample owns a cgroup string on each call. Long cgroup
paths allocate storage.

### Late socket diagnostic buffer allocation

[`SocketDiag`](../sampler/socket_diag.hpp) allocates a 65,536-byte receive vector
when it is first opened. `ResourceProbe` opens it when it first needs socket
information. A diagnostic error resets it, so a later sample can allocate the
buffer again.

### Reload and error paths

[`Sampler::Run` and `Sampler::ResetSession`](../sampler/main.cpp) can construct
configuration and error strings after startup. Formatted warning messages are
constructed before `RateLimitedLogger::Warn` checks its time limit. The logging
time limit therefore does not prevent those string allocations.

These paths were not included in the steady counts.

## Existing fixed storage

The sampler already uses fixed arrays for thread records, packet storage,
thread-read buffers, the thread lookup table, and the resource-read buffer.
Parsing uses views into these buffers. Successful cached thread reads and packet
encoding do not require heap allocation.

`ThreadCache` reserves storage for all 2,550 supported threads at construction.
New thread entries therefore do not require vector growth within that limit.

## Proposed changes

1. Replace temporary path strings with bounded character buffers.
2. Replace per-tick `opendir` allocation with reusable directory-read storage.
3. Allocate bounded socket inode storage at startup.
4. Retain socket map entries or use a fixed table that does not allocate nodes.
5. Allocate socket diagnostic receive storage at startup.
6. Use bounded reusable storage for cgroup text and socket output.
7. Set an explicit bound for collected sockets before vector growth.
8. Construct warning text in bounded storage after the logging time check.
9. Define whether configuration reloads must also meet the startup-only rule.
10. Add allocation measurements for startup, steady sampling, thread changes,
    socket changes, reloads, and errors before changing the implementation.

Each implementation change must include before-and-after measurements, as
required by the project's C++ coding standards. This pull request records the
review only. It makes no sampler implementation changes.
