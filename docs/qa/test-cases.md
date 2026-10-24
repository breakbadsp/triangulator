# Manual test cases

- Use an isolated package installation, unused ports, and owned test processes.
- Each case gives setup, actions, and expected behavior. Use [bug lab cases](bug-lab-cases.md) for QA-101 through QA-120.
- Results below describe the named tested version. They do not establish the current source status.
- Leave unexecuted cases `NOT_RUN`. See [manual QA](../manual-qa.md).

## Current results

| Case ID | Status | Tested package version | Run | Evidence |
| --- | --- | --- | --- | --- |
| QA-001 | PASSED | source 384352f | [Run](runs/20261020T191300Z-source-384352f-multi-target/index.md) | [API targets](runs/20261020T191300Z-source-384352f-multi-target/evidence/qa001-002-api-targets.txt) |
| QA-002 | PASSED | source 384352f | [Run](runs/20261020T191300Z-source-384352f-multi-target/index.md) | [API targets](runs/20261020T191300Z-source-384352f-multi-target/evidence/qa001-002-api-targets.txt) |
| QA-003 | PASSED | source square-dot 83dcb99d | [Run](runs/20261023T034016Z-source-square-dot/index.md) | [Browser observations](runs/20261023T034016Z-source-square-dot/evidence/observations.json) |
| QA-004 | FAILED | source 384352f | [Run](runs/20261020T192000Z-source-384352f-multi-target-regression/index.md) | [Named target](runs/20261020T192000Z-source-384352f-multi-target-regression/evidence/qa004-named-target.txt) |
| QA-005 | PASSED | source 384352f | [Run](runs/20261020T191300Z-source-384352f-multi-target/index.md) | [Browser observations](runs/20261020T191300Z-source-384352f-multi-target/evidence/browser-observations.txt) |
| QA-006 | BLOCKED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Release metadata](runs/20261009T035640Z-v0.1.0/evidence/release.json) |
| QA-007 | FAILED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Help sweep](runs/20261011T110000Z-ci-5189c47/evidence/qa007-help.json) |
| QA-008 | BLOCKED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Legend check](runs/20261011T110000Z-ci-5189c47/evidence/qa008-legend.json) |
| QA-009 | NOT_RUN | - | - | - |
| QA-010 | PASSED | source 93946af | [Run](runs/20261011T095009Z-v0.1.0-retest/index.md) | [Interactive log](runs/20261011T095009Z-v0.1.0-retest/evidence/qa010-drops.json) |
| QA-011 | PASSED | PR65 44decf5 (CI baadbd7) | [Run](runs/20261011T090200Z-pr65/index.md) | [Evidence](runs/20261011T090200Z-pr65/evidence/observations.json) |
| QA-012 | BLOCKED | PR65 44decf5 (CI baadbd7) | [Run](runs/20261011T090200Z-pr65/index.md) | [Evidence](runs/20261011T090200Z-pr65/evidence/observations.json) |
| QA-013 | BLOCKED | PR65 44decf5 (CI baadbd7) | [Run](runs/20261011T090200Z-pr65/index.md) | [Evidence](runs/20261011T090200Z-pr65/evidence/observations.json) |
| QA-014 | BLOCKED | PR65 44decf5 (CI baadbd7) | [Run](runs/20261011T090200Z-pr65/index.md) | [Evidence](runs/20261011T090200Z-pr65/evidence/observations.json) |
| QA-015 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Observations](runs/20261011T110000Z-ci-5189c47/evidence/qa015-observations.json) |
| QA-016 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Sequence](runs/20261011T110000Z-ci-5189c47/evidence/qa016-sequence.json) |
| QA-017 | PASSED | PR65 44decf5 (CI baadbd7) | [Run](runs/20261011T090200Z-pr65/index.md) | [Evidence](runs/20261011T090200Z-pr65/evidence/observations.json) |
| QA-018 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Observations](runs/20261011T110000Z-ci-5189c47/evidence/qa018-observations.json) |
| QA-019 | PASSED | PR65 957e763 dashboard (CI baadbd7 fixtures) | [Retest](runs/20261011T094600Z-pr65-957e763/index.md) | [Growth](runs/20261011T094600Z-pr65-957e763/evidence/growth.json) |
| QA-020 | NOT_RUN | - | - | - |
| QA-021 | NOT_RUN | - | - | - |
| QA-022 | NOT_RUN | - | - | - |
| QA-023 | NOT_RUN | - | - | - |
| QA-024 | NOT_RUN | - | - | - |
| QA-025 | NOT_RUN | - | - | - |
| QA-026 | NOT_RUN | - | - | - |
| QA-028 | NOT_RUN | - | - | - |
| QA-029 | NOT_RUN | - | - | - |
| QA-030 | NOT_RUN | - | - | - |
| QA-031 | NOT_RUN | - | - | - |
| QA-032 | PASSED | source 384352f | [Run](runs/20261020T192000Z-source-384352f-multi-target-regression/index.md) | [Watch intervals](runs/20261020T192000Z-source-384352f-multi-target-regression/evidence/qa032-watch-intervals.txt) |
| QA-033 | PASSED | source 384352f | [Run](runs/20261020T192000Z-source-384352f-multi-target-regression/index.md) | [Stopped views](runs/20261020T192000Z-source-384352f-multi-target-regression/evidence/qa033-stopped-views.txt) |
| QA-034 | NOT_RUN | - | - | - |
| QA-035 | NOT_RUN | - | - | - |
| QA-036 | NOT_RUN | - | - | - |
| QA-037 | NOT_RUN | - | - | - |
| QA-038 | NOT_RUN | - | - | - |
| QA-039 | NOT_RUN | - | - | - |
| QA-045 | NOT_RUN | - | - | - |
| QA-046 | NOT_RUN | - | - | - |
| QA-047 | PASSED | source 384352f | [Run](runs/20261020T192000Z-source-384352f-multi-target-regression/index.md) | [Two viewers](runs/20261020T192000Z-source-384352f-multi-target-regression/evidence/qa047-two-viewers.txt) |
| QA-048 | NOT_RUN | - | - | - |
| QA-049 | BLOCKED | 0.1.0 | [Run](runs/20261015T091100Z-v0.1.0-multiple-viewers/index.md) | [Evidence](runs/20261015T091100Z-v0.1.0-multiple-viewers/evidence/stale-target-a.json) |
| QA-050 | BLOCKED | 0.1.0 | [Run](runs/20261015T091100Z-v0.1.0-multiple-viewers/index.md) | [Evidence](runs/20261015T091100Z-v0.1.0-multiple-viewers/evidence/browser-tool-errors.txt) |
| QA-051 | BLOCKED | 0.1.0 | [Run](runs/20261015T091100Z-v0.1.0-multiple-viewers/index.md) | [Evidence](runs/20261015T091100Z-v0.1.0-multiple-viewers/evidence/browser-tool-errors.txt) |
| QA-052 | NOT_RUN | - | - | - |
| QA-053 | NOT_RUN | - | - | - |
| QA-054 | NOT_RUN | - | - | - |
| QA-055 | NOT_RUN | - | - | - |
| QA-056 | NOT_RUN | - | - | - |
| QA-057 | NOT_RUN | - | - | - |
| QA-058 | NOT_RUN | - | - | - |
| QA-059 | PASSED | source 384352f | [Run](runs/20261021T020000Z-source-384352f-multi-target-thorough/index.md) | [Commands](runs/20261021T020000Z-source-384352f-multi-target-thorough/evidence/qa059-065-target-commands.txt) |
| QA-060 | FAILED | source 384352f | [Run](runs/20261021T020000Z-source-384352f-multi-target-thorough/index.md) | [Budget](runs/20261021T020000Z-source-384352f-multi-target-thorough/evidence/qa060-budget.txt) |
| QA-061 | FAILED | dev-384352f (CI) | [Run](runs/20261021T005620Z-five-targets/index.md) | [Observations](runs/20261021T005620Z-five-targets/evidence/observations.json) |
| QA-062 | NOT_RUN | - | - | - |
| QA-063 | NOT_RUN | - | - | - |
| QA-064 | NOT_RUN | - | - | - |
| QA-065 | PASSED | source 384352f | [Run](runs/20261021T020000Z-source-384352f-multi-target-thorough/index.md) | [Commands](runs/20261021T020000Z-source-384352f-multi-target-thorough/evidence/qa059-065-target-commands.txt) |
| QA-066 | BLOCKED | source 384352f | [Run](runs/20261021T020000Z-source-384352f-multi-target-thorough/index.md) | - |
| QA-067 | NOT_RUN | - | - | - |
| QA-068 | NOT_RUN | - | - | - |
| QA-069 | NOT_RUN | - | - | - |
| QA-070 | NOT_RUN | - | - | - |
| QA-071 | FAILED | source 384352f | [Run](runs/20261021T020000Z-source-384352f-multi-target-thorough/index.md) | [Removed target](runs/20261021T020000Z-source-384352f-multi-target-thorough/evidence/qa071-removed-target.txt) |
| QA-072 | PASSED | source 384352f | [Run](runs/20261021T020000Z-source-384352f-multi-target-thorough/index.md) | [Timeline](runs/20261021T020000Z-source-384352f-multi-target-thorough/evidence/qa072-clean-timeline.txt) |
| QA-073 | PASSED | dev-384352f (CI) | [Run](runs/20261021T005620Z-five-targets/index.md) | [Observations](runs/20261021T005620Z-five-targets/evidence/observations.json) |
| QA-074 | PASSED | dev-384352f (CI) | [Run](runs/20261021T005620Z-five-targets/index.md) | [Observations](runs/20261021T005620Z-five-targets/evidence/observations.json) |
| QA-075 | FAILED | dev-384352f (CI) | [Run](runs/20261021T005620Z-five-targets/index.md) | [Observations](runs/20261021T005620Z-five-targets/evidence/observations.json) |
| QA-076 | PASSED | dev-384352f (CI) | [Run](runs/20261021T005620Z-five-targets/index.md) | [Observations](runs/20261021T005620Z-five-targets/evidence/observations.json) |
| QA-077 | PASSED | dev-384352f (CI) | [Run](runs/20261021T005620Z-five-targets/index.md) | [Observations](runs/20261021T005620Z-five-targets/evidence/observations.json) |
| QA-078 | FAILED | source 384352f+master | [Run](runs/20261021T0700Z-capacity-sanitizer-followup/index.md) | [Test log](runs/20261021T0700Z-capacity-sanitizer-followup/evidence/qa078-test.log) |
| QA-079 | NOT_RUN | - | - | - |
| QA-080 | NOT_RUN | - | - | - |
| QA-081 | NOT_RUN | - | - | - |
| QA-082 | PASSED | source square-dot 83dcb99d | [Run](runs/20261023T034016Z-source-square-dot/index.md) | [Browser observations](runs/20261023T034016Z-source-square-dot/evidence/observations.json) |
| QA-083 | PASSED | source square-dot 83dcb99d | [Run](runs/20261023T034016Z-source-square-dot/index.md) | [Browser observations](runs/20261023T034016Z-source-square-dot/evidence/observations.json) |
| QA-084 | BLOCKED | source square-dot 83dcb99d | [Run](runs/20261023T034016Z-source-square-dot/index.md) | [Browser observations](runs/20261023T034016Z-source-square-dot/evidence/observations.json) |
| QA-085 | PASSED | source square-dot 83dcb99d | [Run](runs/20261023T034016Z-source-square-dot/index.md) | [Browser observations](runs/20261023T034016Z-source-square-dot/evidence/observations.json) |
| QA-086 | BLOCKED | source square-dot 83dcb99d | [Run](runs/20261023T034016Z-source-square-dot/index.md) | [Browser observations](runs/20261023T034016Z-source-square-dot/evidence/observations.json) |
| QA-087 | PASSED | source d1fe4c0 | [Run](runs/20261023T054616Z-source-d1fe4c0-retest/index.md) | [Browser observations](runs/20261023T054616Z-source-d1fe4c0-retest/evidence/observations.json) |
| QA-088 | PASSED | source d1fe4c0 | [Run](runs/20261023T054616Z-source-d1fe4c0-retest/index.md) | [Browser observations](runs/20261023T054616Z-source-d1fe4c0-retest/evidence/observations.json) |
| QA-089 | BLOCKED | source square-dot 83dcb99d | [Run](runs/20261023T034016Z-source-square-dot/index.md) | [Browser observations](runs/20261023T034016Z-source-square-dot/evidence/observations.json) |
| QA-090 | BLOCKED | source 59344f5 | [Run](runs/20261023T105500Z-source-scalable-overview/index.md) | [Browser observations](runs/20261023T105500Z-source-scalable-overview/evidence/observations.json) |
| QA-091 | BLOCKED | source 59344f5 | [Run](runs/20261023T105500Z-source-scalable-overview/index.md) | [Browser observations](runs/20261023T105500Z-source-scalable-overview/evidence/observations.json) |
| QA-092 | PASSED | source 59344f5 | [Run](runs/20261023T105500Z-source-scalable-overview/index.md) | [Browser observations](runs/20261023T105500Z-source-scalable-overview/evidence/observations.json) |
| QA-093 | BLOCKED | source 59344f5 | [Run](runs/20261023T105500Z-source-scalable-overview/index.md) | [Browser observations](runs/20261023T105500Z-source-scalable-overview/evidence/observations.json) |
| QA-094 | NOT_RUN | - | - | - |
| QA-095 | NOT_RUN | - | - | - |
| QA-096 | NOT_RUN | - | - | - |
| QA-097 | NOT_RUN | - | - | - |
| QA-098 | NOT_RUN | - | - | - |
| QA-101 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/healthy.txt) |
| QA-102 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/cpu-spin.txt) |
| QA-103 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/cpu-oversub.txt) |
| QA-104 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/cpu-throttle.txt) |
| QA-105 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/yield-storm.txt) |
| QA-106 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/lock-convoy.txt) |
| QA-107 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/deadlock.txt) |
| QA-108 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/mem-leak.txt) |
| QA-109 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/mem-oom.txt) |
| QA-110 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/vm-bloat.txt) |
| QA-111 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/fd-leak.txt) |
| QA-112 | BLOCKED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Recheck](runs/20261021T013000Z-source-384352f-bug-lab/evidence/qa112-recheck.txt) |
| QA-113 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/major-faults.txt) |
| QA-114 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/tcp-slow.txt) |
| QA-115 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/udp-drop.txt) |
| QA-116 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/close-wait.txt) |
| QA-117 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/listen-full.txt) |
| QA-118 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/thread-churn.txt) |
| QA-119 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/thread-leak.txt) |
| QA-120 | PASSED | source 384352f | [Run](runs/20261021T013000Z-source-384352f-bug-lab/index.md) | [Overview](runs/20261021T013000Z-source-384352f-bug-lab/evidence/stopped.txt) |

