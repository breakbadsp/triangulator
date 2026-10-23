# Square tiles with one assessment dot

- UTC: 2026-10-23 03:40:16 to 03:43:15. Scope: QA-082 through QA-090 and QA-003 invalid-target regression. This is a feature regression run, not Full release testing.
- Source: authorized local build on `fleet/minimal-tiles`, base `117f17ae80f2174baa0ba04495152f0c27c54ec3`. Dashboard diff SHA-256: `8c3c8a350ae6f4e5c2ca4f64ea8fc1e7f4e27f8c48c76370b6da6f5630f6787c`.
- Tested version: `source square-dot 83dcb99d`. File: `build/triangulator-collector`. SHA-256: `83dcb99dc2ad841d6cc8e15fd438946174a9982ab5b801f6a26d7f76e04ed04a`. Dashboard source SHA-256: `44b8bd5409f72352e564e104ad10807f40c6208f2d9b59a9cdbf8b7ed0ee74fe`.
- Platform: Linux x86_64. Browser: T3 Chrome 154.0.0.0. Viewports: 1280×900, 390×900, 320×900. Themes: Dark, Light, System.
- Environment: isolated home `/tmp/tri-minimal-qa/home`, data `/tmp/tri-minimal-qa/data`, UDP 19780, collector HTTP 19781, source-backed control proxy HTTP 19782. Application URL: `http://127.0.0.1:19782/`.
- No published package or published checksum applies to this authorized source test. The product version and release tag were not changed. No new sampler ran. Production collector PID 439146 and sampler PID 439179 were preserved.
- Case revisions: QA-082 r3, QA-083 r2, QA-085 r2, QA-087 r3, QA-088 r2. QA-003, QA-084, QA-086, QA-089, QA-090 retain their existing unnumbered definitions. Earlier results test earlier definitions and remain in their records.
- Evidence: [browser observations](evidence/observations.json). Fixtures: [UDP datagrams](../20261023T033403Z-source-minimal-tiles/evidence/wire.py), [source-backed control](../20261023T033403Z-source-minimal-tiles/evidence/control-proxy.py).

| Case | Status | Observation |
| --- | --- | --- |
| QA-003 | PASSED | Empty process input stayed invalid. PID 2147483646 showed `no running process with PID 2147483646` before confirmation. The isolated configuration did not change. |
| QA-082 | PASSED | Six faces contained only the name, host/ID, one assessment dot, and optional Remove. No verdict, finding text, no-data message, PID, metric, access badge, or throttle badge appeared. Same-name targets had distinct identities. Details remained in the card and dashboard. |
| QA-083 | PASSED | Dots and edges matched red critical, orange serious, amber warning, green healthy, and gray no-data levels. Every dot had an assessment label, native title, and no animation. Live serious and warning targets stayed orange and amber. Counts, worst-first/key order, and title prefix agreed. |
| QA-084 | BLOCKED | Click, Enter, and All targets opened the expected pages. T3 history and middle-click results could not be verified. Earlier T3 capability checks did not navigate Back or expose a middle-click tab. |
| QA-085 | PASSED | Empty state showed No targets yet. No-view tile showed its identity and gray dot only. Stopping the owned collector showed the stale-data banner and retained six tiles. Restart cleared the banner and restored polling. |
| QA-086 | BLOCKED | T3 opening another tab did not set `document.hidden=true`. The 30 s hidden interval and resume timing remain unverified. |
| QA-087 | PASSED | All nine theme/width combinations passed. Tiles and Add target measured 286×286, 366×366, and 296×296 at desktop, 390 px, and 320 px. Gaps were 24 px. Scroll width equaled viewport width. Long identity text wrapped. Remove stayed 21 px from the bottom and right borders. |
| QA-088 | PASSED | Link and Remove kept visible 2 px focus after two polls. Enter opened the target. Accessible labels retained the assessment. Both guides stated the trend-rule limit. Tile help described the minimal face and distinguished assessment from sampler activity. |
| QA-089 | BLOCKED | The source-backed control fixture showed 20 options for 22 matching names. PID, user, start age, and command were visible for live choices. Actual sampler reload, target addition, and persistence require a sampler and remain untested. Earlier fixture-only selection/save observations are retained separately. |
| QA-090 | PASSED | Rapid movement showed no immediate card. Problem focus showed PID, start age, command and finding details through two polls. Healthy target had no card. Enter while the card was open reached the target dashboard. |

Result: 7 PASSED, 3 BLOCKED, 0 FAILED, 0 NOT_RUN in this run. Readiness is limited to the executed overview UI scope. The earlier verdict/title design results do not establish this design's readiness. See [first failures](../20261023T032533Z-source-minimal-tiles/index.md) and [superseded compact-face run](../20261023T033403Z-source-minimal-tiles/index.md).

The actual collector consumed synthetic TTGT, TMON, and TPIN datagrams. The proxy forwarded the embedded dashboard and collector APIs. It called `sampler_control.change_target_set` against an isolated TOML file for controls, returned an explicit no-view 404, supplied packet-loss warning data, and supplied the empty target list. It did not signal a sampler. Fixture removal confirmation stayed on the overview; Remove disappeared after focus left and the next poll ran. This does not prove live sampler control.

Expected browser diagnostics were 404 for no-data, 400 for invalid or ambiguous input, and 503 during the owned collector outage. No blocking script exception was observed. No passing screenshots were saved. The call target was exceeded across the changing requirements, corrected builds, and repeated theme/width matrices.

Excluded: unrelated release cases, recorded replay, sampler overhead, and actual sampler control persistence. Browser history, middle-click tab behavior, and true hidden-tab polling remain blocked. Only owned collector, UDP fixture, proxy, and fixture children were stopped after the run.
