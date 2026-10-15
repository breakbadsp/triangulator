# Alerting (not wired up)

This is the alerting code from the retired Python collector, kept as the start
of the separate alerting module. **It does not run**: nothing imports it
outside the tests, and the collector (`collector/`) has no alerting. Until the
module is finished, nothing sends alerts.

The module must follow the rule in `../AGENTS.md`: it never reads the UDP
stream and never runs inside the collector. It reads the collector's rollups
from the SQLite day files (read-only) or the HTTP API (`/api/live`,
`/api/history`).

## What is here

| File | Contents |
|---|---|
| `settings.py` | The rule list (`RULES`), defaults, validation of `[alerts]` thresholds and delivery destinations, and dashboard overrides saved to `alert-settings.json` |
| `engine.py` | `AlertEngine`: opens an alert after `sustain_windows` bad reports in a row (or at once for immediate rules), resolves after `resolve_windows` good ones, sends reminders every `reminder_secs`, resolves a thread's alerts when it goes away, and restores open alerts after a restart without sending them again |
| `log.py` | `AlertLog`: alert events in an `alert_event` table, one SQLite file per UTC day (same table as the collector's day files). Point it at its own directory: the collector's files are read-only for other programs |
| `delivery.py` | `Delivery`: a bounded queue and a worker thread that posts each event to `webhook_url` and/or emails it (`[alerts.smtp]`), with three tries per channel, plus a `deadman_url` ping every minute |

The settings are in the `[alerts]` table of `collector.toml` (and `deadman_url`
at the top level); the collector ignores them apart from `window_s`.
`tests/test_alerting.py` covers all four files.

## What is missing

- **The rule checks.** They were part of the Python collector's engine and
  worked on raw samples, so they were removed with it. Each must be rebuilt on
  rollups or `/api/live`. Their conditions are listed below.
- **A main program** that loads the config, polls the collector, runs the
  checks through `AlertEngine` and hands events to `Delivery`.
- **The dashboard settings API** (`GET`/`POST /api/alert-settings`). The page
  still has the alert sections and settings form; it shows them when
  `/api/live` has `alerts` fields. The Python collector checked that writes had
  a JSON body, an `X-Triangulator: 1` header, and an allowed `Host`
  (`http_allowed_hosts`) and `Origin`.

To see the removed code: `git log --diff-filter=D -- triangulator/engine.py`
gives the commit that deleted it; its parent has the whole Python collector.

## Rule conditions in the Python collector

Thread rules (key: rule, group, tid):

- **`cpu_warn`, `cpu_critical`** (immediate; severity warning / critical):
  CPU measured at each sample against the newest sample at least one second
  older. Opens once CPU has stayed above `cpu_warn_pct` / `cpu_crit_pct` for
  `cpu_sustain_secs`, measured from the first sample that read above it.
  Resolves once below for the same time. A sampling gap (over 1.5 intervals)
  or a changed threshold starts the timing again. Rollups only have 5–10 s
  windows, so this rule needs a new design (per-window CPU, or `cpu_pct` in
  `/api/live`, which covers the last ten seconds).
- **`starved`** (per valid rollup window; `sustain_windows` to open,
  `resolve_windows` to resolve): `run_delay_pct` above `starve_run_delay_pct`.
  In status-fallback mode, where there is no run delay: more than half of the
  window's samples in state `R`, CPU under 10% and the run-delay counter
  increased.
- **`kernel_wait`** (per window): every sample in state `D`, with no sampling
  gaps. Opens at once when that has lasted longer than `kernel_wait_secs`;
  resolves after `resolve_windows` windows that are not all `D`.

An invalid window, a sampling gap or sampler silence restarts the `starved`
and `kernel_wait` counts. A thread's alerts resolve when it exits, its counters
reset, its group changes or the session changes.

Monitor rules (group `monitor`, tid 0; all immediate, checked every 0.5 s):

- **`sampler_silent`**: no datagram for `sampler_silent_secs`.
- **`target_absent`**: the sampler has reported the target absent for
  `target_absent_secs` (and is not silent).
- **`packet_loss`**: estimated loss over the last minute above
  `packet_loss_pct` (`health.packet_loss_pct` in `/api/live`).
- **`access_lost`**: more than half of the threads have a hidden wait channel
  (state `no_access`), and the sampler is not silent.

Ordinary waits (futex, socket, poll, pipe) never alert.