## QA-001: Package installation and live dashboard

- Test: Verify both package checksums. Extract into one isolated installation, start it, select an owned PID, and open the dashboard.
- Expected: No compiler is needed. The dashboard identifies the process and shows fresh threads without blocking application errors.

## QA-002: Add a target by PID

- Test: With QA-001 running, add a second owned PID with Add target on the Targets overview. Confirm, open its tile, and reload.
- Expected: Both targets remain live. The second process and its threads appear, and selection survives reload.

## QA-003: Invalid target input

- Test: From QA-002, try an empty process field and a nonexistent PID in the Add target dialog. Reload.
- Expected: Validation rejects both before confirmation. No target or saved configuration changes.

## QA-004: Wait for a named process

- Test: Add an absent exact process name of at most 15 bytes. Start that process, then stop it. Also change an existing target with `scripts/set-target.sh ID NAME`.
- Expected: The name is accepted. Absence becomes live data on start. Exit preserves the final view until Show live, including after the selector change.

## QA-005: Thread detail and recorded replay

- Test: With two recorded times available, open a live thread drawer, inspect both recordings and a recorded thread, then return to Live.
- Expected: Metrics match the selected thread and time. Recorded history ends at that time. Live updates resume.

## QA-006: Package upgrade preserves configuration and history

