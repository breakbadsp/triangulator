# Memory map

The sampler can send the target's virtual address space to the collector. The
dashboard shows it in the **Memory map** section. The feature is off by
default. Turn it on in the sampler config:

```toml
memory_interval_s = 30   # 0 = off (default), 1..3600
```

## What is sampled

Every `memory_interval_s` seconds the sampler reads, without privileges:

| Source | Values |
|---|---|
| `/proc/PID/status` | `VmSize`, `VmPeak`, `VmData`, `VmStk`, `VmExe`, `VmLib`, `VmPTE`, `VmLck` |
| `/proc/PID/stat` | Minor and major page faults since the process started |
| `/proc/PID/limits` | Soft `RLIMIT_AS` and `RLIMIT_STACK` |
| `/proc/sys/vm/max_map_count` | The maximum number of mappings (VMAs) per process |
| `/proc/PID/maps` | The layout: every mapping's addresses, permissions and path |

Resident memory (RSS, swap) is already in the resource sample, so it is not
repeated here.

The layout joins adjacent mappings of the same file or kind into one region.
A library's code, data and read-only parts become one region. At most 1,000
regions are sent; the mapping count still counts all of them.

## The dashboard section

The section follows the mock-up in
[mockups/process-memory-map.html](mockups/process-memory-map.html):

- **Tiles.** Virtual size, RSS and its growth, RSS split into anonymous,
  file and shared memory, mapping count, major faults and memory pressure.
  RSS, its split and pressure come from resource samples.
- **Findings.** Worked out in the browser: mapping count or address space
  near its limit, major faults with memory pressure, RSS that keeps
  growing, swap, a deleted library or program that is still mapped, and
  the main stack against `RLIMIT_STACK`.
- **Address space.** One bar per run of neighbouring regions of a kind,
  high addresses at the top, with large unmapped spaces shortened. At most
  18 bars: the dashboard merges the smallest neighbours until the map
  fits. Heap, stack, program image and kernel regions are never merged.
- **Zoom.** Facts about the selected bar, a grid of squares that shows
  which of its addresses are mapped and which were mapped since the
  previous layout, charts of the heap size, main stack size and resident
  anonymous memory while the page is open, and the bar's regions.

The squares show the layout from `maps`. Resident, dirty and swapped pages
need `/proc/PID/pagemap`, which the sampler does not read.

## How it runs

The memory map uses the same sampler loop as thread ticks and resource
samples. There is no extra thread and no request from the collector.

1. A thread tick samples the threads and sends them first.
2. If a memory-map sample is due, the tick reads the summary files and opens
   `maps`. A tick that sent a resource sample leaves this to the next tick.
3. The tick reads `maps` in 4 KiB reads. The summary reads and the `maps`
   reads together take at most a quarter of the tick interval (50 ms at
   most). A large `maps` continues on the next ticks from the same file
   position.
4. When `maps` ends, the sampler sends one sample.

## Cost to the target

Reading `/proc/PID/maps` takes the target's memory-map lock (`mmap_lock`) for
reading, once per `read()` call. While the sampler holds it, the target's
`mmap`, `munmap`, `mprotect` and `brk` calls wait. On kernels before 6.4,
page faults can wait too. Small reads keep each wait short. The dashboard
shows the longest single `read()` of the last sample as **Longest maps
read**: one of the target's calls waited for the sampler at most about that
long. The total time of all reads is shown below it. Both are wall times, so
they also count time the sampler waited for the lock or was descheduled.

`status`, `stat` and `limits` take no memory-map lock.

## Wire format

`TVMA` datagrams ([common/memory_wire.hpp](../common/memory_wire.hpp)). The
4-byte magic tells the collector which format a datagram has, so thread
ticks (`TMON`) and resource samples (`TRES`) are unchanged. One sample is a
summary part and, when the layout changed, region parts of 20 regions each.
An unchanged layout is sent again every 10 samples, but at least once a
minute, so a collector that starts later or loses a part gets it soon. The
collector publishes a layout only when all its parts arrived. A lost part
leaves the previous layout in place, and a late part never replaces a newer
layout. A new sampler session drops the previous session's layout.

## Collector

- `GET /api/live` has a `memory` object with the latest summary. Dashboard
  recordings therefore include it.
- `GET /api/memory-map` returns the latest complete layout. Only the latest
  layout is kept; it is not stored in SQLite. Its `id` (session and
  sequence of the sample) matches `layout_id` in the live summary, so the
  dashboard fetches the layout only when the id changes.
