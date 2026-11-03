# Large-target probe profile

Profile of the resource and memory-map probes on a large target. It shows
where the time goes, so that a later change starts from evidence.

- Revision: master `168bcb95`. Host: Intel Core i5-9500, six cores, Linux 7.2.8, desktop load.
  Sampler loop pinned to one core. Build: `-O2 -flto`, static.
- Workload: `build/benchmark-victim 500 1 -1 -1 -1 -1 mappings=30000 files=1000 sockets=400`.
  This gives 500 threads, 30,059 `maps` lines, about 1,800 descriptors and 800 TCP sockets.
- The victim path is part of each `maps` line. Compare two builds with the same victim file.

## Cost of one sample

| Sample | Wall | User CPU | Kernel CPU | Where the time goes |
| --- | ---: | ---: | ---: | --- |
| Memory map | 19.1 ms | about 4.1 ms | about 15 ms | The kernel formats 30,059 lines (14.8 ms for 733 `read` calls). Parsing is 2.3 ms and joining lines into regions was 1.1 ms (timed on a saved `maps` file). |
| Resources | 7.1 ms | about 0.9 ms | about 6.2 ms | `readlinkat` on each descriptor 3.0 ms. The `sock_diag` dumps of the namespace 3.4 ms. Other files 0.3 ms. |

- The kernel cost of a `maps` read does not depend on the read size (4, 8, 16 and 64 KiB give 14.8 to 15.0 ms).
  A larger read would only lengthen the time the target's address-space lock is held.
- Reading each descriptor link is needed on every sample. A descriptor number can refer to
  another socket after a close and open, so a cache by number would not keep the data fresh.
- The socket dump is the existing `sock_diag` design. Another way to find the target's sockets
  is a design change and is not in this profile.

## Change: join of `maps` lines

`LayoutBuilder::Add` hashed each name byte by byte (FNV-1a) and built a 40-byte name
for every line, also for lines that join the last region or fall after the region limit.
It now hashes eight bytes at a time and builds the name only for a new region. The output
is the same: 161 real `maps` files give byte-identical regions, `vma_count` and truncation flag.

A/B on the same victim, six interleaved runs of 300 samples (`tests/benchmark_sampling.cpp`):

| Sample | Before p50 | After p50 | User CPU of the whole run |
| --- | ---: | ---: | ---: |
| Memory map | 19.08 ms | 18.17 ms | 1.43 s to 1.20 s |
| Resources | 7.11 ms | 7.17 ms | not changed |

The full sampler (`make benchmark-target-impact`, scenario `apart-10hz-maps-1s`, same victim,
two A/B pairs) used 6.64, 6.61 % of one core before and 6.57, 6.64 % after. This is no
measurable change. A sample every 30 s (the default) saves less than 0.01 % of one core.

## Limits

- One host and one kernel. Other kernels format `maps` at other cost.
- The per-step times of the resource probe come from temporary timers that are not in the repository.
  The totals are reproducible with `make benchmark-slow-samples`.
- A reader of `/proc/PID/maps` takes the target's lock for each `read`. The change does not alter the read size.