- Test: Record an older installation's custom ports, target, logs, and history. Stop it, extract verified newer packages over it, and restart.
- Expected: The new package keeps configuration, target, logs, and readable history. Record both versions; use BLOCKED if no older package is available.

## QA-007: Contextual help covers every dashboard section

- Test: With resource and memory data, hover each section, label, legend, chart, limit, zoom fact, and full-width table message for 1.2 seconds. Repeat during refresh and with keyboard focus.
- Expected: Each item opens specific help. Memory legends use their card's guide. Idle rows explain Active threads; other messages explain their panel.

## QA-008: Memory zoom legend matches the grid

- Test: Select heap, stack, anonymous, file, code, guard, and gapped regions. Compare grid colors with the legend before and after a mapping change.
- Expected: Only visible kinds appear. Heap is blue, stack orange, anonymous green, file yellow, code gray. Guards are hatched; gap and new-mapping entries appear only when applicable.

## QA-009: Interactive bugbench session

- Test: Use a test `--home`. Start bugbench-session; test next, previous, named scenarios, status, stop, CLI use outside the checkout, and a new conversation. Test invalid names and durations.
- Expected: One fixture runs at a time. Position persists and boundaries stop navigation. CPU quota is 50%; memory limit is 256 MiB with no swap. Invalid input preserves the running fixture. Unrelated services and dashboard selection remain unchanged.

## QA-010: Wire format overview

- Test: Open the wire-format HTML through both README links. Select all protocols, encode headers, and test 1, 10, 11, and 56 threads. Drop summaries and region parts, set 50% loss, and pause/resume.
- Expected: Headers are 48/64/64/80 B; rows are 112/160/64/80 B. TMON uses 1/1/2/6 chunks. TRES needs a summary; TVMA needs complete region parts and keeps its old layout when incomplete. TSIO counts received datagrams. Drops log once; no script errors occur.

## QA-011: Memory zoom page size and units

- Test: Use 4 KiB, 64 KiB, missing, invalid, stale, and wrong-target page metadata. Select regions, then change target and sampler session.
- Expected: Valid metadata sets page counts. Unknown sizes use bytes. Cached size survives staleness only within its target and session. Binary units are correct; the grid has at most 512 cells.

## QA-012: Memory growth facts refresh and reset

- Test: Select heap and stack. Supply unchanged, growing, contracting, stale, and delayed-layout samples. Change target and session.
- Expected: Each sample refreshes size change and interval. Missing data produces no growth value. Identity changes reset comparisons; outlines refer to the previous layout.

## QA-013: Largest unmapped gap and unknown coverage

- Test: Compare contiguous and separated regions, including addresses above `2^53`. Repeat with partial, truncated, stale, and delayed layouts. Read gap help.
- Expected: Largest gap matches address ranges, including zero. Incomplete coverage is unavailable. Help distinguishes address gaps from allocator free blocks.

## QA-014: Memory boundary charts

