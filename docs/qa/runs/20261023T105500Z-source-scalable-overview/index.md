# Scalable overview feature regression

UTC: 2026-10-23 05:25:24 to 05:31:22. The run directory is a unique identifier; its timestamp is not the observed UTC start time.

Artifact: authorized unreleased source build, revision `59344f52acbd66d90f621a7ac5955a834a1102f9`, PR #155. No published package was substituted. Collector: `build/triangulator-collector`, SHA-256 `f516ca2819ed4394f72ab417026df7c97cbf851064594f81af17a56664b05b4b`. Source: https://github.com/breakbadsp/triangulator/pull/155. No release checksum applies. No build or product changes occurred during this run. Automated checks are the parent run's reported `make check` 192 passed / 1 expected skip and Node 172 passed; this record does not replace them with browser claims.

Environment: Linux x86_64; T3 collaborative browser Chrome 154.0.0.0. Viewports: 320 × 700, 390 × 844, 1280 × 800, 1920 × 1080 CSS pixels. Owned tabs: tab_13 and tab_14 in session c514dacc-b55c-424f-bd16-a16942950937. The first navigation reported an ownership error; `preview_open` on the owned tab corrected it. Subsequent actions worked.

Setup: `python3 tests/fleet_fixture.py --targets 64 --http-port 19864`, repeated once for 20 at 19820 and 50 at 19850. Each fixture started one isolated collector with temporary data and UDP feeds. No sampler ran. Collector PIDs: 4041533, 4059136, 4059442. Fixture PIDs: 4041521, 4059124, 4059430. URLs: `http://127.0.0.1:19864/`, `http://127.0.0.1:19820/`, `http://127.0.0.1:19850/`.

The [proxy fixture](evidence/control-proxy.py) at 19865 forwarded the same page and API. Its `/tmp/tri-scalable-qa-mode.json` selected the upstream and enabled two explicit overrides: one 503 `/api/live` for `nginx-63`, and an enabled local control response. It accepted validation only and refused monitoring writes. This covered No data and Add target access with no matching tiles. It did not establish sampler persistence. The proxy started no child process. A mode change from upstream 19864 to 19820 exercised a real poll count change on one browser origin.

Scope: requested feature regression, QA-091–093 and affected QA-087, QA-088, QA-090. This is not a full release regression. All unrelated cases were excluded. Definitions were not changed.

| Case | Revision | Result | Observation |
| --- | --- | --- | --- |
| QA-087 | 4 | FAILED | Long names use ellipsis instead of the required wrapping. Identity text wraps. Themes and controls remain readable, with no horizontal overflow. Add target has a 140 px height in the control proxy. Remove placement was not measured, and no live Remove action ran. |
| QA-088 | 2 | BLOCKED | Tile link has a visible 2 px outline; focus, 64 tile nodes, and 64 links survive two polls. Enter opens the correct target. Assessment labels and fleet/fleet-tile help agree. Remove and help focus through two polls remain unexecuted. |
| QA-090 | 1 (implicit) | BLOCKED | Serious card appears after delay on hover and keyboard focus, shows PID 4001 and the kernel-wait finding, and Enter still opens its dashboard. The fixture has no start time or command line metadata. Those expectations and fast-movement flash behavior remain unverified. |
| QA-091 | 1 (implicit) | BLOCKED | All 24 scale layouts checked. Default Comfortable, both saved choices after reload, CSS sizes, same fonts, and 64→20 poll persistence work. Blocked browser storage could not be exercised through the available browser controls. |
| QA-092 | 1 (implicit) | PASSED | Name/host/ID search, all status choices including injected No data, combined no-match, Clear filters, Add target access and confirmation cancellation, global totals, poll focus/node stability, no input requests, accurate help, and 320 px no-match layout observed. |
| QA-093 | 1 (implicit) | BLOCKED | Copied filtered URL in a new tab and tile→All targets restore q/status and 11 of 64 tiles. Alt+Left did not navigate; middle-click did not create a T3 tab. Actual Back, middle-click round trip, and blocked storage remain unverified. |

