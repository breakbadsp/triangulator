# Triangulator

Linux thread monitoring using `/proc`: a C++23 sampler sends UDP to a C++
collector with a live dashboard and daily SQLite history. Alerting is a separate
module (`alerting/`) that is not wired up yet, so for now nothing sends alerts.
Start with the [architecture diagrams](docs/architecture.md); see the
[full design](docs/thread-monitor-design.md) for details.

## Quick start

Two programs: the **sampler** runs next to the process you want to watch and sends
its threads' stats over UDP; the **collector** receives them and serves the dashboard.
To build and start everything on one machine:

```sh
scripts/start.sh
```

The script creates `config/local/sampler.toml` and `config/local/collector.toml`
on first use, builds the sampler, validates the collector config, and starts both
programs. The local configs use loopback addresses, save history in `data/`, detect
the host's clock ticks, and leave webhook delivery disabled. Existing local configs
are preserved; running the script again leaves already-running services alone.

Select a target by process name or PID without restarting the sampler:

```sh
scripts/set-target.sh ghostty
scripts/set-target.sh 1234
```

The script updates the config used by the running sampler and sends `SIGHUP` to
reload it. Numeric arguments select a PID; other arguments select an exact Linux
process name (up to 15 bytes). Start the sampler with `scripts/start.sh` first.
Until you select a running target, the dashboard reports the target as absent. Run the scripts
as the same user as the target process. Open <http://127.0.0.1:9401>.

Change the thread sampling frequency without restarting:

```sh
scripts/set-rate.sh 5       # 5 Hz: one sample every 200 ms
```

The accepted range is 0.2–10 Hz. This updates the running sampler's config and
requests a reload, starting a new session. Higher frequencies increase sampling
overhead. The separate socket observer's one-second reporting interval is unchanged.

```sh
scripts/stop.sh       # stop both
scripts/start.sh      # rebuild if needed and start both
```