- Test: Grow and contract heap and main stack, with unchanged and missing samples. Use addresses above `2^53`; change target and session. Open chart help.
- Expected: Page-sized offsets remain exact. Stack growth lowers its start. Charts use steps, break at missing data, and reset by identity. Help explains heap page alignment.

## QA-015: Compact memory zoom and thread-stack help

- Test: Open zoom on wide and narrow screens. Inspect facts, legend, charts, member-region disclosure, and thread-stack help.
- Expected: Facts and charts stay visible and readable. Regions are in a disclosure. Help distinguishes fixed stack reservation, resident pages, and stack depth.

## QA-016: Bounded heap display margin

- Test: Grow and contract a heap with a neighboring mapping. Repeat with stale, incomplete, and delayed layouts, then change target.
- Expected: Display margin is capped and avoids neighbors. Facts describe mapped heap only. Invalid coverage hides the margin; target changes reset it. The grid stays within 512 cells.

## QA-017: Late resource samples retain memory history

- Test: Receive memory samples before resource metadata. Then deliver valid page size, stale resource data, and another target's data.
- Expected: Valid late metadata preserves memory history. Stale data does not erase a known page size. Other-target metadata is excluded.

## QA-018: Live anonymous growth stays distinct from brk heap growth

- Test: Grow anonymous mappings separately from the brk heap. Inspect live memory facts, charts, and help.
- Expected: Anonymous resident growth and heap-mapping growth remain separate. Neither is presented as allocator usage or proof of a heap leak.

## QA-019: Heap span remains stable across bounded changes

- Test: Select a heap near a file mapping. Apply small growth/contraction, stale and delayed coverage, neighbor removal, growth beyond the span, and a target change.
- Expected: Small changes retain grid span and cell count. Facts and outlines update. Invalid coverage hides margin; recovery restores span. Larger growth creates a bounded span with at most 1 MiB margin and 512 cells.

## QA-020: Current section tab

- Test: Navigate every section by pointer, keyboard, scrolling, direct URL, reload, Back, and Forward. Repeat in both themes, narrow width, and during layout changes.
- Expected: Exactly one visible section has the highlight and `aria-current="location"`. Settings is current at the page bottom. Help does not block navigation.

## QA-021: Dashboard HTTP server animation

- Test: Open the HTTP animation offline. Play all nine steps; pause, change speed, restart, and select each step. Compare the route table with `collector/http.hpp`.
- Expected: Diagram, caption, code, and source agree. Pause stops motion. Playback ends at step nine; step selection pauses; restart returns to step one.

## QA-022: HTTP animation access and small screens

- Test: Load the HTTP animation with reduced motion. Use keyboard controls, a 390-pixel viewport, and JavaScript disabled.
- Expected: Focus and accessible names remain clear. Reduced motion starts paused and hides the marker. Static diagram, route table, and source links remain usable without JavaScript.

## QA-023: Reason the target process ended

- Test: On Linux 6.15+, test owned SIGTERM, abort, and segfault exits with kernel logs restricted and readable. Restart repeatedly, inspect recordings, and select an absent new name.
- Expected: Exit card, assessment, and banner agree on available evidence. Unknown reasons stay explicit. Restart folds old exits; a new absent target does not inherit them. Stored exits and contextual help remain correct.

## QA-024: Sampler benchmark values and frequency controls

- Test: Open benchmark HTML with matching JSON. Select all frequencies, thread counts, grid metrics, and help. Compare cards, plots, downloads, and sampling-loop results with raw data.
- Expected: All 12 cases agree. Percentiles pool trials. Delivered throughput includes UDP; sampling-loop capacity excludes it. CPU uses one-core percent. Help states units and boundaries.

## QA-025: Sampler benchmark access and offline use

- Test: Open benchmark HTML offline with reduced motion. Use keyboard controls and help, Escape, motion controls, 390-pixel width, 200% zoom, and no JavaScript.
- Expected: Focus remains visible and stable. Reduced motion starts off. No page-wide overflow occurs. The full table and method remain available without JavaScript.

## QA-026: Final view after the target exits

- Test: Observe a busy target for five minutes, then kill it. Inspect trends, history, recordings, reload, a new tab, process restart, and Show live. Select a never-running target.
- Expected: The final process stays inspectable until Show live. History ends at exit; existing trends persist where available. Restart does not silently replace evidence. A never-running target shows absence without a final view.

## QA-028: Process details card

- Test: Compare Process details with `/proc` and `ps`. Test CPU affinity, restricted paths, replaced executables, long arguments, restart, target change, replay, and final view.
- Expected: Identity and paths match readable evidence. Missing paths give reasons; deleted and truncated text are marked. Replay and final runtimes use their timestamps. Old details never appear under a new target.

## QA-029: Summary CPU and memory trends

- Test: Observe RSS growth for two minutes. Select 1/5/15-minute windows, chart help, replay, and Live. Disable memory-map sampling and restart.
- Expected: Memory trends share the load window and correct binary units. Values agree across sections. Replay hides live trends. Disabled VmSize shows a reason instead of empty axes.

## QA-030: Default thread sampling rate and saved settings

- Test: Start with no active configuration, then omit sampling keys. Verify wire tick intervals. Save 1 Hz, resource interval 5 s, and memory interval 60 s; restart and upgrade the package.
- Expected: New or omitted settings use 5 Hz, 2 s resources, and 30 s memory. Wire tick intervals are 200 ms at 5 Hz and 1000 ms at 1 Hz. Explicit saved values survive restart and upgrade.

## QA-031: Complete sanitizer test runs

- Test: Install supported sanitizer tools. Run `make -j2 check-sanitizers` from a clean checkout; inspect both logs. Then run `make check` and `make check SANITIZER=thread STATIC=1`.
- Expected: Address/undefined and thread modes each run six C++ tests plus Python and dashboard tests. Allocation counts are zero. Findings fail the command. Normal checks pass; static sanitizer mode fails before compilation. Privileged eBPF remains opt-in.

## QA-032: Named periodic workers match configured wake intervals

- Test: At 10 Hz, run `MsgP-fast`/`MsgP-peer` with 1 s timers, `PrdDist-main`/`PrdDist-peer` with 2 s timers, and `Control-idle` with a 1 s timer. Configure prefixes `MsgP`/`PrdDist` with `wake_ms` 1000/2000, without `*` or saved overrides. Compare nine live views over eight seconds with fixture counters and schedstat.
- Expected: All five names appear; interval is 100 ms and rule source is config. Matching wake intervals are 1000/2000 ms; control is null. Every worker advances `last_ran`, including sampled sleepers. Allow one sample interval plus 0.25 s buffering and 0.5 s browser refresh.