Results: 1 PASSED, 1 FAILED, 4 BLOCKED, 0 NOT_RUN in this scope. Partial observations do not establish all expectations for a blocked case.

## Failure reproduction

1. Start the 64-target fixture and open its overview at 320 × 700.
2. Select Compact in Tiles.
3. Read the first link, `postgres-00-primary-replica-sha`.

Expected by QA-087 revision 4: names and identities wrap within the tile. Actual: the name is one line with an ellipsis (`white-space: nowrap; overflow: hidden; text-overflow: ellipsis`). It needs 264 px but has 246 px at 320. At 1920 Compact it has 173 px. No retry hid this observation. The full host/ID remains in the wrapped line below and in the link's accessible name; there is no native title. Thus the observed failure is against the wrap requirement, with no confirmed identity loss. [Screenshot](evidence/qa087-320-compact.png). No relevant console error occurred.

## Scale and usability

Fully visible tiles at scroll 0, Comfortable / Compact:

| Viewport | 20 | 50 | 64 |
| --- | --- | --- | --- |
| 320 × 700 | 1 / 1 | 1 / 1 | 1 / 1 |
| 390 × 844 | 2 / 3 | 2 / 3 | 2 / 3 |
| 1280 × 800 | 12 / 20 | 12 / 20 | 12 / 20 |
| 1920 × 1080 | 20 / 20 | 25 / 42 | 25 / 36 |

All 24 layouts had zero horizontal overflow. Comfortable / Compact use 140 / 104 px minimum height, 24 / 16 px gaps, and 20 / 12 × 14 px padding. Name and identity fonts stay 18 and 12 px. Long identities increase row height. The 50-target desktop result differs from the PR's 36 Compact claim; this browser observed 42. The 20-target desktop view already shows all targets in either mode.

At 320, grid top is 515 px. Header takes 65 px; introduction ends at 205; count pills occupy 217–327; filters occupy 342–497. Controls do not overlap or lose text. The 3-line introduction, stacked counts, and row spacing consume most of the first screen. A small reduction to narrow-screen margins and row gaps can recover space without smaller fonts or controls. This is a usability observation, not a failure against an invented tile threshold.

Dark tiles are rgb(18,18,20); Light tiles are white. System follows this browser's light preference. Dark and Light width checks at 320, 390 and 1280 show no sideways scroll. System was confirmed at 1280 after selecting its exact option label. Search is 14 px, selects 13 px, in either density.

## Functional evidence and limits

The 64-target collector gives 21 Critical, 11 Serious, 11 Warning and 21 Healthy. Needs attention shows 43. Search `postgres`, `rack04` and `nginx-63` finds 16, 8 and 1. Filter order remains worst first. Totals do not change. The proxy's one failed live request changes Healthy to 20 and adds 1 No data. Silent/absent targets remain Critical.

With a no-match search and No data status, Add target stays visible. Open it, enter `qa-cancel` and the owned collector PID, select Add target, observe the confirmation, dismiss it, then select Cancel. Clear filters restores all 64 tiles. No monitoring write occurs. At 320, no-match has zero overflow and Clear filters stays inside the viewport.

Two polls give 132 expected resources (2 × control + target list + 64 live views). The filter, 64 nodes, 64 link elements and focused link remain stable. A separate rapid typing check with 20 targets leaves resources at 22 before and after (75.8 ms), with no new resource start. Earlier three search changes at 64 also left the recorded resource starts unchanged. Background polls are not attributed to typing.

The density, filter, overview and target-tile contextual help topics opened and matched the observed behavior and stated limits. Native browser storage blocking, true hidden-tab behavior, and real browser Back remain outside this run's demonstrated scope. Node coverage reported by the parent is not browser evidence.

[Compact observations](evidence/observations.json). The Quick target of about 150 tool calls was exceeded for the 24-layout matrix and feature boundaries. All test-owned fixtures, collectors, proxy, and tabs were stopped after the run. Existing installations and the user demo were untouched.
