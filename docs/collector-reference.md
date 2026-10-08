# Collector reference

See the [collector overview](../collector/README.md) for a quick start.
Run commands from the repository root.

`build/triangulator-collector` is the collector. It receives the
sampler's UDP datagrams, turns them into per-thread state and 5-second
summaries, stores those in SQLite and serves the dashboard.

```sh
make                                                    # builds build/triangulator-collector
build/triangulator-collector config/local/collector.toml
build/triangulator-collector config/local/collector.toml --check-config
```

`scripts/start.sh` starts it for you.

## What it does

**1. Startup and config** (`config.hpp`, `toml.hpp`, `main.cpp`)
- Reads `collector.toml`, with the defaults the retired Python collector used.
- `--check-config` validates the file and exits.
- Alert settings in the file (`[alerts]` thresholds, `webhook_url`,
  `deadman_url`, `[alerts.smtp]`) are accepted and ignored, with one startup
  warning. Only `[alerts] window_s` is used: the length of a summary window
  (5–10 s).

**2. Receiving sampler data** (`protocol.hpp`, `main.cpp`)
- Listens on UDP (IPv4 or IPv6) with a 4 MB receive buffer.
- Accepts datagrams only from the sampler's IP: `sampler_ip` from the config,
  or else the first sender it hears from.
- Decodes and checks every datagram, using the wire-format definitions
  shared with the sampler (`common/wire.hpp`, `common/resource_wire.hpp`). Malformed datagrams are counted as bad
  packets and dropped.

**3. Rebuilding each tick** (`engine.hpp`, `Monitor`)
- The sampler splits one sample of all threads (a "tick") across several
  datagrams. The collector puts the pieces back together. It copes with pieces
  arriving out of order, arriving twice, or never arriving: a tick with missing
  pieces is still used.
- Estimates packet loss over the last 60 seconds from gaps in the tick numbers.
- Starts fresh when the sampler restarts or the target process changes (a new
  session).
- Notices when a thread ID now belongs to a new thread (its counters went
  backwards) and treats it as a new thread.
- Drops threads that exit, or that haven't been reported for
  `max(10 s, 3 sample intervals)`.

**4. Per-thread state and statistics** (`engine.hpp`)
- Sorts each thread into a coarse state from its scheduler state and kernel
  wait channel: running, futex wait, poll, socket, pipe, sleep, stuck in kernel,
  stopped, other, or no access.
- Puts each thread in a group by its name prefix (`[[group]]` in the config).
- Keeps up to 10 minutes of raw samples per thread in memory, capped in total by
  `max_live_samples`.
- At the end of every window (default 5 s), writes one summary row per thread:
  CPU %, run delay %, context switches, read and write bytes per second, major
  page faults, and how many samples the thread spent in each state.

**4b. Resource samples** (`resources.hpp`, `ResourceMonitor`)
- Puts each resource sample (`common/resource_wire.hpp`: a summary datagram
  and up to four socket datagrams) back together, waiting up to two seconds for
  missing parts.
- Turns cumulative counters into rates over the interval since the previous
  sample of the same session and process: pressure stall shares, storage I/O,
  network drop and error counters, and per-socket drops, retransmissions and
  window-limited time. Counters that went backwards give no rate.
- Keeps the latest sample for `/api/live` and writes one `resource_sample`
  row per sample. Like the thread side, it evaluates no alert rules.

**5. Storage** (`storage.hpp`)
- One SQLite file per UTC day, in WAL mode, with the same tables the retired
  Python collector wrote, so old files stay readable. Any other tool can read
  them.
- Writes the thread summaries, plus raw samples if `store_raw = true`, and
  the resource samples (`resource_sample`; older day files gain the table). The
  `alert_event` table exists but stays empty.
- Commits every 0.5 seconds. Deletes day files older than `retention_days`.

**6. Dashboard and API** (`http.hpp`)
- Serves the dashboard page (`dashboard.html`, built into the
  binary).