## QA-033: A watched worker stops waking but remains alive

- Test: After QA-032, stop only `MsgP-fast`'s timer loop and block it on an Event. Read five live views three seconds apart, All threads, assessment, counters, and schedstat.
- Expected: The same TID stays present in futex wait with `wake_ms = 1000` and `stale = false`. `last_ran` stays fixed while `last_sample` advances. Peers remain normal; assessment reports the missed wake and elapsed time.

## QA-034: Watched thread stops waking

- Test: Watch deadlocked `worker-` threads with `wake_ms` 500. Inspect finding, thread, and help. Change to 3600000, pause sampler for 30 seconds, inspect replay, and remove rules.
- Expected: Missed wakes use observed activity and rule thresholds. Silence is not thread failure. Replay uses recorded evidence. Large thresholds and removed rules clear the applicable finding.

## QA-035: Watched thread busy loop and rule with no match

- Test: Run cpu-spin. Watch `worker-spin` at 500 ms and absent `gone-` at 200 ms. After ten seconds inspect findings and help. Replace with `misc-` at 1000 ms, then select a process without that thread. Stop it and inspect the final view.
- Expected: The watched spin gets a serious running-instead-of-sleeping finding without duplicate generic saturation. Unwatched `worker-poll` keeps saturation. Missing rules warn only after threads arrive; on-schedule misc clears the warning. Final views have no unmatched-rule warning.

## QA-036: Edit, save and reset watched-thread rules in Settings

- Test: In Settings, add, edit, disable, save, reload, and reset watch rules. Try invalid and duplicate input. Inspect the thread view and persisted file.
- Expected: Valid rules persist and affect the correct target. Invalid input preserves saved rules. Reset restores configuration defaults; help explains shared scope.

## QA-037: Settings tab read-only states and help coverage

- Test: Inspect every Settings label and control with hover and keyboard help. Keep an unsaved edit while opening replay, returning Live, blocking `/api/watches`, stopping the collector, and exiting/restarting the target.
- Expected: Replay is read-only and preserves the draft for Live. Missing watches names the endpoint and suggests collector.toml. Failed Save preserves edits and reports connection failure. Match counts are zero in replay/final view and recover with live threads. Existing alert settings remain available when present.

## QA-038: Timeline and past assessments show a recorded finding

- Test: Record a CPU-spin finding, then recover. In Timeline, select its row and mark, step with keyboard, return Live, and filter by severity and type.
- Expected: Recorded assessment, thread, timestamp, and row agree. Stepping selects real recordings. Filters affect rows and marks consistently; Live resumes current data.

## QA-039: Earlier Timeline periods, empty states, and help

- Test: Use two hours of recordings and an empty installation. Load earlier by scrolling and controls. Interrupt the test collector during loading; restart and retry. Inspect help by pointer and keyboard.
- Expected: Earlier data appears without duplicates. Empty, loading, and failed states are explicit. Errors can be retried. Help explains sampling limits and navigation.

## QA-045: Concurrent viewers and slow connections

- Test: Open 20 independent Chrome profiles or devices on one test installation. Hold one HTTP request idle and send another incomplete header one byte per second. Observe ten seconds, inspect replay in one view, then restart the collector.
- Expected: Other viewers keep refreshing. Incomplete requests close after the total five-second read deadline. Replay stays local. Every view identifies the outage and recovers fresh data; automated HTTP tests alone do not satisfy this case.

## QA-046: Conflicting watch-rule saves and resets

- Test: Prepare different watch edits in two views. Save A, then stale B; repeat with stale Reset. Test cancel, failed and confirmed Reload current rules, and saving a draft after collector restart. Read help.
- Expected: Stale save/reset returns HTTP 409 without changing rules. Draft survives; Save and Reset stay disabled until reload. Cancel or failed reload preserves it. Confirmed reload replaces the draft. Restart invalidates earlier drafts; help explains recovery.

## QA-047: Simultaneous live dashboard viewers

- Test: Open two independent views of one owned live target. Observe identity, connected state, advancing chart times, and fresh data for at least 20 seconds.
- Expected: Both views receive live updates without displacing each other.

## QA-048: Local search and replay state

- Test: From QA-047 with recording and two targets, filter and replay in A while B stays live. Change B's selected target.
- Expected: Search, replay, and target selection remain local to each view.

## QA-049: Shared target set and another viewer's Manage targets

- Test: With two views, keep A in replay while B adds another target. Return A to Live, then open Manage targets in A.
- Expected: A keeps its selection and recording. Both see the shared target set; loaded controls operate on current configuration.

## QA-050: New viewer and stored history

- Test: Record for several minutes in A, then open B with empty storage. Compare trends, open an older recording in B, and return Live.
- Expected: B sees the current target. Local trends start when B opens; stored recordings predate it. B does not change A.

## QA-051: Two viewers after a collector outage

- Test: With two live viewers, stop only the test collector for 15 seconds. Restart it with the same configuration and data.
- Expected: Both viewers show stale or unavailable data and recover fresh updates. Record any required reload.

## QA-052: Independent browser engines and profiles

- Test: Repeat QA-047 and QA-048 in independent Chromium and Firefox profiles, then Safari on an available Apple device. Change the shared target set.
- Expected: Viewer-local and shared behavior agrees across tested engines. Record actual versions. Unavailable engines stay unrun; two tabs of one engine are insufficient.

## QA-053: Concurrent saved thread watch edits

- Test: In two independent views of saved watches, prepare different additions from the same initial list. Save A, then stale B; reload.
- Expected: B preserves A's rule or reports a conflict before replacement. Record final rules and order. Leave NOT_RUN if the package lacks saved watches.

## QA-054: Assessment first and folded panels

- Test: Clear site storage. Inspect healthy and warning layouts above and below 1050 pixels. Toggle all folded panels by pointer and keyboard, reload, and dismiss an automatically opened warning panel.
- Expected: Assessment is first and visible. Panels preserve user choices. Unchosen panels open for relevant warnings; manually closed panels stay closed. All headings have help.

## QA-055: Dashboard appearance and summary layout

- Test: Test healthy and CPU-spin Summary at desktop and 390 pixels, 200% zoom, all themes, keyboard access, replay, blocked storage, unavailable collector, and more than eight findings.
- Expected: Layout and focus remain readable without page-wide overflow. Theme persists when possible. System follows the OS. Every finding stays accessible; unavailable data is neutral.