The collector (`build/triangulator-collector`) does **no alerting**; see
[Alerting](#alerting).

Logs are in `.run/`; local configs are ignored by git. For separate hosts or custom
config paths, the optional `scripts/start.sh collector path/to/collector.toml` and
`scripts/start.sh sampler path/to/sampler.toml` commands remain available, along
with `scripts/stop.sh collector` and `scripts/stop.sh sampler`. To deploy with
systemd, see [Production setup](#production-setup).

## Requirements and build

Linux, GCC/libstdc++ 13+ (C++23: `std::expected`, `std::format`, `std::byteswap`),
Make and Python 3.11+, plus libsqlite3 development files for the collector.
Python is used by `scripts/start.sh`, the tests and the alerting module; it
needs no third-party packages.

```sh
make          # sampler, collector and read-only socket report helper
make check    # C++ and Python tests
make format   # format C++ code (2 spaces, Allman braces)
make format-check # verify C++ formatting
```

## Configuration

- **Sampler** (`config/sampler.toml`): flat `key = value` with quoted strings,
  booleans and `#` comments. Unknown or duplicate keys and malformed values are
  rejected. The collector address must be a numeric IPv4 or `[IPv6]:port` (no DNS).
  `rate_hz` accepts 0.2–10. `SIGHUP` reloads the file; an invalid file leaves the old
  settings active, and a successful reload starts a new session.
- **Collector** (`config/collector.toml`): full TOML, read at startup, so restart
  after changes. Validate with
  `build/triangulator-collector config/collector.toml --check-config`. The
  `[alerts]` settings and `deadman_url` are for the alerting module; the collector
  ignores them with a warning, apart from `[alerts] window_s`, the rollup window.
  - `clock_ticks` must equal `getconf CLK_TCK` **on the target host**; the wire
    format does not carry it.

## Dashboard

Shows thread groups, latest state and wait channel, a ten-second state mix, CPU,
run delay, I/O, monitor health, and per-thread history. The page also has alert
sections and alert settings; it hides them because the collector's `/api/live` has
no alert fields.

The HTTP listener defaults to loopback. Neither UDP nor HTTP is authenticated, so
use an SSH tunnel or an authenticating reverse proxy for remote access.

The API is read-only (other methods than `GET` get 501): `/api/live` and
`/api/history?session=SESSION&tid=TID&start=UNIX_SECONDS&end=UNIX_SECONDS`
(at most 2,000 rollups; narrow the interval if `truncated` is true).

## Production setup

The units in `deploy/` are templates with a placeholder target user and collector
IP; edit them first. Install the sampler, collector and `triangulator-socket-report`
binaries in `/usr/local/bin`
and configuration in `/etc/triangulator`. `triangulator-collector.service` runs
the collector. Keep sampler code
and configuration root-owned and not writable by the target user. The collector unit
creates `/var/lib/triangulator`.

```sh
triangulator-collector /etc/triangulator/collector.toml
./build/triangulator-sampler /etc/triangulator/sampler.toml   # as the target user
```

The sampler unit runs at niceness 19 with a 5% CPU quota, a 32 MiB memory limit,
no capabilities and an outbound IP allowlist. Tune the quota after measuring your
real thread count and rate; overruns skip deadlines. The sampler opens no listening
socket, sends no signals to the target and writes no files. Messages go to stderr
(journald), with a one-minute warning rate limit.

Checklist before going live (design section 12):

- Run the sampler as the target user. It needs no privileges: `stat`, `schedstat`,
  `io` and `wchan` are readable by the same user under any Yama `ptrace_scope`.
  It warns if every sleeping thread's wait channel is hidden.
- Check scheduler statistics under load. If they are missing or all zero, set
  `status_fallback = true` in the sampler config. Zeros alone cannot tell an idle
  process from disabled accounting, so this is your call. Run-delay percentage is
  unavailable in fallback mode.
- Check thread-name prefixes fit Linux's 15-byte limit and the wait-channel names
  your kernel reports (`cat /proc/PID/task/*/wchan`). Unknown names show as `other`.
- Restrict UDP by firewall or WireGuard and route it on the management network.
  Set `sampler_ip`; otherwise the collector pins the first sender it sees.
- Check the disk budget. Nothing alerts yet (see [Alerting](#alerting)), not
  even if the collector stops, so watch the collector and sampler units by other
  means.

## How it behaves

- **Wire format:** 48-byte header and 112-byte records (version 2), little-endian,
  at most 10 threads per datagram. A tick holds at most 2,550 threads; the rest are
  dropped with a warning.
- **Loss and reordering:** chunks are deduplicated and reordered for up to two
  sample intervals (max two seconds). Partial ticks are still used, and a missing
  chunk never implies a thread exit. Threads unseen for `max(10 s, 3 intervals)`
  expire. Packet loss is estimated over the last minute.
- **Time:** CPU and scheduler deltas use the sampler's monotonic clock. Counter
  regressions, new sessions and counter-mode changes reset baselines. History needs
  synchronized wall clocks; offsets over one day fall back to arrival time.
- **File descriptors:** the sampler raises its soft open-file limit to the hard
  limit and keeps four `/proc` files open per thread while the budget allows (32
  are reserved); extra threads reopen their files each tick. Running out of
  descriptors skips a tick rather than reporting the target absent.
- **Storage:** live samples expire after ten minutes and are capped by
  `max_live_samples` (default one million). History is one SQLite file per UTC
  day (WAL mode) with per-thread rollups, committed every half second.
  `store_raw = true` also saves decoded records. Retention deletes whole day files,
  keeping today and the previous `retention_days - 1`. Old day files gain new
  columns when opened.

## Collector

`collector/` is the core collector, written in C++ (`scripts/start.sh`,
`deploy/triangulator-collector.service`):
`build/triangulator-collector config/local/collector.toml`.
[collector/README.md](collector/README.md) lists what it does.

**Rule:** latency- and performance-critical code (receiving datagrams, building
per-thread state and rollups, storage, the dashboard API) belongs in C++ or Rust.
Alerting, notifications, reports and richer dashboard data are separate programs
that read the SQLite files or the HTTP API. They must stay off the UDP stream and
out of the collector's main loop. A separate program that needs per-sample data
at high rates must itself be written in C++ or Rust.

The collector replaced an earlier Python collector, which was removed after the
C++ one was shown to store identical rollups for several times less CPU and
memory: see [docs/collector-comparison.md](docs/collector-comparison.md).

## Alerting

Nothing sends alerts at the moment. The collector has no alert rules, no dashboard
alert settings and no webhook, dead-man or email delivery. Alerting will be a
separate module that reads the rollups from SQLite or the HTTP API.

`alerting/` holds the Python collector's alerting code, kept as the start of that
module: alert settings and their validation, the alert state machine (open,
remind, resolve), the alert event log and webhook/email delivery. It is not
connected to the collector and does not run. [alerting/README.md](alerting/README.md)
describes what is there and what is missing, including each rule's condition.

## Socket I/O and messages processed

The C++ dashboard includes received/sent socket bytes, monitoring-period totals
and averages, recent minimum/maximum rates, and a breakdown by thread and socket
kind. Build the optional source with `make socket-sampler`; it requires existing
BPF tracing privileges and a compatible kernel. Completion counts require an
explicit application marker called once after successful processing. Setup and
measurement limits are in [the socket design guide](docs/socket-ingress-design.md).
Reporting runs in the separate `triangulator-socket-report` executable installed
next to the collector; `/api/socket-io?pid=PID` exposes the report.

With the collector running, start observation on the target host:

```sh
scripts/set-target.sh ghostty
scripts/watch-sockets.sh --sudo ghostty
# Or use a PID, optionally with an application completion marker:
scripts/watch-sockets.sh --sudo --marker /absolute/path/to/application TriangulatorMessageProcessed 1234
```

The wrapper builds the optional source (clang with BPF support and libbpf
development files are required), resolves the target, and runs in the foreground.
`--sudo` elevates only the observer; omit it when tracing privileges are already
available. Ctrl+C stops it. Logs are appended to `.run/socket-sampler.log`.
The collector endpoint defaults to `config/local/sampler.toml`; override it with
`--collector IP:PORT` for custom configs or a remote collector. The dashboard's
Socket I/O & message processing panel follows the normal sampler's target PID,
so use `scripts/set-target.sh` to select the same PID. Choose Received, Sent, or
Messages processed in that panel.
Message counts remain unavailable without an application completion marker;
socket traffic alone cannot tell when a message has finished processing.
Restart the wrapper when switching targets or when the target process restarts.

## Layout

- `sampler/`: C++ sampler (`main.cpp` loop, plus headers for config, `/proc`
  parsing and cache, RAII resources).
- `common/`: code both programs use: the datagram format (`wire.hpp`, encode
  and decode) and the `FileDescriptor` wrapper (`fd.hpp`). It depends only on
  the standard library, so neither program depends on the other's directory.
- `collector/`: C++ core collector, without alerting, and the dashboard page it
  serves (`dashboard.html`).
  [collector/README.md](collector/README.md) lists what it does.
- `alerting/`: Python alerting code kept for the future alerting module; not
  wired up (see [alerting/README.md](alerting/README.md)).
- `socket_sampler/`: optional C++/eBPF socket and completion-marker source.
- `metrics/`: separate read-only C++ reporting program.
- `config/`, `deploy/`: example configuration and systemd units.
- `scripts/`: `start.sh` and `stop.sh`.
- `tests/`: C++ tests (wire format, sampler, collector) and Python tests (alerting, and
  end-to-end runs of the real sampler and collector, including a real `/proc`
  check).
