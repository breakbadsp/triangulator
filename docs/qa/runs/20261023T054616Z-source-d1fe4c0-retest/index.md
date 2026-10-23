# Scalable overview correction retest

UTC: 2026-10-23 05:46:16–05:50:52. Authorized source build `d1fe4c0b727b8f9b23febc9a26980add60e49a10`, [PR #155](https://github.com/breakbadsp/triangulator/pull/155). Collector `build/triangulator-collector`, SHA-256 `5de0e1f578b575c40e4815306b9a3131703a194bc8d3fb733ffb85c4aa13eb73`. No release package or published checksum applies. No build or product change occurred during this retest. Parent validation: `make check` 192 passed / 1 expected skip; Node 173 passed.

Environment: Linux x86_64, T3 real browser Chrome 154.0.0.0, owned `tab_16_c514dacc-b55c-424f-bd16-a16942950937`. Start: `python3 tests/fleet_fixture.py --targets 64 --http-port 19864`. Fixture PID 4099313; collector PID 4099325; temporary data `/tmp/tri-fleet-fixture-rmzkowmv`. URL `http://127.0.0.1:19864/`. One collector and deterministic UDP feeds; no sampler.

Reused the prior transparent proxy at `http://127.0.0.1:19865/`, with real page/API forwarding and fixture control metadata. Its initial one configured target correctly disabled Remove. The [retest proxy](evidence/control-proxy.py) adds a second control entry so Remove can receive Tab focus. It rejects monitoring writes. No Remove action or sampler persistence test occurred. Mode file: `/tmp/tri-scalable-qa-mode.json`, `{"port":19864,"control":true,"nodata":false}`.

| Case | Revision | Result | Observations |
| --- | --- | --- | --- |
| QA-087 | 5 | PASSED | Three themes × four viewports × two densities. Long-name title and accessible name are complete after real pointer hover. Identities wrap; Add target heights and Remove placement agree with density. Text and controls remain readable. No horizontal overflow. |
| QA-088 | 2 | PASSED | Tab reaches help, tile link, and enabled Remove. Each keeps focus and tile elements through two actual polls. Each has a visible 2 px outline. Enter on the tile opens the expected target. Dot/link assessment labels and both help topics meet expectations. |

Counts for executed cases: 2 PASSED, 0 FAILED, 0 BLOCKED, 0 NOT_RUN. No new product failure was found. The earlier QA-087 revision 4 failure remains in its [unchanged baseline record](../20261023T105500Z-source-scalable-overview/index.md).

## Measurements

Each result below held in Dark, Light, and System. System matched this browser's light preference.

| Viewport | Full tiles Comfortable / Compact | Columns | Grid top |
| --- | --- | --- | --- |
| 320 × 700 | 1 / 2 | 1 / 1 | 465.20 px |
| 390 × 844 | 2 / 4 | 1 / 1 | 376.43 px |
| 1280 × 800 | 12 / 20 | 4 / 5 | 231.79 px |
| 1920 × 1080 | 25 / 36 | 5 / 6 | 231.79 px |

All 24 layouts had zero horizontal overflow. The 320 grid starts 49.80 px earlier than the baseline; Compact now shows a second full tile. Comfortable / Compact minimum heights are 140 / 104 px, gaps 24 / 16 px, padding 20 / 12 × 14 px. Name text remains 18 px; identity text remains 12 px. Search remains 14 px; selects remain 13 px. Controls remain separate and readable. Dark tiles are rgb(18,18,20); Light/System tiles are white. Aspect ratio is `auto`. Long identities wrap without horizontal clipping and increase tile height when needed.

The proxy's Add target measured exactly 140 / 104 px in both densities at all four widths. Remove is at the bottom right: Comfortable right/bottom inset 21/21 px; Compact 15/13 px. Its control stays 66.69 × 26.59 px. The Compact managed tile grows to 115.09 px to fit its content.

Real pointer hover on the first long name returned `:hover=true`. Text, `title`, and the full name in `aria-label` were all `postgres-00-primary-replica-sha`. The host/ID line used normal wrapping, 37 px height, and zero horizontal overflow at 320 Compact. T3's page capture did not include an operating-system native title bubble. The title attribute and accessible-name contract were observed; this record does not claim native bubble capture. Dynamic name replacement through a poll was not retested in the browser; parent Node coverage is separate.

## Focus and smoke checks

A PerformanceObserver counted two control requests and 132 total resources during each 11-second focus check. Help, link, and Remove kept focus and the same 64 tile nodes. Initial resource-count attempts hit the 250-entry resource timing buffer and could not prove polls; they were replaced with direct observation of subsequent requests. The disabled Remove attempt was a fixture precondition check, not a product failure.

The opened `fleet` and `fleet-tile` help topics state that tiles do not run trend rules. Tile help describes the minimal face, assessment dot, full-name hover title, and dashboard details. The dot's accessible name reads `Assessment: Needs attention now`; the link includes its assessment.

Smoke only: search `api-gateway-01` plus Serious shows 1 of 64; tile → All targets returns to the same `q` and `status`. Clear filters returns `/` and shows 64. With no matching tile, Add target stays visible, opens its dialog, and Cancel closes it. No relevant console error appeared. QA-092 retains its complete prior result because its full case was not rerun here.

QA-090, QA-091, and QA-093 retain their prior BLOCKED results. This run did not repeat the 20/50-target matrix, blocked storage, actual browser Back, middle-click, true hidden-tab behavior, or missing process start/command metadata. Baseline measurements are context only, not new observations for this source. The focused retest exceeded the approximate Quick tool-call target because it covered 24 layout combinations and corrected the control fixture precondition.

[Compact observations](evidence/observations.json). All owned fixture/collector/proxy processes and the owned tab were stopped. Existing processes, installations, and the user demo at 19781 were untouched.