## QA-056: Help names the source of each value

- Test: Hover CPU, run delay, and state; open guides for PSI, descriptors, queues, network, memory, and exit status. Run two source commands. Check controls, dark theme, and narrow width.
- Expected: Measured values identify source, field, reader, interval, and calculation. Commands agree with the metric. Controls need no measurement source. Paths wrap readably.

## QA-057: Network counter column names

- Test: Inspect Rate (/s), In range, and Total in Network stack drops & errors. Read help, change range, and test missing history.
- Expected: Help distinguishes rate, selected-range count, and cumulative counter with shared scope. Missing history is unavailable, not zero.

## QA-058: Target API selection

- Test: With two announced targets, read `/api/targets`, each selected live/resource/replay API, and an unknown key. Replace one process. Compare default and explicit selection.
- Expected: Responses isolate target PID and session; only the replaced process changes session. Unknown keys return 404. Omitted selection uses default when present, then the first key by host and ID.

## QA-059: Multiple sampler targets and reload

- Test: Configure multiple owned targets under one sampler. Add, remove, and change a target, then reload valid and invalid configuration.
- Expected: One sampler continues. Unchanged targets keep their sessions. Changed targets receive correct data. Invalid reload preserves running configuration.

## QA-060: Sampler CPU budget

- Test: Measure one sampler's CPU at several rates and budgets with fixed workloads. Observe throttling, sustained low load, and recovery.
- Expected: The effective rate and budget badge match measured behavior. Sessions remain stable. Record overhead and cases where minimum rate still exceeds budget.

## QA-061: Per-tab target selection

- Test: Open different targets in two tabs. Switch, reload, follow an explicit target URL, and inspect the picker. Open a new tab at the dashboard URL without `?target=`.
- Expected: Each tab retains its own target. Links open that target; switching does not alter monitoring or another tab. A tab without `?target=` opens the Targets overview, not the last target.

## QA-062: Manage local targets

- Test: On the Targets overview, use Add target and Remove on tiles to add and remove owned PIDs and names. Cancel confirmations; try invalid IDs, duplicate IDs, and removing the last target. Open help from the dialog at a width below 1,200 px. Check a remote dashboard and a stopped sampler.
- Expected: Confirmed valid changes affect the shared set, and other open overviews update their Remove buttons on the next poll. Cancellation and invalid input preserve configuration and active targets. Remove is disabled on the last target and absent on remote hosts. Help works inside the dialog. A remote dashboard or stopped sampler shows no error until the user acts.

## QA-063: Target access and sampler budget badges

- Test: Observe limited-access and throttled targets. Compare badge CPU, effective rate, and budget with the API. Make an unselected target absent/silent; switch selection. Check help by keyboard in both themes.
- Expected: Badges distinguish access limits and shared sampler budget. Attention counts exclude the selected target. Scope remains clear and help does not change selection.

## QA-064: Per-target watch settings and recordings

- Test: Set different saved watch rules for two targets. Record both, switch targets, replay, and restart the collector.
- Expected: Rules and recordings stay with their target across switching and restart. No other target's rules or process data appear.

## QA-065: Target control commands

- Test: With two named targets, run `scripts/set-target.sh ID NAME|PID`, `--add`, `--remove`, rate control, and `--help`. Try invalid/duplicate IDs and removing the last target.
- Expected: Valid commands reload the same sampler. Selector changes affect only their target; rate changes keep all target IDs. Invalid input and help preserve configuration.

## QA-066: Socket reports across hosts

- Test: Use optional socket observers on two hosts, including matching local target IDs. Query live and stored reports for each.
- Expected: Reports distinguish host, target, session, and observer. No counters are mixed. Record BLOCKED when required hosts or tracing support are absent.

## QA-067: Single-target install after a collector-only upgrade

- Test: Keep a pre-multi-target sampler and configuration with history, recordings, and watches. Upgrade only the collector; compare default and explicit APIs, QA-005, QA-036, and ten minutes of retention.
- Expected: Old configuration works. One default target retains PID, history depth, recordings, and watches without new picker or budget badge. API selection remains compatible.

## QA-068: Sampler upgrade with an unchanged single-target configuration

- Test: After QA-067, upgrade the sampler with unchanged configuration. Restart each component separately, then start the sampler five seconds before the collector. Compare memory, history, rules, CPU, and RSS.
- Expected: One default target keeps earlier data. Outages create only expected gaps. Memory returns promptly; baseline CPU stays comparable. Default budget does not throttle a small workload.

## QA-069: Change the single target through the API and scripts

- Test: After QA-068, switch A/B by legacy target API, PID/name scripts, and rate scripts. Test absent names, empty input, and nonexistent PID. Repeat after adding/removing a second target, then with remote/non-loopback settings.
- Expected: Single-target controls remain compatible and preserve history and watches. Invalid input changes nothing. Remote or non-loopback setups refuse target changes.

## QA-070: Shipped and earlier configuration files

- Test: Start with shipped and earlier configurations, scalar and list sampler IPs. Test target limits 0/65 and 8 targets with 2,000,000 samples each. Reload an invalid target table.
- Expected: Valid configurations start unchanged. Invalid capacity values name the key and fail startup. Invalid reload preserves active targets.

## QA-071: Two or three targets: add, remove, and re-add

- Test: Use local Manage targets with two or three owned processes. Add, remove, and re-add one target while another tab observes a different target.
- Expected: Other targets and sessions remain stable. Removed data does not become another target's data. Re-added targets recover correctly.

## QA-072: Freed target slots and a paused sampler

- Test: Fill collector slots, remove a target, and add another. Pause and resume a sampler; compare live targets and stored timeline identities.
- Expected: Freed slots are reusable. Paused or removed targets do not mix sessions or contaminate new-target history. Silence and absence remain distinct.

## QA-073: Five production targets remain separate

- Test: Monitor healthy, cpu-spin, mem-leak, fd-leak, and deadlock as `control`, `cpu`, `memory`, `fds`, and `locks`. Enable resources and memory; inspect each and a second tab, then reload an explicit URL.
- Expected: One sampler reports five separate processes. Threads, CPU, memory, limits, and waits match selection. Another tab keeps its target. Shared counters state their scope.

## QA-074: One of five production processes stops and restarts