- `GET /api/live`: current threads, group counts and monitor health (sampler
  connected or silent, target, packet loss, packet counters, sample interval).
  Rebuilt every 0.5 seconds. Its `resources` object is the latest resource
  sample: pressure, descriptors, I/O, socket queues, namespace counters.
  Its `memory` object is the latest memory-map summary
  ([memory-map.md](memory-map.md)).
- `GET /api/memory-map`: the latest complete memory-map layout: regions with
  start and end addresses (hex strings), size, kind, permissions and mapping
  count. Not stored; only the latest layout is kept.
- `GET /api/history?session=…&tid=…&start=…&end=…`: one thread's summary rows
  for a time range, read from SQLite (at most 2,000).
- `GET /api/resources?start=…&end=…`: stored resource samples for a time
  range (default the last 15 minutes), combined into at most about 1,000
  buckets: gauges keep their peak, counter growth adds up.
- `GET /api/target`: the local sampler's configured process name or PID.
  `POST /api/target` with JSON `{"target":"NAME_OR_PID"}` and
  `X-Triangulator: 1` validates, saves and requests a sampler reload. The
  dashboard exposes this through **Change target**. This optional control uses
  `scripts/sampler_control.py` and Python 3, requires a loopback HTTP listener
  and a local sampler started from the same checkout, and checks that the
  sampler sends to this collector's loopback UDP endpoint. Errors leave the
  config unchanged unless the reload signal fails after saving (reported as
  such). The sampler and collector must run as the same user.
- `GET /api/replay`: oldest/newest recorded process view; add `at=…` for a
  view at or before a timestamp, or `direction=previous|next` to step.
- Other non-`GET` requests get 501.
- Runs on its own thread, so serving the dashboard never delays receiving data.

**7. Recording** (`replay.hpp`, off unless `replay_interval_s` is set)
- Saves the `/api/live` view every `replay_interval_s` seconds to separate day
  files in `data_dir/replay/`, on its own thread. The receive loop only hands
  over the view it already built.
- A failed write (a full disk, say) is logged and retried with the next view;
  it never stops the collector.
- An exception to "richer dashboard data is a separate program" in
  `AGENTS.md`: recording lives in the collector because it reuses the view the
  collector already builds. It is off by default and runs off the receive loop.

**8. Shutdown** (`main.cpp`)
- On SIGINT or SIGTERM, it processes ticks still waiting for missing pieces,
  writes the last partial summaries, commits SQLite and exits.

## What it does not do

- **No alerting.** There are no alert rules, no dashboard alert settings and no
  delivery (webhook, dead-man ping, email). The dashboard hides its alert parts
  because `/api/live` has no alert fields. Alerting will be a separate module
  that reads the summaries from SQLite or the HTTP API; its starting code is in
  `../alerting/`. Until it is finished, nothing sends alerts.
- **No `/proc` reading.** That is the sampler's job; the collector only sees
  what arrives over UDP.

## Files

| File | Contents |
|---|---|
| `main.cpp` | Command line, the receive loop, signals, shutdown |
| `config.hpp` | Loading and checking the config file |
| `toml.hpp` | TOML reader (the subset collector configs use) |
| `json.hpp` | JSON values, parser and writer |
| `protocol.hpp` | Datagram checks (on top of `common/wire.hpp`) and thread-state classification |
| `engine.hpp` | `Monitor`: ticks, per-thread state, summaries, health, live snapshot |
| `resources.hpp` | `ResourceMonitor`: resource samples, rates, live JSON, stored rows |
| `memory.hpp` | `MemoryMonitor`: memory-map summary and layout reassembly, live and layout JSON |
| `storage.hpp` | SQLite day files, retention, history queries |
| `http.hpp` | Dashboard server and the `/api/live`, `/api/memory-map`, `/api/history`, `/api/resources` and `/api/replay` endpoints |
| `target_control.hpp` | Bounded bridge to the optional local sampler control script |
| `replay.hpp` | Recording thread for dashboard views, and the `/api/replay` queries |
| `dashboard.html` | The dashboard page, built into the binary (the Makefile turns it into `build/dashboard_html.inc`) |
| `log.hpp` | Timestamped log lines on stderr |

