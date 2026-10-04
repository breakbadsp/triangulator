# Triangulator

Linux thread monitoring using `/proc`: a single-threaded C++23 sampler sends UDP to a
Python collector with a live dashboard, daily SQLite history and sustained alerts.
Implements [the v1 design](docs/thread-monitor-design.md).

## Build and run

Requires Linux, a C++23 compiler and standard library supporting `std::expected`,
`std::format` and `std::byteswap` (GCC/libstdc++ 13 or newer), Make and Python 3.11+.
No third-party packages. The build uses `CXX`, `CXXFLAGS`, `CPPFLAGS`, `LDFLAGS`
and `LDLIBS`; C++23 is selected explicitly for every C++ target.

```sh
make
make check
```

The sampler uses move-only RAII ownership for file descriptors, sockets and
directory handles; `std::expected` for configuration errors; `std::variant` for
target selection; and `std::chrono` for sampling deadlines. `/proc` parsers use
`std::string_view`, `std::from_chars` and `std::optional` without allocating.
Wire encoding uses fixed `std::array` buffers, bounded `std::span` views and
explicit little-endian conversion in the documented wire format (version 2).
The thread cache reserves its bounded capacity once and reuses descriptors across
ticks. At startup the sampler raises its soft open-file limit to the hard limit
and keeps four `/proc` files open per thread only while that budget allows (32
descriptors are reserved); further threads reopen their files every tick. Running
out of descriptors skips a tick instead of reporting the target absent.
Only the signal flags are shared with signal handlers; runtime state belongs to
the sampler object. POSIX calls remain at the Linux I/O and timing boundaries.

1. Copy `config/sampler.toml` and `config/collector.toml` to your deployment
   configuration directory. Set the target PID **or** exact process name, the
   collector's numeric management-network IP and the sampler's source IP.
2. Set collector `clock_ticks` to the output of `getconf CLK_TCK` **on the
   target host**. The wire header does not carry the clock frequency.
3. Configure a real webhook and/or SMTP destination in `[alerts]` and a writable
   `data_dir`. Webhooks receive a JSON event containing `ts`, `rule`, `group`,
   `tid`, `name`, `session`, `detail`, `severity` and `status`
   (`opened`, `reminder`, `resolved`). SMTP credentials come from the environment
   variable named by `password_env`; STARTTLS defaults to enabled.
4. Start the collector and then run the sampler as the target UID:

```sh
python3 -B -m triangulator /etc/triangulator/collector.toml --check-config
python3 -B -m triangulator /etc/triangulator/collector.toml
./build/triangulator-sampler /etc/triangulator/sampler.toml
```

Open `http://127.0.0.1:9401` on the collector host. The dashboard shows thread
groups, latest inferred state, a ten-second state mix, CPU usage, open/recent
alerts, monitor health and selectable per-thread rollup history. The HTTP listener
defaults to loopback; use an SSH tunnel or an authenticated reverse proxy for
remote access. Neither UDP nor the HTTP API provides authentication.