- Test: From QA-073, select by exact name. Stop and restart only deadlock while locks and control remain open. Inspect the final view, then Show live.
- Expected: Only locks becomes absent. Its old PID and evidence remain until Show live. The replacement has a new PID; other targets remain live.

## QA-075: Thread drawer preserves a target URL

- Test: Open a nondefault target URL and a thread. Close with Escape and with Close thread details. Open the resulting URL in a fresh profile.
- Expected: Closing removes only the thread fragment. The target query remains, and the fresh profile opens the same process.

## QA-076: Add and remove a sixth investigation target

- Test: From QA-073 with a free slot, add `extra`: cancel, then confirm. Remove it, then try an existing ID. Observe another tab and the sampler PID.
- Expected: Cancel changes nothing. Confirmed changes reach both pickers without another sampler. Duplicate IDs fail and preserve existing targets.

## QA-077: Five-target diagnosis includes the fault findings

- Test: From QA-073, inspect healthy, CPU, locks, descriptor, and memory findings. Keep memory open for 70 seconds; observe deadlock for at least 70 seconds.
- Expected: Findings identify the correct process: hot worker, possible stuck wait, descriptor exhaustion, and sustained RSS growth. Healthy stays free of process-fault warnings. No deadlock proof is claimed.

## QA-078: Collector target capacity with five active processes

- Test: Start five targets with collector `max_targets = 5`. Try a sixth through Manage targets; remove one, then retry.
- Expected: Capacity rejection is clear and preserves active targets and configuration. The new target becomes live after a slot is free, without mixed process data.

## QA-079: Kernel crash message on WSL2

- Test: On WSL2 with readable kernel logs and a nested PID namespace, cause owned OOM and segfault exits. Compare dashboard PID with the outer PID in kernel messages.
- Expected: The card identifies OOM and segmentation fault. Relevant kernel lines are retained despite differing PIDs; it does not claim no crash message.

## QA-080: Thread state colors agree across views

- Test: Use cpu-spin. Compare states in thread map, chart, pills, recent mix, wait bars, drawer, and history. Test all themes, filters, Other, No access, and historical-only states.
- Expected: Running is blue; Sleep is green. Other and No access have distinct grays. Mixed wait groups are neutral. Legends, filters, and help agree across views.

## QA-081: Past assessments show resident memory growth

- Test: Record mem-leak for at least three minutes, then stop growth or exit. Open the dashboard later; filter past assessments to Memory, select the growth row, and load earlier periods.
- Expected: The leak has a Memory row and timeline mark. Recorded assessment and RSS growth agree. The row persists in earlier periods, allowing less exact times.

## QA-082: Targets overview lists every target

- Case revision: 3.
- Test: Run two bug-lab workloads as targets and one absent named target. Open the dashboard URL without `?target=`. Read each tile.
- Expected: The Targets overview opens. Each tile face shows only one assessment dot, the process name, `host · id`, and an optional Remove button. No verdict, finding title, no-live-view message, PID, metrics, access badge, or throttle badge appears on the face. The assessment remains available to assistive technology. The issue card and target dashboard show process details. Targets with the same process name remain distinguishable by host and ID.

## QA-083: Tile order, colors, and counts

- Case revision: 2.
- Test: Use targets at critical, serious, warning, healthy, and no-data levels. Include live targets with findings. Compare each assessment dot with its tile edge, count pills, and the tab title.
- Expected: Tiles are worst first, then by key. Dot and edge both use red for critical, orange for serious, amber for warning, green for healthy, and gray for no data. A live target with findings does not get a green activity dot. Each dot has the corresponding accessible assessment label and native title. Counts match the tiles. The title starts with the number of targets at warning or worse.

## QA-084: Navigate between the overview and a target

- Test: Select a tile, use All targets, use browser Back, and middle-click a tile.
- Expected: Each route opens the expected page. Middle-click opens the target in a new tab. `?target=` with no value opens the default target.

## QA-085: Empty overview and lost collector

- Case revision: 2.
- Test: Open the overview with no targets. Add live targets and a target without a live view. Stop the collector while the page is open, then start it again.
- Expected: With no targets, the page says so. A target without a live view has a gray assessment dot and its identity, with no message on its face. While the collector is down, a banner says the data is stale. The tiles return after the collector does.

## QA-086: Hidden tab polls nothing

- Test: Open the overview with several targets and watch network requests. Switch to another tab during a poll, wait 30 s, and return.
- Expected: No `/api/live` request starts while the tab is hidden. Polling resumes within 5 s after return.

## QA-087: Overview themes and tile spacing

- Case revision: 5.
- Test: View the overview in Dark, Light, and System themes at desktop, 390 px, and 320 px widths, in both Tiles densities. Include long process names and host/target identities. Measure target tiles, Add target, and grid gaps. Point at a long name and read the link's accessible name. Check Remove placement.
- Expected: Dark uses the matte black canvas and tiles. Light uses light tiles. In Comfortable, target tiles and Add target have a 140 px minimum height and grid gaps are 24 px. In Compact, the minimum height is 104 px and gaps are 16 px. Tiles grow when long identity text needs more room. No fixed aspect ratio forces empty height. Host and target identities wrap within the tile. A long process name may stay on one line with an ellipsis; the link's title and accessible name give the full name. Remove stays at the bottom right. Text and controls remain readable. Nothing scrolls sideways at 390 px or 320 px.

## QA-088: Keyboard focus and help on the overview

- Case revision: 2.
- Test: Tab through tiles and their Remove and help buttons. Wait for two polls with focus on each. Press Enter on a tile link. Open the `fleet` and `fleet-tile` help.
- Expected: Focus is visible and survives polls. Enter opens the target. The dot and target link expose the assessment to assistive technology. Both help topics open and say that tiles do not run trend rules. Tile help describes the minimal face and says that the dot shows assessment, not sampler activity. It directs users to the card or dashboard for process details.

## QA-089: Select one of several processes with the same name

- Test: Start two owned processes with the same name. In Add target, enter a new ID and that name. Select the second process, add it, then open Add target again. Repeat with more than 20 matching processes.
- Expected: The configuration does not change on the ambiguous name. Matching processes lists PID, user, start time, and command line, at most 20, and the status gives the full count. A choice fills in its PID and warns that a PID does not follow a restart. The chosen PID is added. A new dialog or a later local error hides the list.

## QA-090: Findings card on a tile

