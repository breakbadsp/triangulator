# C++ collector

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
- Decodes and checks every datagram, using the sampler's own wire-format
  definitions (`common/wire.hpp`). Malformed datagrams are counted as bad
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

**5. Storage** (`storage.hpp`)
- One SQLite file per UTC day, in WAL mode, with the same tables the retired
  Python collector wrote, so old files stay readable. Any other tool can read
  them.
- Writes the thread summaries, plus raw samples if `store_raw = true`. The
  `alert_event` table exists but stays empty.
- Commits every 0.5 seconds. Deletes day files older than `retention_days`.

**6. Dashboard and API** (`http.hpp`)
- Serves the dashboard page (`dashboard.html`, built into the
  binary).
- `GET /api/live`: current threads, group counts and monitor health (sampler
  connected or silent, target, packet loss, packet counters, sample interval).
  Rebuilt every 0.5 seconds.
- `GET /api/history?session=…&tid=…&start=…&end=…`: one thread's summary rows
  for a time range, read from SQLite (at most 2,000).
- Any other method than `GET` gets 501.
- Runs on its own thread, so serving the dashboard never delays receiving data.

**7. Shutdown** (`main.cpp`)
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
| `protocol.hpp` | Datagram decoding and thread-state classification |
| `engine.hpp` | `Monitor`: ticks, per-thread state, summaries, health, live snapshot |
| `storage.hpp` | SQLite day files, retention, history queries |
| `http.hpp` | Dashboard server and the `/api/live` and `/api/history` endpoints |
| `dashboard.html` | The dashboard page, built into the binary with `#embed` |
| `log.hpp` | Timestamped log lines on stderr |

## Why it is C++

Receiving datagrams, building state, storing and serving the API are latency-
and performance-critical, so they stay in C++ (see `../AGENTS.md`). Measured
against the Python collector on the same data, it uses several times less CPU
and memory, and its dashboard API stays fast under load. See
`../docs/collector-comparison.md` for the numbers.

Tests: `make check` runs `tests/collector_test.cpp` (decoding, ticks, sessions,
summaries, storage, health) and an end-to-end test with the real sampler
(`tests/test_monitor.py`).