**Alert settings** (the dashboard's *Alert settings* button) turn each rule on or
off and change its thresholds: CPU warning/critical percentages and how long CPU
must stay above them, run delay, kernel-wait, sampler-silence and target-absence
durations, packet loss and the reminder interval. Changes apply immediately and
are saved to `alert-settings.json` in `data_dir`, layered over the collector TOML;
*Reset to config file* deletes that file. Turning a rule off resolves its open
alerts. The same ranges apply to TOML values, so for example `reminder_secs`
must be at least 60. Delivery destinations and window sizes stay in the TOML. Writes require a
JSON body with an `X-Triangulator: 1` header, refuse other origins, and accept only
IP-literal, `localhost` or `http_host` host names; list reverse-proxy names in
`http_allowed_hosts`. Anyone who can reach the dashboard can change alert
settings, so keep it on loopback or behind an authenticating proxy.

The sampler accepts flat `key = value` configuration with double-quoted strings,
booleans and `#` comments. Duplicate keys, unknown keys and malformed values are
rejected; configuration must be smaller than 16 KiB, with lines no longer than
1,023 bytes. It accepts numeric IPv4 or `[IPv6]:port` destinations;
it does not perform DNS lookups. `SIGHUP` reloads configuration atomically; invalid
configuration leaves the previous settings active. A successful reload begins a
new session, so a change in counter mode cannot corrupt deltas. `rate_hz` accepts
0.2–10. The collector reads full TOML at startup; restart it after configuration
changes.

## Production setup

Review and customize the example units in `deploy/` before installation. They
are templates, with placeholder target user and collector IP. Install the sampler
binary under `/usr/local/bin`, the Python `triangulator/` directory under
`/opt/triangulator`, and configuration under `/etc/triangulator`. Keep all sampler
code/configuration root-owned and non-writable by the target UID. The collector
unit creates `/var/lib/triangulator` using `StateDirectory`.

The sampler unit sets niceness 19, a 5% CPU quota, 32 MiB memory limit, a
descriptor limit sufficient for the wire-format thread limit, read-only system
access, no capabilities, syscall restrictions and an outbound IP allowlist.
Tune the quota after
measuring the real thread count and sampling rate; overruns skip deadlines.
The sampler creates no listening socket, sends no signals to the target, and
does not write files. Runtime messages go to stderr, captured by journald in the
unit, with a one-minute warning rate limit.

Before deployment, perform the staging/host checks in design section 12:

- Run the sampler as the target UID. It needs no capabilities: `stat`,
  `schedstat`, `io` and `wchan` are readable by the same user under any Yama
  `ptrace_scope`. The sampler warns if every sleeping thread's wait
  channel reads as hidden.
- Verify scheduler statistics under load. If unavailable or unusably zero,
  explicitly set sampler `status_fallback = true`. Zeros alone cannot reliably
  distinguish an idle process from disabled accounting, so this is an operator
  choice. Fallback counters are identified in each packet.
- Confirm that thread prefixes fit the 15-byte Linux thread-name limit, and check
  the wait-channel names your kernel reports (`cat /proc/PID/task/*/wchan`);
  names the collector does not recognise show as `other` with the raw name.
- Restrict UDP by firewall or WireGuard and route it on the management network.
  Set `sampler_ip`; if omitted, the collector pins the first valid sender IP.
- Test the alert destination, disk budget and optional `deadman_url`.

These repository checks cannot validate production kernel wait-channel names,
network routing or the performance budget on your target host.

## Data and alert behavior

- The 48-byte header and 112-byte records (wire version 2) are encoded explicitly
  little-endian. A datagram contains at most 10 threads (1,168 bytes). The 8-bit
  chunk count limits a tick to 2,550 threads; excess threads are omitted with a
  warning.
- Chunks are deduplicated and reordered for up to two sample intervals, capped
  at two seconds. Partial ticks remain useful. Later arrivals are counted as
  late; missing chunks never imply a thread exit. A complete tick can establish
  an exit. Threads not seen for `max(10 seconds, 3 intervals)` expire even if
  ticks remain incomplete. Exit resolution events identify this uncertainty.
- Packet loss estimates missing chunks plus sequence gaps over the last minute.
  The expected chunk count for a completely missing tick is estimated from the
  next received tick, so changing thread counts can affect the estimate.
- CPU and scheduler deltas use sampler monotonic time, not network arrival time.
  Counter regressions, sampler sessions and counter-mode changes reset baselines.
  Collector `clock_ticks` must match the target. Wall clocks should be synchronized
  for history; offsets over one day fall back to collector arrival time.
- CPU alerts are checked at every sample. CPU is measured over the trailing
  second, and an alert opens once a thread stays above `cpu_warn_pct` or
  `cpu_crit_pct` continuously for `cpu_sustain_secs` (default 5), counted from
  the first sample that measured it above. A burst shorter than that never
  alerts; a real one is reported up to about a second later. It resolves after
  the same duration below the threshold. A sampling gap or a threshold change
  restarts the duration.
- Starvation uses configurable 5–10 second windows with at least half the
  expected samples, three qualifying windows to open and two clear windows to
  resolve. Kernel-wait (`D`) alerts use a duration threshold. Sampling gaps break
  continuous-wait evidence.
- Waits never alert: futex (lock or condition), socket, poll and pipe waits are
  shown on the dashboard as block types with their wait channel, and can be
  filtered there.
- Raw live samples expire after ten minutes and are additionally capped by
  `max_live_samples` (default one million, shortened per-thread retention when
  needed). A disappeared thread is removed from live memory; its persisted
  rollups remain available. History is keyed by session and TID, with a generation
  column distinguishing detected TID reuse.
- SQLite uses UTC day files in WAL mode. Rollups include state sample counts,
  coverage/validity, CPU, run delay, timeslice deltas, read/write byte rates and
  major-fault deltas. Day files written by earlier versions gain the new columns
  when opened. With fallback counters,
  run-delay percentage is unavailable and timeslices mean voluntary switches.
  `no_access` is preserved as its own count. `store_raw` additionally persists
  decoded records. Data is committed every half second. Retention removes whole
  day files (including WAL/SHM sidecars), keeping today and the preceding
  `retention_days - 1` days.
- Open and recent alerts are restored from retained SQLite files on collector
  restart. Sample windows start fresh; thread alerts reconcile when data resumes.
- Alert delivery runs outside the UDP loop, retries each channel three times,
  and uses a bounded queue. Delivery failures/dropped notifications appear in
  monitor diagnostics; alert events remain in SQLite. Reminders default to
  30 minutes. This is best-effort delivery, not a durable notification outbox.
  Configure the external dead-man endpoint to alert if the collector stops.

Read-only APIs: `/api/live` and
`/api/history?session=SESSION&tid=TID&start=UNIX_SECONDS&end=UNIX_SECONDS`.
History returns at most 2,000 rollups; narrow the interval if `truncated` is true.
Existing daily SQLite files can also be queried directly for historical sessions
and alert events.

## Layout

- `sampler/main.cpp`: sampling loop, absolute deadlines, UDP sending and reload.
- `sampler/io.hpp`, `config.hpp`, `parsing.hpp`, `proc.hpp`, `protocol.hpp`:
  RAII resources, typed configuration, `/proc` parsing/cache and wire encoding.
- `triangulator/`: protocol, collector, interpretation, alerts, SQLite, delivery,
  HTTP API and dashboard.
- `config/`, `deploy/`: configuration and systemd examples.
- `tests/`: C++ parser/resource/wire tests and Python protocol, alert,
  loss/reordering, retention and real `/proc` integration checks.
