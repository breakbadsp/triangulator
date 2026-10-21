# Multi-target sanity QA on master 384352f

UTC run: 2026-10-20, 19:13–19:50. Scope: Sanity tier (QA-001, QA-002, QA-003,
QA-005) on the merged multi-target change. Results: 4 PASSED, 0 FAILED,
0 BLOCKED, 0 NOT_RUN in this scope. Issues below include severities.

## Product identity

This run tests the source of `origin/master` at `384352f`, built from source.
No release package was acquired. No package checksum verification is claimed.

- Revision: `384352f` (PR #120, which follows PR #114 multi-target settings).
- Tested package version label: `source 384352f`.
- Build: `make` (GCC 16.2.1, `-Werror`), then `make check`: 167 Python tests
  ran, 1 skipped, all others OK.
- Collector and sampler are static builds from `build/`.

## Environment and setup

Platform: Linux x86_64, kernel `7.2.8-9-omarchy`, user UID 1000.
Browser: T3 preview tab, viewport 1280 × 800.
Isolated runtime: `TRIANGULATOR_HOME=/tmp/tri-qa/home`. UDP 19400, HTTP 19401.
The user's own `~/triangulator` instance (ports 9400/9401) was not touched.

- Setup: [collector.toml](evidence/collector.toml) and
  [sampler-after-add.toml](evidence/sampler-after-add.toml). They were
  created from the templates with only isolated ports changed.
- Start: `scripts/start.sh` from the checkout with `TRIANGULATOR_HOME` set.
- Owned fixtures: `bug-lab/bugbench.c` built with `gcc -O2 -pthread`.
  `healthy` (PID 4093996, target `default`) and `cpu-spin` (PID 4093998,
  target `cpu`).

## Results

| Case | Result | Notes |
| --- | --- | --- |
| QA-001 | PASSED | Live summary and Threads for `default`. Log and API show no errors. |
| QA-002 | PASSED | Second target added by PID through Manage targets. Reload keeps `omarchy/cpu`. |
| QA-003 | PASSED | Empty fields rejected by the form. Nonexistent PID rejected with a server message. Target unchanged. |
| QA-005 | PASSED | Drawer, replay, return to live all work. One unconfirmed drawer observation (ISS-3). |

Evidence: [API targets](evidence/qa001-002-api-targets.txt) and
[browser observations](evidence/browser-observations.txt).

Sampler overhead with two live targets: `sampler_cpu_pct` 0.84 and 0.86, below
the 1% budget (`effective_rate_hz` 5.0, `throttled` false). Collector:
`bad_packets` 0, `capacity_drops` 0.

## Deviations from the case text

- QA-001 names a release package and the packaged scripts. This run used the
  checkout build and `scripts/start.sh` (see ISS-2).
- QA-001 asks for the browser diagnostics. Console output was not captured
  in this run, only the page state and log files.
- QA-002 and QA-003 say **Change target** and **Monitor**. The UI has
  **Manage targets**, **Add target**, and a browser confirm. The same flow was run.

## Issues

Severity scale: **Blocker** stops the product or loses data. **Major** breaks a
documented expected result. **Minor** is a wrong or confusing behavior with a
workaround. **Low** is documentation or wording drift.

- **ISS-1 (Minor): Invalid PID shows the confirm before validation.**
  Repro: Manage targets > ID `ghost`, target `999999` > Add target. The browser
  asks "Add ghost? This changes monitoring for every viewer." before the server
  rejects the PID with "no running process with PID 999999". Accepting the
  confirm is harmless, because no config change happens. Expected: reject the
  invalid input before asking to confirm. Affects QA-003.
- **ISS-2 (Low): Case text names controls that no longer exist.** QA-002,
  QA-003, and QA-004 name **Change target** and **Monitor**. The help topic
  `target` (`collector/dashboard.html`, line 1001) lists "Change target" as a
  related item, but no such control or topic exists. Expected: update the case
  text and the related item to the current controls (Manage targets, Add target).
- **ISS-3 (Low, unconfirmed): Drawer may lag replay time once.** Opened a
  thread drawer in live mode, then pressed Previous with banner 12:46:01 AM. The
  drawer showed "Last sample 12:46:13 AM" once. A second attempt showed the
  replay time (12:47:16 AM with banner 12:47:17 AM). Retest in regression.

No blocker or major issue found in the sanity scope.

## Issue follow-up

Status on 2026-10-21. The results above stay as recorded for `384352f`.

- ISS-1: fixed in PR #123. Manage targets asks the server to check an add
  (`"check": true`) before the confirmation.
- ISS-2: fixed in PR #123. QA-002, QA-003, and QA-004 (revision 2) use Manage
  targets and Add target. "Change target" stays only as a help search alias.
- ISS-3: still unconfirmed. Retest the QA-005 replay drawer (see `TODO.md`).
