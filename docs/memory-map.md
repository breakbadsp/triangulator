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

## How it runs

The memory map uses the same sampler loop as thread ticks and resource
samples. There is no extra thread and no request from the collector.

1. A thread tick samples the threads and sends them first.
2. If a memory-map sample is due, the tick reads the summary files and opens
   `maps`. A tick that sent a resource sample leaves this to the next tick.
3. The tick reads `maps` in 4 KiB reads for at most a quarter of the tick
   interval (50 ms at most). A large `maps` continues on the next ticks from
   the same file position.
4. When `maps` ends, the sampler sends one sample.

## Cost to the target

Reading `/proc/PID/maps` takes the target's memory-map lock (`mmap_lock`) for
reading, once per `read()` call. While the sampler holds it, the target's
`mmap`, `munmap`, `mprotect` and `brk` calls wait. On kernels before 6.4,
page faults can wait too. Small reads keep each wait short. The dashboard
shows the total read time of the last sample as **Maps read cost**.

`status`, `stat` and `limits` take no memory-map lock.

## Wire format

`TVMA` datagrams ([common/memory_wire.hpp](../common/memory_wire.hpp)). The
4-byte magic tells the collector which format a datagram has, so thread
ticks (`TMON`) and resource samples (`TRES`) are unchanged. One sample is a
summary part and, when the layout changed (or every 10th sample), region
parts of 20 regions each. The collector publishes a layout only when all its
parts arrived. A lost part leaves the previous layout in place.

## Collector

- `GET /api/live` has a `memory` object with the latest summary. Dashboard
  recordings therefore include it.
- `GET /api/memory-map` returns the latest complete layout. Only the latest
  layout is kept; it is not stored in SQLite.
