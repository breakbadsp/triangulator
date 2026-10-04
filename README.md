# Triangulator

Linux thread monitoring using `/proc`: a C++23 sampler sends UDP to a C++
collector with a live dashboard and daily SQLite history. The Python collector
in `triangulator/` is kept as a backup and, for now, is the one that alerts.
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

Set `target_process` (or `target_pid`) in `config/local/sampler.toml` to the process
you want to monitor, then restart to apply your configuration. Until you select a
running target, the dashboard reports the example target as absent. Run the scripts
as the same user as the target process. Open <http://127.0.0.1:9401>.

```sh
scripts/stop.sh       # stop both
scripts/start.sh      # rebuild if needed and start both
```

The collector started is the C++ one (`build/triangulator-collector`), which does
**no alerting**. To use the Python collector instead, for example to get alerts,
stop the collector and start it with `TRIANGULATOR_COLLECTOR=python`:

```sh
scripts/stop.sh collector
TRIANGULATOR_COLLECTOR=python scripts/start.sh collector config/local/collector.toml
```

Logs are in `.run/`; local configs are ignored by git. For separate hosts or custom
config paths, the optional `scripts/start.sh collector path/to/collector.toml` and
`scripts/start.sh sampler path/to/sampler.toml` commands remain available, along
with `scripts/stop.sh collector` and `scripts/stop.sh sampler`. To deploy with
systemd, see [Production setup](#production-setup).

## Requirements and build

Linux, GCC/libstdc++ 13+ (C++23: `std::expected`, `std::format`, `std::byteswap`),
Make and Python 3.11+, plus libsqlite3 development files for the collector, which
needs GCC 15+ (for `#embed`). Python is used by the backup collector, the scripts
and the tests; it needs no third-party packages.

```sh
make          # build/triangulator-sampler and build/triangulator-collector
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
  `build/triangulator-collector config/collector.toml --check-config` (or
  `python3 -B -m triangulator config/collector.toml --check-config` for the
  Python collector). Alert settings below apply to the Python collector only;
  the C++ collector ignores them with a warning.
  - `clock_ticks` must equal `getconf CLK_TCK` **on the target host**; the wire
    format does not carry it.
  - `[alerts]` takes a `webhook_url` and/or SMTP settings. Webhooks receive JSON
    with `ts`, `rule`, `group`, `tid`, `name`, `session`, `detail`, `severity` and
    `status` (`opened`, `reminder`, `resolved`). The SMTP password comes from the
    environment variable named by `password_env`; STARTTLS is on by default.
    Without a delivery destination, alerts still appear in the dashboard and SQLite.

## Dashboard

Shows thread groups, latest state and wait channel, a ten-second state mix, CPU,
run delay, I/O, open and recent alerts, monitor health, and per-thread history.

The HTTP listener defaults to loopback. Neither UDP nor HTTP is authenticated, so
use an SSH tunnel or an authenticating reverse proxy for remote access.

**Alert settings** turn each rule on or off and change its thresholds (CPU
warn/critical percentages and sustain time, run delay, kernel wait, sampler
silence, target absence, packet loss, reminder interval). Changes apply
immediately and are saved to `alert-settings.json` in `data_dir`, layered over the
TOML. *Reset to config file* deletes that file. Turning a rule off resolves its
open alerts. Delivery destinations and window sizes stay in the TOML.

Anyone who can reach the dashboard can change alert settings. Writes need a JSON
body with an `X-Triangulator: 1` header and an IP-literal, `localhost` or
`http_host` host name; list reverse-proxy names in `http_allowed_hosts`.

Read-only APIs: `/api/live` and
`/api/history?session=SESSION&tid=TID&start=UNIX_SECONDS&end=UNIX_SECONDS`
(at most 2,000 rollups; narrow the interval if `truncated` is true).

## Production setup

The units in `deploy/` are templates with a placeholder target user and collector
IP; edit them first. Install the sampler and collector binaries in `/usr/local/bin`
and configuration in `/etc/triangulator`. `triangulator-collector.service` runs
the C++ collector. `triangulator-collector-python.service` is the Python backup
(install `triangulator/` in `/opt/triangulator`). The two units conflict, so
starting one stops the other. Keep sampler code
and configuration root-owned and not writable by the target user. The collector unit
creates `/var/lib/triangulator`.

```sh
triangulator-collector /etc/triangulator/collector.toml
# backup with alerting: python3 -B -m triangulator /etc/triangulator/collector.toml
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
- Test the alert destination, the disk budget and the optional `deadman_url`
  (an external endpoint that alerts you if the collector stops).

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
- **Alerts** (Python collector only; the C++ default collector does no alerting):
  the CPU alerts, other alerts, restart and delivery items below describe the
  Python collector.
- **CPU alerts:** CPU is measured over the trailing second. An alert opens when a
  thread stays above `cpu_warn_pct` or `cpu_crit_pct` for `cpu_sustain_secs`
  (default 5) and resolves after the same time below. Shorter bursts never alert,
  and a sampling gap or threshold change restarts the timer.
- **Other alerts:** starvation uses 5–10 s windows (three bad windows to open, two
  clear to resolve); kernel wait (`D` state) uses a duration. Ordinary waits
  (futex, socket, poll, pipe) never alert; they appear as block types you can filter.
- **Storage:** live samples expire after ten minutes and are capped by
  `max_live_samples` (default one million). History is one SQLite file per UTC
  day (WAL mode) with per-thread rollups, committed every half second.
  `store_raw = true` also saves decoded records. Retention deletes whole day files,
  keeping today and the previous `retention_days - 1`. Old day files gain new
  columns when opened.
- **Restart:** open and recent alerts are restored from SQLite; sample windows start
  fresh.
- **Delivery:** alerts are sent outside the UDP loop with three retries per channel
  and a bounded queue. This is best effort, not a durable outbox; failures show in
  monitor diagnostics and every event stays in SQLite. Reminders default to 30
  minutes.

## C++ collector

`collector/` is the C++ core collector and the default (`scripts/start.sh`,
`deploy/triangulator-collector.service`). It reads the same config file as the
Python collector, stores the same SQLite rollups and serves the same dashboard,
`/api/live` and `/api/history`: `build/triangulator-collector config/local/collector.toml`.

It does **no alerting**: no alert rules, no dashboard alert settings, and no
webhook, dead-man or email delivery. Those config keys are accepted and ignored
with a startup warning (only `[alerts] window_s`, the rollup window, is used), and
the dashboard hides its alert parts. Alerting is a separate module that reads the
rollups from SQLite or the HTTP API; until it exists, use the Python backup
collector for alerts (see [Quick start](#quick-start)).

**Rule:** latency- and performance-critical code (receiving datagrams, building
per-thread state and rollups, storage, the dashboard API) belongs in C++ or Rust.
Alerting, notifications, reports and richer dashboard data are separate programs
that read the SQLite files or the HTTP API. They must stay off the UDP stream and
out of the collector's main loop. A separate program that needs per-sample data
at high rates must itself be written in C++ or Rust.

`make check` runs an end-to-end test of the C++ collector, plus a parity test
that sends identical datagrams to both collectors and requires identical rollups.

To compare them live on real data:

```sh
scripts/compare.py --rate-hz 10 --target-process firefox
```

This starts a sampler, a UDP tee and both collectors, and shows CPU, memory,
dashboard latency and whether they agree on threads and states. Both dashboards
stay available (Python on port 9511, C++ on 9512). The comparison configs leave
out alert delivery, so the Python collector's alerts are not sent anywhere. Files
go to `.run/compare/`. `--duration 180` stops after three minutes and prints a
summary table; `--synthetic-threads 1000` replaces the sampler with a load
generator. Results are in [docs/collector-comparison.md](docs/collector-comparison.md).

## Layout

- `sampler/`: C++ sampler (`main.cpp` loop, plus headers for config, `/proc`
  parsing and cache, wire encoding, RAII resources).
- `collector/`: C++ core collector, the default, without alerting (shares the
  sampler's wire-format header). [collector/README.md](collector/README.md) lists
  what it does.
- `triangulator/`: Python backup collector with alerts and delivery, and the
  dashboard page both collectors serve.
- `config/`, `deploy/`: example configuration and systemd units.
- `scripts/`: `start.sh`, `stop.sh` and `compare.py` (Python vs C++ collector).
- `tests/`: C++ and Python tests, including a real `/proc` integration check.
