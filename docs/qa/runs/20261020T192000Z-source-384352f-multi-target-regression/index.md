# Multi-target regression QA on master 384352f

UTC run: 2026-10-20, 19:20–19:45. Scope: the quick regression cases on top of the
sanity run [20261020T191300Z](../20261020T191300Z-source-384352f-multi-target/index.md).
Results for cases that ran in full: 3 PASSED (QA-032, QA-033, QA-047), 1 FAILED
(QA-004). Cases with partial checks are NOT_RUN in the case table. This is a basic
regression, not a thorough run.

## Product identity

Source build of `origin/master` at `384352f`. No release package. No checksum claim.
Build: `make` and `make check` passed in the earlier sanity run.

## Environment and changes to the isolated runtime

`TRIANGULATOR_HOME=/tmp/tri-qa/home`, UDP 19400, HTTP 19401. The user's `~/triangulator`
was not touched.

- `collector.toml`: added `[[watch]]` MsgP `wake_ms = 1000` and PrdDist `wake_ms = 2000`.
  [Config](evidence/collector-regression.toml).
- `sampler.toml`: `rate_hz` 10. `cpu_budget_pct` raised from 1.0 to 2.0 for the 10 Hz
  precondition only (see Deviations). [Config](evidence/sampler-regression.toml).
- Fixture: the PR #83 named-thread fixture, copied from the PR #83 run and writing its
  counters to `/tmp/tri-qa`. [Source](evidence/qa032-033-fixture.py).

## Results

| Case | Result | Notes |
| --- | --- | --- |
| QA-004 | FAILED | Named target accepted, absent, then live and absent again. Main view does not identify the new process until **Show live** (ISS-4, ISS-8). |
| QA-032 | PASSED | At 10 Hz and 100 ms interval. Both `MsgP` threads 1 s, both `PrdDist` 2 s, control null, source config. ISS-6 observed. |
| QA-033 | PASSED | `MsgP-fast` stopped: same TID, `wake_ms` 1000, `stale` false, futex wait, `last_ran` fixed, peers advance. |
| QA-047 | PASSED | Two independent tabs, same PID, both live and advancing after 10 s. |

Partial checks (NOT_RUN in the case table):

- QA-007: static check. All 52 `data-help` keys have a topic. The browser hover sweep was not run.
- QA-028: steps 1 and 2 only. Command, executable, cwd, parent, UID/GID, CPUs, and start time match `/proc` and `ps`. Browser labels and steps 3 to 7 not run.
- QA-029: Summary shows RSS and VmSize charts. Time-window switching not verified in this run. Step 5 not run.
- QA-036: validation rules checked through the API (all documented limits, 400 messages, 409 stale revision, 428 missing If-Match, 403 without the dashboard header, reset). Browser editor steps 2 to 11 not run.
- QA-037: not run.

Evidence: [watch validation](evidence/watch-rule-validation.txt),
[QA-004](evidence/qa004-named-target.txt), [QA-032 intervals](evidence/qa032-watch-intervals.txt),
[QA-033 stopped views](evidence/qa033-stopped-views.txt),
[QA-028 process details](evidence/qa028-process-details.txt),
[sampler overhead](evidence/sampler-overhead.txt).

## Deviations

- QA-032 requires 10 Hz. At the default 1% budget the sampler throttled to 5.94 Hz
  (designed behavior, `throttle_reason` "Sampler CPU use exceeded its configured budget").
  The run raised the budget to 2.0% in the isolated runtime only. This is a test setup
  change, not a product change.
- QA-033 expects no watch-specific dashboard warning. The Assessment now warns, and
  the Monitor shows the stall (ISS-5).
- QA-033 browser row check used the earlier fixture instance with the same behavior. The API
  checks used the current instance.

## Issues

Severity scale: **Blocker** stops the product or loses data. **Major** breaks a
documented expected result. **Minor** is a wrong or confusing behavior with a workaround.
**Low** is documentation, wording, or an observation for the owner.

- **ISS-4 (Minor): Absent target shows the previous process as stopped.** Set the
  `cpu` target to the absent name `qa-named`. The header reads "absent", but the main
  view shows the old process as "Stopped reporting ... it exited or is no longer the target"
  with its final view. That process was still running (PID 4093998). Expected: the
  dashboard reports the target as absent (QA-004 step 2).
- **ISS-8 (Minor): New named process is not shown until the user acts.** After
  `qa-named` started (PID 4114070), the banner said "A new process (PID 4114070) is being
  monitored", but the main view stayed on the old final view until **Show live** was
  pressed. QA-004 expects the dashboard to identify the process and show threads.
  The owner should decide whether this is intended.
- **ISS-6 (Low, observation): Collector `last_ran` skips about one 1 s wake in three.**
  The fixture wakes every second (12 wakes in 12 s). Collector `last_ran` values advance
  by 2 s on some polls. The largest observed elapsed value, 1.72 s, is inside the
  QA-032 tolerance. Owner to check whether wake detection misses some sleeps.
- **ISS-7 (Low): CLI success message names the wrong key.** `scripts/set-target.sh cpu qa-named`
  prints `Updated ...: target_process = "qa-named"`, and `set-target.sh default <PID>`
  prints `target_pid = ...`. Both edit `[[target]]` tables, not the legacy keys.
- **ISS-5 (Low): QA-033 expected text is out of date.** The case says watch warnings are
  outside PR #83. The current dashboard warns "TID ... is set to wake at least every
  1000 ms, but it has not run for 31 s". The warning is useful. The case should change.
- **Observation (not an issue): Sampler cost scales with rate.** 0.79% at 5 Hz, 0.97%
  at 5.94 Hz (throttled), and 1.44% at 10 Hz with two targets. The default 1% budget
  throttles 10 Hz on a 7-thread target. See [overhead](evidence/sampler-overhead.txt).

Carried from the sanity run: ISS-1 (Minor), ISS-2 (Low), ISS-3 (Low, unconfirmed).

No blocker or major issue found. One Minor failure (QA-004) is listed above.

## Issue follow-up

Status on 2026-10-21. The results above stay as recorded for `384352f`.

- ISS-4 and ISS-8: intended behavior. A selector change made outside the tab
  keeps the final view until **Show live**
  ([final view](../../../collector-reference.md#final-view-after-the-target-exits)).
  QA-004 revision 2 (PR #123) expects this. Retest QA-004.
- ISS-5: fixed in PR #123. QA-033 revision 2 expects the watch warning.
- ISS-6: not a defect. `last_ran` is the time of the sample that saw the wake,
  and the collector processes a tick after a drain grace of
  max(0.25 s, 2 × sample interval), 0.4 s at 5 Hz. With 1 s polls, the
  elapsed value for a 1 s wake can reach about 1.7 s.
- ISS-7: fixed in PR #123. `set-target.sh` names the `[[target]]` entry it wrote.
