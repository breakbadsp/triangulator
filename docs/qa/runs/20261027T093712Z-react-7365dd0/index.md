# Full package QA: dev-7365dd0

- UTC: 2026-10-27 09:27–09:37.
- Source: `7365dd0ef99649fbad818330ce821c6bc552b1a3`, PR 179.
- Package source: [workflow 40480672866](https://github.com/breakbadsp/triangulator/actions/runs/40480672866). Both AlmaLinux package jobs passed.
- Installed `triangulator-sampler-dev-7365dd0-el9-x86_64.tar.gz` and `triangulator-collector-dev-7365dd0-el9-x86_64.tar.gz`. Both published checksum files passed before extraction. EL8 archives also passed checksum verification; EL8 runtime testing was not attempted.
- Environment: Arch Linux x86_64, Linux `7.2.8-9-omarchy`; Chromium `155.0.8059.84`, headless; viewport 1280 × 713.
- Isolation: `/tmp/triangulator-qa-react-full-7365dd0/triangulator`; HTTP `127.0.0.1:43959`; UDP `127.0.0.1:49111`; owned sleep PIDs 210053 and 210054.
- Scope: Full. Sanity stopped at QA-005. Result: 3 PASSED, 1 FAILED, 112 NOT_RUN. No excluded cases.
- Browser limit: `preview_open` returned “The calling provider no longer owns an active thread run.” Used local Chromium. The first QA-002 attempt lost CDP control when the client disconnected with a confirmation open. Persistent CDP control completed its retry. This did not establish a product failure.
- Package limitation: `/dev/kmsg` was not readable. No kernel exit evidence was available.
- Sanity exceeded the 40-call target because browser fallback diagnostics and the replay retry needed more steps.
- Record validation: `make -j2 check` passed (365 dashboard tests and 190 Python tests; one privileged BPF test skipped). `scripts/qa_summary.py --write-readme --check` and `git diff --check` passed. Source checks do not count as package case execution.
- Evidence: [observations](evidence/observations.json), [browser transcript](evidence/browser-observations.ndjson), [package workflow](evidence/package-workflow.json), [runtime identity](evidence/state.json). SHA-256 values are in observations. The fixture uses the two owned sleep processes; it builds no source binary.

## QA-005: Live custom history interval is lost

1. Select a live target and a 1-minute Thread map window.
2. Open a thread. Change From to a custom value and select Load.
3. Close the drawer. Select Previous to open a recording, step back and forward, then open its thread.
4. Select the 15 min history preset. Its To field correctly ends at the recorded time.
5. Return to Live. Open the same thread again.

Expected: Return restores the live custom history inputs, as QA-005 requires.

Actual: The recorded preset replaces those inputs. The first attempt changed the live interval `14:02:17–15:03:17` to `14:48:28–15:03:28`. The retry changed `14:49:56–15:05:56` to the recorded interval `14:50:58–15:05:58`. Reopening the live drawer then selected a moving 15-minute interval. Both attempts used local time on 2026-10-27. Live mode, the map window, and drawer closure restored correctly. The remaining QA-005 expectations were not completed.

Evidence: [custom live interval before replay](evidence/qa005-live-custom-before.png), [live interval after replay](evidence/qa005-live-custom-after.png), and the timestamped browser transcript. No browser exception was established. The failure concerns the observed interval values.

<!-- case-results -->

| Case | Revision | Status | Observation |
| --- | ---: | --- | --- |
| QA-001 | 1 | PASSED | EL9 sampler and collector checksums passed. Package scripts started both programs without a compiler. Chromium showed sleep PID 210053, one fresh thread, resource data, memory data, and recordings. |
| QA-002 | 1 | PASSED | Added owned PID 210054 as qa-second, accepted the shared-change confirmation, opened its tile, and reloaded. Both targets remained live. Add target remained the hit target after hover. |
| QA-003 | 1 | PASSED | Empty input showed Please fill out this field. PID 999999999 showed no running process with PID 999999999 without confirmation. Reload retained only the two saved targets. |
| QA-004 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-005 | 1 | FAILED | Recorded history presets replace the live custom history interval. Return to Live restores the map window and closes the drawer but does not restore the custom history inputs. Reproduced once. The remaining expectations were not completed. |
| QA-006 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-007 | 3 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-008 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-009 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-010 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-011 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-012 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-013 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-014 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-015 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-016 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-017 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-018 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-019 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-020 | 2 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-021 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-022 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-023 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-024 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-025 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-026 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-028 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-029 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-030 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-031 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-032 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-033 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-034 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-035 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-036 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-037 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-038 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-039 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-045 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-046 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-047 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-048 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-049 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-050 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-051 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-052 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-053 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-054 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-055 | 2 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-056 | 2 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-057 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-058 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-059 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-060 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-061 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-062 | 2 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-063 | 2 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-064 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-065 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-066 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-067 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-068 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-069 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-070 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-071 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-072 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-073 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-074 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-075 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-076 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-077 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-078 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-079 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-080 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-081 | 2 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-082 | 3 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-083 | 2 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-084 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-085 | 2 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-086 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-087 | 5 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-088 | 2 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-089 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-090 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-091 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-092 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-093 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-094 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-095 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-096 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-097 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-098 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-099 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-100 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-101 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-102 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-103 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-104 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-105 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-106 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-107 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-108 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-109 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-110 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-111 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-112 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-113 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-114 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-115 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-116 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-117 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-118 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-119 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-120 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-121 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
| QA-122 | 1 | NOT_RUN | Stopped at Sanity failure QA-005. |
