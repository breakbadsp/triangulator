# PR #83 named-worker browser QA

UTC run: 2026-10-14, 17:25:25–17:30:48. Scope: the requested `MsgP*`
1-second and `PrdDist*` 2-second examples, plus stopped wakeups and an unmatched
control. Results: 2 PASSED, 0 FAILED, 0 BLOCKED, 0 NOT_RUN in this scope.
Screenshot and video capture were blocked. Browser text and API observations
were saved. Other manual cases were excluded from this focused request.

## Product identity

The user requested browser verification in the PR #83 review context.
This run tests the PR source build, not a release package.

- Source: <https://github.com/breakbadsp/triangulator/pull/83>.
- Revision: `c454915af4a8046cfdf6ec1e390dde355b911424`.
- Tested package version label: `PR83 c454915 (source)`.
- Package filename and published checksum: not applicable. No release package
  was acquired. No package checksum verification is claimed.
- Collector binary SHA-256:
  `07c43daadcf527de539cd6cc16bfff06cc53d336214a3d347db3765735224444`.
- Sampler binary SHA-256:
  `1fda45985e5ea1b2188f958b339aba991d21266bb4e1100df5d009b83af67739`.
- Both binaries came from `/home/daksh/src/triangulator-pr83/build` at this
  revision. The parent review had built these binaries and passed `make check`.
- Fixture: [fixture.py](evidence/fixture.py), created for this run. It uses real
  Linux threads, `prctl` names, timers, and an Event wait. It does not send
  synthetic collector packets.

## Environment and setup

Platform: Linux x86_64, kernel `7.2.5-3-omarchy`, user UID 1000.
Python fixture: `/usr/bin/python3.14`. T3 Code browser: Chromium
`152.0.7977.130`, Electron `44.4.2`, T3Code(Alpha) `0.0.45`.
Viewport: 1280 × 800 CSS pixels.
URL: `http://127.0.0.1:19401/`; final browser view: `#threads-section`.

Isolated runtime: `/tmp/triangulator-pr83-qa`. UDP: 19400. HTTP: 19401.
The fixture PID was 1269897; sampler PID 1269977; collector PID 1269934.
The [collector configuration](evidence/collector.toml) and
[sampler configuration](evidence/sampler.toml) use no saved override, 10 Hz
thread sampling, 1-second resource sampling, and disabled memory-map sampling.
The documented `scripts/start.sh collector` and `scripts/start.sh sampler`
commands used this isolated `TRIANGULATOR_HOME` and copied the PR binaries.

The first short shell launch ended its child processes after the tool call.
Initial navigation failed because the listener had stopped. A persistent shell
session restored the fixture and both programs before testing. The initial
5 Hz configuration was replaced with 10 Hz before the recorded observations.
Existing installations and user data were preserved.

## Results and observations

The watch cases use QA-032 and QA-033 after review. QA-030 and QA-031
identify the existing sampling-default and sanitizer cases.

| Case | Revision | Status | Evidence |
| --- | --- | --- | --- |
| QA-032 | 1 | PASSED | [Healthy browser](evidence/healthy-browser.json), [summary](evidence/summary.json), [proc](evidence/healthy-proc.json) |
| QA-033 | 1 | PASSED | [Stopped browser](evidence/stopped-browser.json), [All threads](evidence/all-threads-browser.json), [proc](evidence/stopped-proc.json) |

### QA-032

At 17:25:45 UTC, a browser GET returned the two configured rules with source
`config`. The browser displayed all five worker names and 0.0% worker CPU.
Monitor reported 100 ms, zero packet loss, zero bad packets, and zero late
packets. Nine browser GET observations ran from 17:26:00.616 to 17:26:08.638.
Every worker was asleep in each observed view. Wake activity still advanced
`last_ran`.

| Workers | wake_ms | First last_ran | Final last_ran | Maximum sampled elapsed |
| --- | --- | --- | --- | --- |
| MsgP-fast, MsgP-peer | 1000 | 1791998759.266805 | 1791998768.2667825 | 0.800 s |
| PrdDist-main, PrdDist-peer | 2000 | 1791998758.2668037 | 1791998768.2667825 | 1.800 s |
| Control-idle | null | 1791998759.266805 | 1791998768.2667825 | 0.800 s |

The GET `/api/watches` observation was inspected in the browser before the
saved healthy sequence. A [later browser GET](evidence/watches-browser.json)
also preserves the rules and source. The sequence preserves the `wake_ms`
values in every thread. The saved fixture counters and schedstat data support actual periodic
wakeups. Each MsgP counter was 50 at the healthy capture; each PrdDist counter
was 25. Schedstat timeslices were 63/73 for the MsgP threads and 30/31 for the
PrdDist threads. All worker CPU readings in the sequence were zero.

### QA-033

At 17:26:31 UTC, `SIGUSR1` requested that `MsgP-fast` stop its timer loop.
It completed one final timer wake, then blocked on an Event. The thread stayed
alive, with the same TID, `wake_ms = 1000`, `stale = false`, and
`wchan = futex_do_wait`. Browser observations from 17:26:41.874 to
17:26:53.885 kept `last_ran = 1791998792.2667212`. Elapsed time grew through
9.000, 12.000, 15.000, 18.000, and 21.000 seconds. Healthy peers continued
their timers and advanced `last_ran`. The fixture counter stayed at 74 and
schedstat timeslices stayed at 97 across the stopped capture and a
[later proc capture](evidence/stopped-proc-later.json).

Through browser controls, QA selected Threads and All 6. At 17:27:43 UTC,
the table showed `MsgP-fast`, TID 1269899, Futex wait, `futex_do_wait`,
and `idle for 61 s`. The Assessment still said Healthy and No problems
detected. PR #83 supplies collector watch data and APIs. Its dashboard does
not consume watch rules for warnings or provide settings controls. Therefore,
this expected UI limitation is not a failed collector case. This run does
not establish that a watch-specific dashboard warning works.

## Browser evidence limits

T3 preview navigation, read-only evaluation, and browser clicks worked.
`preview_snapshot` repeatedly returned `PreviewAutomationExecutionError`,
including with `includeImage = false`, `save = true`, the actual tab ID, and
after resize. [Snapshot error](evidence/snapshot-error.json) and
[final capture error](evidence/capture-final.json) preserve the responses.
Recording start timed out after 15000 ms. Tools then briefly reported
`PreviewAutomationNoAvailableHostError`. Opening the tab restored interaction,
but screenshot capture still failed. No screenshot or video was saved.
No DOM or application state was changed with evaluation scripts.

The [collector log](evidence/collector.log) and
[sampler log](evidence/sampler.log) are saved. The sampler could not read
`/dev/kmsg`; kernel exit diagnostics are outside this scope. Full browser
console and network diagnostic capture was unavailable with snapshots.
Successful browser GET responses and the rendered table were observed.

## Excluded scope and cleanup

Invalid rules, rule limits, saved override persistence, reset, longest-prefix
precedence, rename behavior, replay data, busy loops, status fallback, and
watch-specific dashboard warnings were not tested. Existing manual-case rows
were retained. No product code changed. Test-owned sampler, collector, and fixture processes were stopped after
validation. The browser retains the final Threads view.


## Validation of QA document changes

The QA branch starts from master. Its build is not the product tested above.
`make -j4` and `make -j4 check` passed. The Python suite ran 103 tests with
one privileged BPF test skipped. Sampler and collector allocation tests
reported zero allocations. `scripts/qa_summary.py --check` and
`git diff --check` passed. The README summary was refreshed.