- Test: Use one target with findings and one healthy target. Point at each tile, move quickly across the grid, and Tab to a tile link. Select a tile while its card is open.
- Expected: Only a tile with warning or worse findings shows a card, after a short delay, with the process start time, command line, and up to four findings with details. No card flashes during quick movement. Keyboard focus shows the card, and the tile keeps its values until focus leaves. A click still opens the dashboard.

## QA-091: Overview tile density

- Setup: `python3 tests/fleet_fixture.py --targets 64` starts an isolated collector with deterministic targets and prints its URL and the expected levels. Use `--targets 20` and `--targets 50` for the other counts. It cannot produce No data; make one `/api/live` request fail for that level.
- Test: Open the overview with 20, 50, and 64 targets at 320, 390, 1280, and 1920 px widths. Select Compact in Tiles, then Comfortable. Reload after each choice, and change the number of targets between polls. Repeat with browser storage blocked. Open the `fleet-density` help.
- Expected: Comfortable is the default. Comfortable tiles have a 140 px minimum height and 24 px gaps; Compact tiles have a 104 px minimum height, 16 px gaps, and 12 to 14 px padding, with the same text sizes and controls. Compact shows more full tiles on one screen at 1280 and 1920 px. The choice survives reload. Polls and target count changes never change it. With storage blocked, the choice lasts until reload. Nothing scrolls sideways; the page scrolls vertically.

## QA-092: Overview search and status

- Test: Use the QA-091 fixture with 64 targets at critical, serious, warning, healthy, and no-data levels, with long identities and the same process name on different hosts. Search by name, host, and target ID. Select each Status choice. Combine a search and a status that match nothing. Watch network requests while typing. Wait for two polls with focus on a shown tile. Select Clear filters. Open the `fleet-filter` help.
- Expected: Only matching tiles show, worst first. Needs attention shows critical, serious, and warning tiles. "Showing N of M targets" gives the matching count and the count of all targets. The count pills, labeled "Totals for all targets", do not change with filters. Typing starts no request. Polls keep the filter, the tile elements, and keyboard focus. With no match, the page says so, and Clear filters and Add target remain usable. Clear filters shows every tile. Nothing scrolls sideways at 320 px.

## QA-093: A filtered overview survives navigation

- Test: Filter the overview by search and status. Open the URL in a new tab. Open a tile, then use browser Back. Open a tile again and use All targets. Middle-click a tile and use All targets in the new tab. Repeat with browser storage blocked.
- Expected: The URL carries `q` and `status`. Each path returns to the overview with the same search, status, and matching tiles. Blocked storage affects only the saved tile density.

## QA-094: One matte black theme on every page

- Test: Open the overview and the dashboard of one target in Dark, Light, and System themes (system set to dark). On the target dashboard, open help, a chart tooltip, and an expanded section. Repeat at 390 px.
- Expected: In dark, both pages use the same matte black canvas and cards, with no blue-tinted panels. Charts, state colors, status colors, and text stay readable. Light is unchanged.


## QA-095: Thread panels stay still under the pointer during live polling

- Test: Monitor a target with at least 20 busy threads. In the thread map, select 5 min. Hold the pointer on one tile for 10 s, then move into its card. Do the same on a wait-channel bar and on a table cell. Move from Read/s to Write/s on one row. Hold the pointer on the CPU cell of a thread that has no rate after a sampler pause. Focus a table row, scroll the table, and change the sort. Open a thread, select a custom History range, close the drawer, and open another thread.
- Expected: Under the pointer and in its card, the tiles, bars, and rows do not move, and the card values do not change. When the pointer leaves, the panel shows the latest data. The Write/s card shows the Write/s value. A missing rate shows "Not available". The focused row keeps the focus and the table keeps its scroll position across polls and the sort change. The second thread uses the same custom range.

## QA-096: Resource panels stay still under the pointer and follow the controls

- Test: Monitor a target with resource sampling on, open sockets, and network activity. Hold the pointer on a Pressure stalls table cell, a Network stack drops & errors row, and a Fullest sockets cell for 10 s each, then move into each card. Focus the Fullest sockets checkbox, scroll the table, and clear the checkbox. Select 1 h, then 6 h; change the pressure scope to Whole host. Restart the target process while the pointer holds the sockets table.
- Expected: Under the pointer and in its card, rows, values, and readouts do not change; after the pointer leaves, each panel shows the latest sample, and active network counters move first. The checkbox keeps focus, the table returns to the top, and the filter applies at once. Range and scope changes clear chart readouts, refresh the charts and In range at once, and change the Summary findings that use pressure and RSS history. After the restart, no row of the old process remains, and the panel waits for a sample of the new process.

## QA-097: Socket I/O panel states, filters, and observer changes

- Test: Monitor a target with the optional socket observer and a completion marker. Check Received, Sent, and Messages processed, a socket kind, and a thread search. Hold the pointer on a breakdown cell for 10 s, then press Escape twice. Scroll the breakdown, then type in the search. Open What is measured · setup. Stop the observer, restart it, and restart the target process. Repeat without the observer and with a collector build that has no socket endpoint.
- Expected: Cards and chart show the whole process; filters change only the breakdown, keep focus, and start it at the top. Messages processed disables Socket kind, and Received restores the kind if it still exists. A held row and its card do not change during polls; the first Escape closes the card and the second does nothing else. Retired thread generations are separate rows, and no row opens a thread drawer. Observer silent, Observation ended, lower-bound, and cached states are named. After an observer or process restart, no row or card of the old one remains. The setup details stay open. Without the observer, the panel names the reason.

## QA-098: Memory map stays still under the pointer and resets for a new process

- Test: Monitor a target with memory sampling on (`memory_interval_s` set). Open Address space & zoom and Member regions. Hold the pointer on an address-space bar and on a zoom grid square for 10 s each, then move into each card. Click the stack bar, then the heap bar, while the target grows its heap past the display margin. Focus a bar, press Escape twice, and scroll the Member regions table. Restart the target process while the pointer holds the address map and the bar keeps focus. Repeat after a sampler restart.
- Expected: Under the pointer, the bars, zoom facts, grid, and charts do not change; after the pointer leaves, each part shows the latest sample at once. A click selects the bar during polls, and the heap grid keeps its span until the heap leaves the margin. The first Escape closes the card and the second does nothing else. After a target or sampler restart, no bar, address, readout, card, or chart point of the old process remains, the fold and Member regions stay open, and the section waits for the new layout. Tiles, findings, limits, and Summary memory findings use the same samples.
