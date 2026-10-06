# Collector heap allocations

## Result

The collector now allocates heap memory only at startup. This is the same rule
as for the sampler (see `docs/tigerstyle-adaption.md`).

`build/collector-allocation-test` counts the allocations of the datagram path
after startup. `make check` runs it. The test replaces `malloc`, `calloc`,
`realloc` and the aligned allocation functions. It counts every call,
including calls from `libstdc++` and libc.

| Measurement (60 ticks, 25 threads, 12 resource samples) | Before | After |
| --- | --- | --- |
| `store_raw = false` | 3,385 | 0 |
| `store_raw = true` | 6,422 | 0 |

The "before" numbers come from the code at revision `9fa7bbc`. The same test
program ran against it.

SQLite makes a few allocations of its own. They are counted separately
(4 and 41 in the same runs). SQLite grows its page cache while a day file
grows. The growth stops at the cache size limit. The test prints this number.
It does not require zero.

## What the datagram path is

The path starts when the main loop receives a datagram. It includes:

1. `Ingest::Handle`: decode of the datagram and the sender check.
2. `Monitor::Accept`, `Monitor::Drain` and `Monitor::Close`.
3. `ResourceMonitor::Accept` and `ResourceMonitor::Drain`.
4. The row writes to `Storage`, and `Storage::Flush`.

## What is not covered

These parts still allocate. They are not on the datagram path.

- The refresh every 500 ms: `Monitor::Health`, `Monitor::Snapshot`,
  `ResourceMonitor::Snapshot` and the JSON text for the dashboard.
- The HTTP server, the dashboard API and the replay recorder.
- Startup, and the log line when the collector pins the sampler address.
- The first row of a new UTC day. It opens the day file.
- The allocations that SQLite makes.

## Selected changes

The goal was zero allocations after startup, with simple code. This table
gives the fix for each source.

| Source | Fix | Reason |
| --- | --- | --- |
| `std::string` thread name and wait channel in `Record` | `FixedText<48>` and `FixedText<96>` in `collector/bounded.hpp`. | The wire fields are 16 and 32 bytes. One invalid byte becomes 3 bytes (U+FFFD), so the buffers hold the worst case. |
| `std::vector<Record>` in `Packet` and `Part` | A fixed array with a count. | A datagram holds at most 10 records or 6 sockets. |
| `std::map` of pending ticks, with `std::map` and `std::vector` for the chunks | `Monitor` has 128 tick slots. Each slot has a `BoundedVector` for 2,550 records and a bit set for the chunks. | `BoundedVector` reserves its capacity at construction. It never grows. |
| `std::map<tid, ThreadState>` | A table of 2,550 slots, plus a sorted index of thread IDs. | The sorted index keeps the output order of `std::map`. |
| `std::shared_ptr<const Record>` per sample, `std::deque` of raw samples, `std::vector` window | `Sample` holds its `Record` by value. Raw samples are lists in one arena of `max_live_samples + 2,550` nodes. The rollup window is summed as samples arrive. | The window needs only the first sample, the last sample, the count and the state counts. |
| `std::map<tid, generation>` | A zeroed array with one entry for each possible thread ID (4,194,304). An epoch number resets it for a new session. | Linux thread IDs do not exceed 4,194,304. `Decode` now rejects a larger ID. |
| `std::set` and `std::vector` in `Process` | A stamp in each thread slot, and one pass with `RemoveThreadsIf`. | No temporary container is needed. |
| `std::deque` of loss entries and retired sessions | `Ring` with a fixed array. | Both have a limit. A full ring drops the oldest entry. |
| Rows that wait in `std::vector`, with `std::string` fields | `RowSink`. A monitor builds a row on the stack and passes it to the sink at once. Rows hold `FixedText`. | A buffer for pending rows needs a limit that a burst can exceed. The sink has no buffer. |
| `std::string` state counts text and stored sockets JSON | `AppendInteger`, `AppendDouble` and `AppendJsonString` in `collector/text.hpp` write into a `FixedText`. | The text is the same as before. |
| `std::to_string`, `std::format` and `DumpJson` in `Storage` | `std::to_chars` into a buffer. The raw sample JSON is written by `AppendRecordJson`. Day files are keyed by `Days`, not by a string. | No temporary string. |
| `SQLITE_TRANSIENT` text binds | `SQLITE_STATIC`. | SQLite reads the text in place. It makes no copy. |
| Peer address `std::string` | `PeerText`, a `FixedText`. | No allocation for each datagram. |

### New limits

A limit is a documented value. The collector counts the work that goes over it.

- 2,550 threads at one time (`kMaxTrackedThreads`). A sample of a thread over
  the limit is dropped. `Monitor::Health` reports `dropped_samples`.
- 128 pending ticks, 128 retired sessions, 4,096 loss entries.
- `max_live_samples` is a startup value. A larger value in a later run needs a
  restart. The Monitor drops the oldest sample of a thread when the arena is
  full.
- The stored sockets column holds up to 4,096 bytes. A socket that does not fit
  is left out.

### Memory use

The constructors reserve the storage. The operating system gives physical
pages only when the program writes to them. With the default configuration an
idle collector has about 410 MB of virtual memory and 6 MB of resident memory.
The large items are:

- Tick slots: 128 x 2,550 records, about 70 MB.
- Sample arena: 1,002,550 nodes, about 280 MB.
- Generation table: 4,194,305 entries of 8 bytes, 32 MB. It is allocated with
  `calloc`, so its pages stay unused until a thread ID uses them.

### Rejected approaches

- **A `std::pmr` arena.** An arena that throws `std::bad_alloc` when full does
  not fit the project's error rule. Rows with a limit would also need a
  decision on what to drop.
- **Row vectors with a limit and a drop counter.** One burst of ticks can make
  the number of rows exceed any limit that is small enough to be useful. The
  sink has no limit to exceed.
- **A custom SQLite allocator for the collector.** It would also cover SQLite's
  own allocations. It needs a general allocator that is safe for threads. The
  dashboard threads also use SQLite. The gain is small, because the growth of
  the page cache stops.

## Allocation test

`tests/collector_allocation_test.cpp` builds real datagrams with the shared
wire encoders. It sends 30 ticks of 25 threads as a warm-up. Then it measures
60 more ticks. This includes more than ten rollup windows, 12 resource
samples and a `Storage::Flush` for each tick. It runs twice: with and without
`store_raw`.

The test is linked dynamically with its own `malloc`. A static link would
give a duplicate symbol, so the sampler's test uses `--wrap` instead. The
dynamic link also lets the test count the allocations in `libsqlite3`.
