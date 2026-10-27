# Full package QA: dev-f5a611b

- UTC: 2026-10-27 10:34–10:43.
- Source: `f5a611b16d995a38612ea5cc213b289f29800605`, PR 181.
- Source URL: [package workflow 40489294813](https://github.com/breakbadsp/triangulator/actions/runs/40489294813).
- Installed `triangulator-sampler-dev-f5a611b-el9-x86_64.tar.gz` and `triangulator-collector-dev-f5a611b-el9-x86_64.tar.gz`. Both published checksum files passed before extraction. Package startup needed no compiler.
- EL8 acquisition was blocked. Its build and tests completed, but artifact upload failed with `Failed to CreateArtifact: Unable to make request: ECONNRESET`. No EL8 artifact was available. See [upload failure](evidence/el8-upload-failure.log).
- Environment: Arch Linux x86_64, Linux `7.2.8-9-omarchy`; Chromium `155.0.8059.84`, headless; viewport 1280 × 713. This was EL9 binary testing on Arch Linux, not a native AlmaLinux installation.
- Isolation: `/tmp/triangulator-qa-react-full-f5a611b/triangulator`; HTTP `127.0.0.1:33907`; UDP `127.0.0.1:45248`. Owned fixture and application processes were stopped after the run.
- Scope: Full, with QA-005 first as a focused regression. Result: 4 PASSED, 1 FAILED, 111 NOT_RUN. The custom-interval fix passed. A separate Sanity replay-selection failure prevents the remaining replay checks. QA-004 was completed as an unaffected check. No case definitions changed.
- Browser limit: `preview_open` returned “The calling provider no longer owns an active thread run.” Used local Chromium. Sanity exceeded the 40-call target because of the focused regression, its verification attempt, and the named-target check.
- Package limit: `/dev/kmsg` was not readable. Kernel exit evidence was unavailable.
- Record validation: `make -j2 check` passed (366 dashboard tests and 190 Python tests; one privileged BPF test skipped). The QA summary check and `git diff --check` passed. [Check log](evidence/make-check.log). Source checks do not count as package case execution.
- Evidence: [observations and hashes](evidence/observations.json), [browser transcript](evidence/browser-observations.ndjson), [runtime identity](evidence/state.json), [workflow](evidence/package-workflow.json), and [case results](evidence/results.json).

## QA-005: Previous opens a stale recording

1. Open a live target with recordings enabled.
2. Wait between recording-bounds refreshes. Read `/api/replay?target=omarchy%2Fdefault` without changing the page state.
3. Immediately select Previous in the browser.
4. Compare the selected recording with the newest stored recording from step 2.

Expected: Previous from Live opens the newest recording.

Actual: At `1793097535.338`, the API reported newest recording `1793097534.266875` (local 16:08:54). The displayed bounds ended at 16:08:42. Previous opened `1793097522.26679` (16:08:42), 12 seconds older than the newest stored recording. In the first observation, Previous opened 16:05:08 and the displayed bounds then refreshed to 16:05:24. Both observations were on 2026-10-27.

Evidence: [stale selection screenshot](evidence/qa005-previous-stale.png) and the `qa005-newest-before-click` / `qa005-newest-after-click` entries in the browser transcript.

The prior custom-history defect is fixed in this package. The exact live interval `15:04:15–16:05:15` restored after selecting a recorded 15-minute preset `15:50:08–16:05:08`. The 1-minute map window restored. A held Timeline preview remained Live until mouse release, which selected a recording. Recorded history presets ended at the recorded clock; recorded Settings actions and socket observations were hidden.

<!-- case-results -->

| Case | Revision | Status | Observation |
| --- | ---: | --- | --- |
| QA-001 | 1 | PASSED | Published EL9 sampler and collector checksums passed. Package startup needed no compiler. Chromium identified sleep PID 302669 and fresh threads, resources, memory data and recordings. |
| QA-002 | 1 | PASSED | Added owned PID 302670 as qa-second. The hovered submit button stayed unobstructed. Confirmation applied the target. Both targets stayed live; its thread appeared and selection survived reload. |
| QA-003 | 1 | PASSED | Empty process input rejected with browser required-field validation. Nonexistent PID 999999999 rejected before confirmation. Reload preserved only default and qa-second. |
| QA-004 | 1 | PASSED | Absent name qa-next was accepted as qa-wait2, then Target absent became live PID 305210 when the named process started. SIGTERM produced a final view that survived selecting default and returning via the picker. Show live dismissed it. A restarted qa-absent PID did not replace its prior final view until Show live. scripts/set-target.sh changed qa-wait from qa-absent to qa-other. |
| QA-005 | 1 | FAILED | Live custom history interval now restores after recorded preset, and Timeline preview remains Live until release. Separate failure: Previous from Live opened 1793097522.26679 while a read-only bound check immediately before the click reported newest recording 1793097534.266875 (12 seconds newer). Earlier attempt opened a recording 16 seconds behind. Cached UI bounds choose stale recording. |
| QA-006 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-007 | 3 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-008 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-009 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-010 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-011 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-012 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-013 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-014 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-015 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-016 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-017 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-018 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-019 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-020 | 2 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-021 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-022 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-023 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-024 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-025 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-026 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-028 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-029 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-030 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-031 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-032 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-033 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-034 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-035 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-036 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-037 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-038 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-039 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-045 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-046 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-047 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-048 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-049 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-050 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-051 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-052 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-053 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-054 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-055 | 2 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-056 | 2 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-057 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-058 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-059 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-060 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-061 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-062 | 2 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-063 | 2 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-064 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-065 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-066 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-067 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-068 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-069 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-070 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-071 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-072 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-073 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-074 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-075 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-076 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-077 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-078 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-079 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-080 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-081 | 2 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-082 | 3 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-083 | 2 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-084 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-085 | 2 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-086 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-087 | 5 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-088 | 2 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-089 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-090 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-091 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-092 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-093 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-094 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-095 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-096 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-097 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-098 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-099 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-100 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-101 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-102 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-103 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-104 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-105 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-106 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-107 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-108 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-109 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-110 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-111 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-112 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-113 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-114 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-115 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-116 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-117 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-118 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-119 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-120 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-121 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
| QA-122 | 1 | NOT_RUN | Not attempted: Sanity replay selection failed; a further package is needed for the remaining Full run. |