## Why it is C++

Receiving datagrams, building state, storing and serving the API are latency-
and performance-critical, so they stay in C++ (see `../AGENTS.md`). Measured
against the Python collector on the same data, it uses several times less CPU
and memory, and its dashboard API stays fast under load. See
[collector comparison](collector-comparison.md) for the numbers.

Tests: `make check` runs `tests/collector_test.cpp` (decoding, ticks, sessions,
summaries, storage, health) and an end-to-end test with the real sampler
(`tests/test_monitor.py`).

## Optional socket and message observations

The C++ collector accepts raw `TSIO` observations from the optional C++/eBPF
socket sampler alongside the unchanged scheduler sampler. Raw socket records
are always stored in WAL day files, even with `store_raw=false`. Socket totals
and rates are calculated by a separate read-only C++ executable invoked by the HTTP
worker and exposed at `/api/socket-io`; UDP ingestion only validates and stores
raw records. The dashboard shows received/sent bytes and, when an application
completion marker is configured, messages processed. See
[the socket design and setup guide](socket-ingress-design.md) for build
instructions, permissions, the marker contract, and explicit coverage limits.


## Historical process inspection

The dashboard's **Inspect a moment** controls freeze the process overview and
thread table at one recorded view. Recordings include the process PID/session,
thread membership and generations, scheduler state classification, wait channel,
last core, ten-second state mix and rates, group counts and monitor health.
They survive collector restarts and sampler session changes. Missing history is
reported explicitly; old rollup-only databases are never treated as exact views.

`replay_interval_s` defaults to `0` (off). It accepts `0.5`–`60` seconds, or
`0` to disable recording. Actual times are limited by the collector's ~0.5-second
publish cadence and scheduling; lowering it does not recover samples between
publications. Selecting a time returns the nearest earlier recording, never a
future frame or an interpolated state. Low sampler rates and packet loss also
limit the observation's precision. Snapshots continue to record silence or a
missing target after a sampler session has been established. No snapshots are
written before the first session. History begins when this version is deployed;
old summaries cannot recover exited threads, wait channels or core placement.

Recordings go to their own daily WAL files, `data_dir/replay/YYYY-MM-DD.sqlite3`,
with one table, `process_snapshot(ts, snapshot)`. The receive loop hands the
serialized live response to a recording thread and moves on; if that thread
falls behind, the newest view replaces the one still waiting. The recording
thread deletes replay files older than `retention_days`. A failed write is
logged once, retried with the next view, and logged again when it recovers;
it does not stop the collector or the rollups.

A query reads the day file of the requested time first and stops at the first
match, and reads the bounds from the oldest and newest files. The stored view
is returned as written, without parsing it again. A file that can't be read
(damaged, or deleted by retention during the query) is skipped.

The API returns `first`, `last`, `snapshot` and `interval_s`. Without `at`,
`snapshot` is null and only the bounds are read. With `at=UNIX_SECONDS`, the
snapshot has its own `recorded_at` and `recording_interval_s`; its health/session
belongs to that recording. `direction=previous` uses `< at`, `next` uses `> at`.
No matching recording returns `snapshot: null`. Invalid arguments return 400. The thread drawer uses the archived session and anchors
preset history ranges at the selected recording. Live trends are kept separate
and restored on return; historical load averages and socket reports are unavailable.

Budget disk space for full JSON views: storage scales with thread count and
recording frequency, including silent periods. A local 30-second run with
1,000 synthetic threads at 10 Hz produced ~327 KB per view: roughly 28 GB/day
at one view per second, before SQLite overhead. Use a longer recording interval
or disable recording for large processes when that cost is unsuitable.
In that short run, with an earlier version that wrote recordings from the
receive loop, recording disabled/enabled used 2.17%/2.67% of one CPU core, with
peak PSS ~74/~78 MiB. Both retained all 1,000 threads with 0% estimated packet
loss; replay HTTP p95 was ~9.5 ms. These are local smoke measurements, not a
steady-state capacity guarantee.
