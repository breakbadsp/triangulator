# Minimal overview: corrected build

This run tests the earlier compact face with visible verdict and worst-finding text. A later user request removed those fields and changed the dot to the assessment color. This record does not establish readiness for that later design. Its current-result rows were not applied.

- UTC: 2026-10-23 03:34:03 to 03:36:15. Scope: QA-082 through QA-090 and affected invalid-target input. This is a feature regression run, not the Full release tier.
- Source: authorized local branch `fleet/minimal-tiles`, base `117f17ae80f2174baa0ba04495152f0c27c54ec3`, with the requested local changes. Dashboard diff SHA-256: `858a8c95964000f38d10368c492e2b3c54943816754e6e4b92ad7b3e5580d31e`.
- Tested version: `source minimal-tiles 4a4871cc`. File: `build/triangulator-collector`. SHA-256: `4a4871ccd8105c6230556605854a74171e214c93d6d9a9a53268ecb6a3e81a99`. Dashboard source SHA-256: `ac676fe1ce46c9fce9f165d68bf511f448bd9cc7339ce9bcaf04513219bca456`.
- Platform: Linux x86_64. Browser: T3 Chrome 154.0.0.0. Viewports: 1280×900, 390×900, 320×900. Themes: Dark, Light, System.
- Installation: source binary with isolated `TRIANGULATOR_HOME=/tmp/tri-minimal-qa/home`, data `/tmp/tri-minimal-qa/data`, UDP 19780, collector HTTP 19781, control proxy HTTP 19782. Application URL: `http://127.0.0.1:19782/`.
- No published package or published checksum applies to this authorized source test. No new sampler ran. The existing collector and sampler were preserved.
- Definitions: existing unnumbered cases. QA-082 and QA-087 use the updated compact-tile definitions in this branch. No definition was changed by this run.
- Evidence: [compact browser observations](evidence/observations.json), [UDP fixture](evidence/wire.py), [control fixture](evidence/control-proxy.py). Earlier failures remain in the [first-attempt record](../20261023T032533Z-source-minimal-tiles/index.md).

| Case | Status | Observation |
| --- | --- | --- |
| QA-003 | PASSED | Empty process input remained invalid; PID 2147483646 showed `no running process with PID 2147483646` before confirmation. The isolated configuration did not change. |
| QA-082 | PASSED | Six targets showed name, verdict, host and ID, and only the worst issue title or no-live-view text. Healthy tiles had no summary. Metrics and access/throttle badges stayed in the target dashboard. Identical names had distinct identities and routes. |
| QA-083 | PASSED | Critical, serious, warning, healthy, and no-data levels used red, orange, amber, green, and gray. Counts, title prefix, and worst-first/key order agreed. |
| QA-084 | BLOCKED | Click, Enter, All targets, and empty `?target=` worked. T3 did not expose a new tab after middle-click or navigate history after Alt+Left. Those two expectations remain unverified. |
| QA-085 | PASSED | The empty fixture showed No targets yet. Stopping the owned collector showed the stale-data banner and retained six tiles. Restart restored the tiles and cleared the banner. |
| QA-086 | BLOCKED | Opening another T3 tab left `document.hidden=false`. True hidden-tab polling and resume timing could not be tested with this browser interface. |
| QA-087 | PASSED | All three themes passed at all three widths. Gap was 24 px; Add target height was 140 px. Dark tiles were rgb(18,18,20). Long identities wrapped. Finding titles used at most two lines. Scroll width equaled viewport width. |
| QA-088 | PASSED | Target links and Remove kept visible 2 px focus after two polls. Enter opened the target. Both help topics opened and stated the trend-rule limit. Tile help described the compact face and process details on hover or in the dashboard. |
| QA-089 | BLOCKED | The source-backed control fixture showed 20 choices for 22 matching processes with PID, user, start age and command. Choice 2 filled its PID and the restart warning. Confirm saved that PID in isolated TOML; reopening and local errors hid choices. Actual sampler reload and monitoring persistence were not exercised. |
| QA-090 | PASSED | A problem tile showed PID, start age, command and finding details after the delay. Healthy tiles had no card. Rapid movement showed no immediate card. Focus retained the card through polls; selecting the link opened the dashboard. |

Result: 7 PASSED, 3 BLOCKED, 0 FAILED, 0 NOT_RUN for this scope. Corrected help and responsive behavior were checked on the final artifact. Unchanged control, navigation, severity, and outage observations from artifact `a3ff1cbf` were retained; the final artifact changed only the guide text after that build.

The actual collector consumed synthetic TTGT, TMON, and TPIN datagrams. The source-backed proxy called `sampler_control.change_target_set` and persisted a test TOML file. It did not signal a sampler. It supplied an explicit no-view 404, a packet-loss warning, and the empty target-list state. Add/remove confirmation and focus behavior therefore have browser evidence, but live sampler control remains outside the verified scope.

Expected diagnostics were 404 for the no-data fixture, 400 for invalid or ambiguous target input, and 503 during the collector outage. No blocking script exception was observed. One startup attempt overlapped a collector relink and returned Permission denied; startup succeeded after the parent reported the build complete. This was a test coordination error. The call target was exceeded for the two corrected builds, the theme/width matrix, and browser capability checks.

Excluded: unrelated release cases, new sampler execution, recorded replay, sampler overhead, and real sampler configuration persistence. This record establishes readiness only for the executed overview UI scope. Test-owned processes were stopped after recording the run.
