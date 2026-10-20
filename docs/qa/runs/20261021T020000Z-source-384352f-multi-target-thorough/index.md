# Multi-target thorough QA on master 384352f

UTC run: 2026-10-20, 19:45–20:30. Scope: the multi-target cases that run on one host
(QA-058 to QA-072). Results: 3 PASSED (QA-059, QA-065, QA-072), 2 FAILED
(QA-060, QA-071), 1 BLOCKED (QA-066), and the rest NOT_RUN with a reason below.

## Product identity

Source build of `origin/master` at `384352f`. No release package. No checksum claim.

## Environment

Isolated runtime: `TRIANGULATOR_HOME=/tmp/tri-qa/home`, UDP 19400, HTTP 19401.
Owned fixtures: `bug-lab/bugbench.c` (healthy, cpu-spin, close-wait), and the
healthy-named fixtures. The user's `~/triangulator` was not touched.
The collector and sampler were restarted several times during this pass; see ISS-12.

Config changes in the isolated runtime (not product changes): `max_targets` 2 and
`target_idle_expiry_s` 60 for QA-072; `cpu_budget_pct` 0.1 for QA-060; `rate_hz` 5.

## Results

| Case | Result | Notes |
| --- | --- | --- |
| QA-058 | NOT_RUN | Steps 1, 2, 3, and 5 checked (per-target API and history isolation, unknown key 404). Step 4 not isolated. |
| QA-059 | PASSED | Add, reorder, rate change, invalid and duplicate IDs, stopped target. One sampler process. |
| QA-060 | FAILED | Budget throttle works. Recovery does not happen at 0.1% budget (ISS-15). |
| QA-061 | NOT_RUN | Per-tab UI not run. |
| QA-062 | NOT_RUN | Only the confirm dialog and add were run in the UI (earlier pass). Duplicate, invalid, and stale UI cases not run. |
| QA-063 | NOT_RUN | Needs a limited-access target (another user's process). |
| QA-064 | NOT_RUN | Per-target watch settings not run. |
| QA-065 | PASSED | Commands, reload, invalid and duplicate IDs, last-target refusal, `--help`. |
| QA-066 | BLOCKED | Needs two sampler hosts with observers. Not available on this host. |
| QA-067 | NOT_RUN | Needs an older build and a 10-minute soak. |
| QA-068 | NOT_RUN | Needs an older sampler build. |
| QA-069 | NOT_RUN | Partly covered by QA-002, QA-003, QA-059, and QA-065. Non-loopback steps not run. |
| QA-070 | NOT_RUN | Config checks passed (evidence). Earlier configs, start and stop scripts, and SIGHUP invalid table not run. |
| QA-071 | FAILED | Step 6: a removed target's data requests return 200 until the idle expiry, not 404 (ISS-14). |
| QA-072 | PASSED | Rename releases the old slot after about 75 s. 30 s and 90 s pauses return every target to live. |

Evidence: [QA-059 and QA-065](evidence/qa059-065-target-commands.txt),
[QA-060](evidence/qa060-budget.txt), [QA-070](evidence/qa070-config-checks.txt),
[QA-071](evidence/qa071-removed-target.txt), [QA-072 timeline](evidence/qa072-clean-timeline.txt)
and [script](evidence/qa072-script.sh), [collector restart](evidence/collector-restart-binding.txt).

### QA-072 detail

- First attempt is invalid: the fixtures started at 00:43 with a 3600 s limit and exited near
  01:43, during step 2. Those "absent" results are not evidence. The clean run used new 3000 s fixtures.
- Clean run: `b` silent at 51:49, its slot released, `c` live at 52:49.
- 30 s pause: silent by 54:20, live again at 54:50 after `SIGCONT` at 54:35.
- 90 s pause: silent by 55:50, slots released by 56:35 (no targets listed), live again at 57:20.

## Deviations

- QA-060 budget and rate were changed in the isolated runtime only.
- QA-071 step 6 expects 404. The design text says a removed slot stays until expiry. The
  setup text says only targets removed outside local control stay listed. Owner to decide which text is correct.

## Issues

Severity scale: **Blocker** stops the product or loses data. **Major** breaks a
documented expected result. **Minor** is a wrong or confusing behavior with a workaround.
**Low** is documentation, wording, or an observation for the owner.

- **ISS-12 (Major): Collector-only restart leaves a target silent under another target's PID.**
  Reproduced three times, with `max_targets` 8 and 2. After `scripts/restart.sh` (collector only)
  while the sampler runs: `omarchy/default` is listed silent with PID 4093998 (the PID of
  target `b`), and `b` is not listed. `/api/live?target=omarchy/default` reports PID 4093996
  (the process the sampler actually samples). Datagrams keep arriving. A sampler restart
  (`scripts/restart.sh sampler`) restores both targets live. Expected: the collector rebinds
  both targets after its own restart (QA-068 step 3). See [evidence](evidence/collector-restart-binding.txt).
- **ISS-14 (Minor): Locally removed target still serves data for up to idle expiry.**
  After `--remove`, `/api/targets` keeps the key as silent, and live, resources, and replay
  return 200 with the old data. QA-071 expects 404. The design and setup docs disagree on
  whether local removal should drop the slot at once. Owner to pick the rule and update the other doc.
- **ISS-15 (Minor): Budget recovery never happens at a low budget.** At
  `cpu_budget_pct` 0.1 the sampler stays at 4.07 Hz, throttled, for more than 5 min after the
  load stops. The rise rule needs CPU below 0.6 × budget (0.06%), but this sampler's
  idle CPU is 0.069–0.076%. At the default 1% budget the threshold is 0.6%, so the rule
  works there. Owner: decide whether a floor-aware threshold is needed.
- **ISS-16 (Low): `/api/targets` pid differs from `/api/live` process pid.** Part of the ISS-12
  state. `/api/targets` reports PID 4093998, the configured PID of target `b`. `/api/live`
  reports PID 4093996, the process the sampler samples under `default`. The two responses
  should agree.

Carried from earlier runs: ISS-1 (Minor), ISS-2 (Low), ISS-3 (Low, unconfirmed), ISS-4 (Minor),
ISS-5 (Low), ISS-6 (Low), ISS-7 (Low), ISS-8 (Minor), ISS-9 (Low, test artifact), ISS-10 (Low),
ISS-11 (Low).

One Major issue (ISS-12) and two Minor failures (QA-060, QA-071) are open from this run.
