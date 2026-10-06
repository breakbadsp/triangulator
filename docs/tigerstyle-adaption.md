# TigerStyle adaption: sampler heap allocation review

## Result

The sampler now meets the TigerStyle memory rule. TigerStyle requires all
memory to be allocated at startup and prohibits dynamic allocation after
initialization. `tests/allocation_test.cpp` counts **0 heap allocations**
after startup, for three ticks of target lookup, thread sampling and resource
sampling. `make check` runs this test.

Before the changes, the sampler allocated heap memory after initialization.
The sections from "Measurement method" to "Existing fixed storage" record that
review at revision `4965f92`. The section "Selected changes" gives the approach
that was selected for each allocation source.

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

## Selected changes

The goals were zero allocations after startup and simple, readable code. Each
source had more than one possible fix. This table gives the selected fix and
the reason for it.

| Source | Selected fix | Reason |
| --- | --- | --- |
| `opendir` buffer | `Directory` in `sampler/io.hpp` reads entries with `getdents64` into an 8 KiB member array. | A memory resource cannot stop libc from calling `malloc`. Only a replacement of `opendir` removes this allocation. The `Next()` loop has the same shape as the old `readdir` loop. |
| `std::format` paths and keys | `FixedString` in `sampler/io.hpp` formats with `std::format_to_n` into a 4,096-byte array (`PATH_MAX`). Text that does not fit becomes empty, so `open` fails. | Call sites keep the same format strings. The buffer is on the stack. |
| Warning text | `RateLimitedLogger::Warn` takes a format string and arguments. It formats into a 512-byte array only after the time check. `std::strerror` replaces `std::generic_category().message`. | Suppressed warnings cost no formatting. No error text is a `std::string`. |
| `socket_fds_` map | A `std::vector<SocketFd>` that is reserved for `kMaxDescriptorLinks` entries at startup. Each sample sorts it and removes duplicate inodes. Lookups use binary search. | `clear()` keeps the capacity, and the scan never adds more than `kMaxDescriptorLinks` entries. This is simpler than a custom hash table. |
| `matched_` growth and the copy into the sample | `FullestSockets` keeps the 24 fullest sockets in a fixed array, as a heap. Totals are added per socket as the dump arrives. | Memory stays bounded for any number of sockets. The old vector could hold up to 65,536 sockets. |
| Sample-owned `cgroup_` and `sockets_` | `ResourceSample` holds a `std::string_view` and a `std::span`. They view the probe's storage until the next `Sample()`. | No copy and no allocation. The packet encoders already accept views. |
| `SocketDiag` receive buffer | `ResourceProbe` allocates 64 KiB at construction and gives a span to `SocketDiag::Open`. | A reopen after an error does not allocate again. |
| Configuration reload | Allowed to allocate. | A reload on `SIGHUP` is a new start on operator request, like startup. The ticks after it do not allocate. |

### Rejected approaches

- **Monotonic `std::pmr` arena that is reset each tick.** It does not control
  allocations inside libc, such as `opendir`. On overflow it throws
  `std::bad_alloc`, but the project returns `std::expected`. Data that lives
  across ticks, such as the socket table, cannot use it. After the fixes above,
  no per-tick data was left that needed it.
- **Fixed array of 65,536 matched sockets.** It needs more than 10 MiB.
  `FullestSockets` keeps only the 24 sockets that are sent.
- **Custom open-addressing hash table for socket inodes.** A sorted vector
  with binary search gives the same result with less code.

### Startup allocations

These allocations occur once, at construction:

- `ThreadCache`: storage for 2,550 threads, 122,400 bytes.
- `ResourceProbe`: the socket table, 65,536 entries of 16 bytes (1 MiB).
- `ResourceProbe`: the socket diagnostic receive buffer, 64 KiB.

The kernel gives physical pages only when the sampler writes to them. A
target with few descriptors therefore uses little of the 1 MiB socket table.

### Allocation test

`build/allocation-test` is linked statically with
`-Wl,--wrap=malloc,--wrap=calloc,--wrap=realloc`. The wrappers count every
call, including calls from `libstdc++` and from libc functions. The test opens
48 UNIX socket descriptors, so the probe also cuts sockets. It then runs three
ticks of:

- Target lookup by PID and by process name.
- A thread scan and thread samples, with kept descriptors and with reopened
  `/proc` files.
- A resource sample.
- A formatted warning.

The test fails if any allocation occurs. A temporary `std::vector` added to
the loop made the test report 3 allocations and fail.

The test does not cover packet transmission in `sampler/main.cpp`, which uses
fixed arrays, or the reload and fatal error paths.
