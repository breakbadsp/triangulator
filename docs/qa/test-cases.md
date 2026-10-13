# Manual test cases

These cases describe documented behavior. Current results link to versioned runs.
A dash in Tested package version means no package has been tested.
See [Senior Manual QA](../manual-qa.md) for invocation, package setup, and
[how to check results on GitHub](../manual-qa.md#check-results-on-github).
Use the PR #47 `bug-lab/bugbench.c` sample workload for owned test processes.
The [bug lab cases](bug-lab-cases.md) define QA-101 through QA-120.

## Current results

| Case ID | Status | Tested package version | Run | Evidence |
| --- | --- | --- | --- | --- |
| QA-001 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Live page](runs/20261011T110000Z-ci-5189c47/evidence/qa001-live.txt) |
| QA-002 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Second target](runs/20261011T110000Z-ci-5189c47/evidence/qa002-second.txt) |
| QA-003 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Validation page](runs/20261011T110000Z-ci-5189c47/evidence/qa003-invalid.txt) |
| QA-004 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Named target](runs/20261011T110000Z-ci-5189c47/evidence/qa004-2-running.txt) |
| QA-005 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Replay drawer](runs/20261011T110000Z-ci-5189c47/evidence/qa005-3-replay-drawer.txt) |
| QA-006 | BLOCKED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Release metadata](runs/20261009T035640Z-v0.1.0/evidence/release.json) |
| QA-007 | FAILED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Help sweep](runs/20261011T110000Z-ci-5189c47/evidence/qa007-help.json) |
| QA-008 | BLOCKED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Legend check](runs/20261011T110000Z-ci-5189c47/evidence/qa008-legend.json) |
| QA-009 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Session log](runs/20261011T110000Z-ci-5189c47/evidence/qa009-2-navigation.txt) |
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
| QA-027 | NOT_RUN | - | - | - |
| QA-101 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Healthy page](runs/20261011T110000Z-ci-5189c47/evidence/qa101-healthy.txt) |
| QA-102 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [CPU page](runs/20261011T110000Z-ci-5189c47/evidence/qa102-cpu-spin.txt) |
| QA-103 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Oversubscription page](runs/20261011T110000Z-ci-5189c47/evidence/qa103-cpu-oversub.txt) |
| QA-104 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Quota page](runs/20261011T110000Z-ci-5189c47/evidence/qa104-cpu-throttle.txt) |
| QA-105 | FAILED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Yield page](runs/20261011T110000Z-ci-5189c47/evidence/qa105-yield-storm.txt) |
| QA-106 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Contention page](runs/20261011T110000Z-ci-5189c47/evidence/qa106-lock-convoy.txt) |
| QA-107 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Futex page](runs/20261011T110000Z-ci-5189c47/evidence/qa107-deadlock.txt) |
| QA-108 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Growth page](runs/20261011T110000Z-ci-5189c47/evidence/qa108-mem-leak.txt) |
| QA-109 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Pressure page](runs/20261011T110000Z-ci-5189c47/evidence/qa109-mem-oom.txt) |
| QA-110 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Address-space page](runs/20261011T110000Z-ci-5189c47/evidence/qa110-vm-bloat.txt) |
| QA-111 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Descriptor page](runs/20261011T110000Z-ci-5189c47/evidence/qa111-fd-leak.txt) |
| QA-112 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Storage page](runs/20261011T110000Z-ci-5189c47/evidence/qa112-disk-sync.txt) |
| QA-113 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Fault page](runs/20261011T110000Z-ci-5189c47/evidence/qa113-major-faults.txt) |
| QA-114 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [TCP page](runs/20261011T110000Z-ci-5189c47/evidence/qa114-tcp-slow.txt) |
| QA-115 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [UDP page](runs/20261011T110000Z-ci-5189c47/evidence/qa115-udp-drop.txt) |
| QA-116 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Socket page](runs/20261011T110000Z-ci-5189c47/evidence/qa116-close-wait.txt) |
| QA-117 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Listen page](runs/20261011T110000Z-ci-5189c47/evidence/qa117-listen-full.txt) |
| QA-118 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Churn page](runs/20261011T110000Z-ci-5189c47/evidence/qa118-thread-churn.txt) |
| QA-119 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Thread-growth page](runs/20261011T110000Z-ci-5189c47/evidence/qa119-thread-leak.txt) |
| QA-120 | PASSED | PR65 5189c47 (CI) | [Run](runs/20261011T110000Z-ci-5189c47/index.md) | [Stopped page](runs/20261011T110000Z-ci-5189c47/evidence/qa120-stopped-stopped.txt) |

## QA-026: Final view after the target exits

Feature: Dashboard target exit. Priority: High. Case revision: 2.

Preconditions: Start `bug-lab/bugbench.c` with a busy scenario and monitor its
PID. Keep the dashboard open for at least five minutes.

1. Kill the process. Within a few seconds, verify the **Show live** banner, the
   top-bar state "Stopped reporting", and that threads, summary charts, resource
   charts and the memory map still show the last values. Charts end at the exit.
   With the kernel log readable, verify the banner, **Last process exit** and the
   Assessment name the same exit reason (QA-023).
2. Select the 15 min chart window. Open a thread and check its stored history
   ends at the exit time.
3. Start another target, then reload the page. Verify the same final view,
   trends and memory-map regions return.
4. Use **Inspect a moment** on an earlier time, then select **Live**. Verify the
   final view returns, not an empty page. Repeat with a live target: open a
   recording, kill and restart the process, then select **Live**. Verify the
   final view of the old process appears, not the new process.
5. Open a new browser tab. Verify it shows the final view without earlier
   trends.
6. Start a new target. Verify the banner names its PID and the final view stays.
   Select **Show live** and verify the new target appears and the banner closes.
7. Use **Change target** to select a process name that is not running. Verify no
   final view appears in that tab. Repeat while a final view is shown and a new
   target is monitored.
8. Pause over the banner. Verify its help explains the final view and its limits.

Expected results: The exited process stays inspectable until **Show live**.
Nothing is cleared silently. A deliberate target change in the same tab is not
reported as an exit.

## QA-021: Dashboard HTTP server animation

Feature: HTTP server documentation. Priority: Medium. Case revision: 1.

Preconditions: Download `docs/dashboard-http-animation.html`. Open it in a
browser with JavaScript enabled. No collector or network is required.

1. Play all nine steps. Inspect the diagram, caption, code, and source name.
2. Pause during a step. Verify that the data marker and progress stop.
3. Select Previous, Next, Restart, and each numbered step. Change the speed.
4. Expand the API route table. Compare its paths with `collector/http.hpp`.

Expected results: Captions and highlighted parts match the selected step.
The sequence shows embedded HTML, separate HTTP and receive threads, shared
JSON, SQLite history, and connection closure. Playback ends at step nine.
Selecting a step pauses playback. Restart returns to step one.

## QA-022: HTTP animation access and small screens

Feature: HTTP server documentation. Priority: Medium. Case revision: 1.

Preconditions: Open the animation in a browser. Enable reduced motion before
loading the page.

1. Verify that playback starts paused and the moving marker is hidden.
2. Use Tab and Enter to select playback controls, steps, and the route table.
3. Set the viewport to 390 pixels wide. Read captions and use each control.
4. Disable JavaScript and reload. Inspect the diagram and route table.

Expected results: Controls have visible focus and accessible names. Each step
remains readable. The diagram can scroll horizontally on a small screen.
Reduced motion hides the marker even during playback. Without JavaScript,
the static diagram, route table, and source links remain available.

## QA-023: Reason the target process ended

Feature: Process exit reasons. Priority: High. Case revision: 2.

Preconditions: The dashboard is open with live samples. Use an owned test
process on Linux 6.15 or later. Run two passes on the target host: one with
`kernel.dmesg_restrict = 1` and one with `kernel.dmesg_restrict = 0`.

1. With the log restricted, check the sampler log first: when it finds the
   target, it warns that the kernel log is not readable. Then end the target
   with `kill -TERM`.
2. Verify the Last process exit card shows the process name, PID, end time,
   "Killed by SIGTERM", "Exit status: SIGTERM (signal 15)" and that the kernel
   log was not readable. Verify Kernel messages is hidden. Start a target
   that calls `abort()` and verify "Crashed: SIGABRT" with "core dumped".
3. With the log readable, start an owned target that writes through a null
   pointer after a few seconds, for example `sleep(5); *(volatile int*)0 = 1;`.
4. Verify the card shows "Segmentation fault" and that Kernel messages
   contains the segfault line with a thread ID from the threads table.
5. Verify the Assessment says "Target process ended · Segmentation fault".
6. Restart the target. Verify the card folds to one line with the reason,
   the old PID and how long ago, and the Assessment no longer reports the
   target as absent. Open the line and verify the details. Crash and restart
   the target three more times. Verify the card opens while each crashed
   process is absent, folds once the next one runs, and the line counts the
   exits since the collector started.
7. End the target again, then change the target to a PID or name that does
   not exist. Verify the Assessment says "Target process is absent", not
   "Target process ended", and the header does not use the ended process's
   name.
8. Open Inspect a moment after the exit. Verify the card shows the recorded
   exit. Return to Live.
9. Hover over the card heading, the reason, Exit status and Kernel messages.
   Verify each opens its help topic, and that the help says a missing message
   does not prove the process did not crash.

Expected results: The card names the reason the kernel logged, else the
signal or exit code that ended the process, or says why it is unknown. An
earlier exit of a process that has been restarted is one folded line. Kernel messages show only lines that name the process or its
threads. The `process_exit` table in the day file has one row per ended
process.

## QA-020: Current section tab

Feature: Dashboard navigation. Priority: Medium. Case revision: 1.

Preconditions: The dashboard is open with live samples.

1. Open the page at the top. Verify that Summary is highlighted.
2. Select each section tab. Verify that exactly one tab is highlighted and has
   `aria-current="location"`. Use the keyboard to select a tab.
3. Scroll down and up through the sections without selecting tabs. Verify that
   the highlight follows the section below the header.
4. Scroll to the bottom. Verify that Monitor is highlighted.
5. Open a section URL directly. Reload it and use browser Back and Forward.
   Verify that the highlight agrees with the visible section.
6. Repeat at a narrow width and in light and dark themes. Resize the window
   and let live samples change section heights. Verify the highlight again.
7. Hover over a tab or focus it. Verify that the section navigation help
   explains the highlight and does not prevent navigation.

Expected results: One tab identifies the current visible section. The highlight
uses a background, text color, and underline. It follows scrolling, navigation,
and layout changes. Screen readers can identify the current section.

## QA-001: Package installation and live dashboard

Feature: Installation. Priority: High. Case revision: 1.

Preconditions: Matching sampler and collector packages have verified checksums.
Use an isolated runtime directory and unused ports. Start an owned test process.

1. Extract both packages into the same test installation.
2. Start the packaged programs with the documented startup script.
3. Select the owned process with the packaged target-control script.
4. Open the collector URL in a real browser. Wait for samples to arrive.

Expected results: The programs start without a compiler. The dashboard loads,
identifies the selected process, and shows its threads. Browser diagnostics have
no application error that prevents this behavior.

Source: [Package installation](../setup.md#install-from-a-release-package).

## QA-002: Change target by PID

Feature: Target control. Priority: High. Case revision: 1.

Preconditions: QA-001 setup is running. Python and local target control are
available. Two owned processes with different PIDs are running.

1. Open the dashboard. Select **Change target**.
2. Enter the second process PID. Select **Monitor**.
3. Wait for its samples. Reload the page.

Expected results: The dashboard identifies the second process and displays
its threads. The saved target remains selected after page reload.

Source: [Target control](../setup.md#quick-start).

## QA-003: Invalid target input

Feature: Target validation. Priority: High. Case revision: 1.

Preconditions: QA-002 setup is available. A valid target is selected.

1. Open **Change target**. Clear the target field. Select **Monitor**.
2. Inspect the validation message and the current target.
3. Enter a nonexistent numeric PID. Select **Monitor**.
4. Inspect the validation message. Close the form and reload the dashboard.

Expected results: Both invalid inputs are rejected with a form validation
message. The original target remains active and saved.

Source: [Target validation](../setup.md#quick-start).

## QA-004: Wait for a named process

Feature: Target lifecycle. Priority: High. Case revision: 1.

Preconditions: Local target control is available. Choose an exact Linux process
name of at most 15 bytes. No process with that name is running. Prepare an owned
test process that can start with this name.

1. Set the absent process name through **Change target** and **Monitor**.
2. Inspect the dashboard after the sampler reloads.
3. Start the prepared process with that exact name.
4. Wait for samples. Stop only that process. Wait for the next target scan.

Expected results: The name is accepted. The dashboard first reports the target
as absent, then identifies it and shows threads when it starts. It reports an
absent target again after the process stops.

Source: [Named targets](../setup.md#quick-start).

## QA-005: Thread detail and recorded replay

Feature: Thread history and replay. Priority: High. Case revision: 1.

Preconditions: An owned workload is monitored. Recording and summary storage
are enabled. Allow sufficient samples for at least two recorded times.

1. Select a thread tile or table row. Inspect its detail drawer and history.
2. Select a recorded time with the replay control. Inspect the time and threads.
3. Select a different recorded time. Open a thread available at that time.
4. Return to the live view.

Expected results: The live drawer shows the selected thread's metrics and
history. Replay shows the selected recorded time and its thread state. The
recorded thread history ends at that time. Live updates resume in the live view.

Source: [Dashboard and replay](../setup.md#dashboard).

## QA-006: Package upgrade preserves configuration and history

Feature: Upgrade. Priority: High. Case revision: 1.

Preconditions: An earlier package is installed in an isolated directory. It has
custom ports, a saved target, logs, and recorded history. Matching packages for
the requested newer version have verified checksums. Save the starting file
identities and settings. If no earlier package is available, record BLOCKED.

1. Open the earlier dashboard and confirm that recorded history is available.
2. Stop the test installation with its packaged stop script.
3. Extract the newer packages over the same test installation. Start it again.
4. Open the dashboard at the saved port. Inspect its target and earlier history.

Expected results: The newer package starts. Custom configuration and the saved
target remain. Earlier history is accessible in the browser. Existing logs
remain. Record both the starting version and the tested upgrade version.

Source: [Package upgrade](../setup.md#install-from-a-release-package).

## QA-007: Contextual help covers every dashboard section

Feature: Contextual help. Priority: Medium. Case revision: 1.

Preconditions: An owned workload is monitored with resource and memory-map
samples available. Hover help is on.

1. For each section, pause over its heading for 1.2 seconds. Include Summary,
   Threads, Thread details, Pressure, Socket I/O, Memory map, and Monitor.
2. In Memory map, pause over each tile, finding, legend entry (its card's guide), limit, chart
   title, region column, and zoom fact. Select a bar and repeat for the zoom.
   On a live collector keep the pointer still for the full 1.2 seconds; the
   card must open although the page refreshes every second. Repeat with
   keyboard focus on an information button.
3. Select each information button in Memory map and read its guide.
4. Pause over a full-width table message, such as an idle thread row or a
   "No socket has queued data" row.

Expected results: Every heading and label opens a specific card, not the
generic page guide. Legend entries have no topics of their own, so pausing
over one opens the guide for its card (Address space map or Zoom); this
fallback is expected. Memory-map guides describe the shown measurement and its
limits. Idle thread rows explain Active threads. Other full-width messages
explain their panel.

Source: [Contextual help design](../contextual-help-design.md).

## QA-008: Memory zoom legend matches the grid

Feature: Memory map zoom. Priority: Low. Case revision: 1.

Preconditions: An owned workload is monitored with memory-map samples
available. Its map has heap, stack, anonymous, file and program or library
regions, and a guard region if possible.

1. In Memory map, select each bar in turn, including the heap, the stack and a
   bar with a guard region.
2. For each zoom, compare the legend under the grid with the colors of the
   squares.
3. Wait for a new mapping (for example, allocate a large block) and watch the
   zoom of the bar that contains it.

Expected results: The legend lists only kinds that have squares in the grid,
each with that kind's swatch color (heap blue, stack orange, anonymous green,
file yellow, code gray). Guard squares are hatched, and "not mapped" appears
only when the zoom has gaps. "Mapped since the previous layout" appears only
while a new square is outlined.

Source: [Memory map](../memory-map.md).

## QA-009: Interactive bugbench session

Feature: Agent workload session. Priority: Medium. Case revision: 1.

Preconditions: Python 3, GCC, and the user systemd manager are available.
Use a test home with the helper's `--home` option.

1. Ask the agent to start `bugbench-session`. Verify the installed source and
   executable, reported PID, duration, and launch command.
2. Ask for the next program. Verify that the former service stops and the new
   PID can be selected as the dashboard target.
3. In a new agent conversation, ask for the previous program. Verify that the
   saved position is used. Verify that navigation stops at both list boundaries.
4. Run `cpu-throttle` and inspect its 50% CPU quota. Run `mem-oom` and inspect
   its 256 MiB memory limit and disabled swap. After it exits, request status.
5. Stop the session. Verify that unrelated services continue to run.

Expected results: Only one session workload runs at a time. Navigation persists
across conversations. An exited process is reported as stopped. The helper does
not select the dashboard target or remove unrelated files or processes.

Source: [Bugbench session skill](../../.agents/skills/bugbench-session/SKILL.md).

## QA-010: Wire format overview

Feature: Wire format documentation. Priority: Medium. Case revision: 1.

Preconditions: Open `docs/wire-format-overview.html` from the source checkout
in a browser. This page needs no running collector.

1. Check both README wire format links. Both must open this page. Select
   each section link in the top bar.
2. Select TMON, TRES, TVMA, and TSIO. Check the header and row sizes against
   the source headers. Encode each example header, then read its fields.
3. Change the thread count to 1, 10, 11, and 60. Check the event log.
4. Set packet loss to 50%. Check the loss states. Pause and resume the animation.
5. With packet loss at 0%, click datagrams in flight to drop them. Drop a TRES
   summary. Drop a TVMA summary and let all region parts arrive. In a separate
   TVMA sample, drop a region part.

Expected results: The only wire format page is the overview. Each section
heading appears below the top bar after its link is selected. Header sizes are
48, 64, 64, and 80 B. Row sizes are 112, 160, 64, and 80 B respectively;
a complete TSIO datagram is 160 B. The example header fields match their
encoded bytes. The demo identifies header examples and illustrative timings.
TMON uses 1, 1, 2, and 6 chunks for these thread counts. TRES discards a sample
without its summary. TVMA updates a layout when all region parts arrive, even
without its summary; missing region parts preserve the previous layout. Each
clicked datagram drops once, and the event log records the drop. The TVMA
layout count excludes summary-only samples.
TSIO counts received datagrams separately. The browser has no script errors.

Source: [Wire format overview](../wire-format-overview.html).

## QA-011: Memory zoom page size and units

Feature: Memory map zoom. Priority: Medium. Case revision: 2.

Preconditions: Dashboard fixtures with 4 KiB, 64 KiB, and missing page sizes.

1. Select a region in each fixture and inspect the page size and grid caption.
2. Repeat with invalid page sizes, stale resource data on first load, and
   resource data from another target.
3. After valid page metadata arrives, make resource data stale. Then change
   the target or sampler session and repeat without valid metadata.

Expected results: Binary values use KiB/MiB/GiB. Valid metadata sets the page
size and cell page count. Missing or invalid metadata on first load shows Unknown and byte
sizes without page counts. Once valid metadata arrives, its page size stays
valid for that target and sampler session when resource data becomes stale.
A new target or session clears the cached value. The grid has at most 512 cells.

## QA-012: Memory growth facts refresh and reset

Feature: Memory map zoom. Priority: Medium. Case revision: 1.

1. Select the heap. Receive two memory samples with an unchanged layout.
2. Grow and contract the heap, then leave its layout unchanged for a sample.
3. Repeat with the main stack. Make samples stale, delay a new layout, then
   change the target or sampler session.

Expected results: Size change and measured interval refresh on each sample.
Unavailable data does not produce a growth value. A new target or session
starts a new comparison. Outlines retain their previous-layout meaning.

## QA-013: Largest unmapped gap and unknown coverage

Feature: Memory map zoom. Priority: Medium. Case revision: 1.

1. Select bars with contiguous regions and separated regions. Compare the
   largest gap with their address ranges, including addresses above `2^53`.
2. Repeat with partial, truncated, stale, and delayed layouts.
3. Open help for Largest unmapped gap.

Expected results: The fact shows the longest internal gap, including zero
for contiguous regions. Incomplete coverage shows Unavailable and unknown
cells. Help distinguishes address gaps from allocator free blocks.

## QA-014: Memory boundary charts

Feature: Memory map zoom. Priority: Medium. Case revision: 1.

1. Grow and contract the heap. Grow the main stack downward.
2. Include unchanged samples and a missing layout between valid samples.
3. Use addresses above `2^53`, then restart the sampler or change the target.
4. Open both boundary-chart guides.

Expected results: Heap-end and stack-start offsets retain page-sized changes.
Stack growth moves the start downward. Lines use sampled steps and stop at
missing samples. History resets for a new target or session. The heap label
and guide explain page alignment. Resident anonymous remains a separate chart.

## QA-015: Compact memory zoom and thread-stack help

Feature: Memory map zoom. Priority: Medium. Case revision: 1.

1. Open Memory map at desktop and narrow viewport widths.
2. Use the keyboard to open and close Member regions. Keep it open across
   a new sample. Open its help and the Thread stacks guide.

Expected results: Facts, legend, and charts remain visible. Chart headings
and rates have separate lines. Charts stack on narrow screens. The disclosure
keeps its open state across samples. Help explains reserved size, residency,
and stack depth as different measurements.

## QA-016: Bounded heap display margin

Feature: Memory map zoom. Priority: Medium. Case revision: 1.

1. Select a heap with an unmapped gap and a neighboring file or anonymous
   mapping above it. Open Heap display margin help.
2. Grow the heap within the grid, then past its display end. Contract it.
3. Change selection and target. Repeat with stale or incomplete layouts.

Expected results: Neighboring mappings retain their colors. The grid range
remains stable while growth fits. It resets when needed, with at most 1 MiB
of upper margin and 512 cells. The caption identifies the heap mapping end
and grid range. Heap facts exclude the margin. Incomplete or stale layouts
have no margin. Selection and target changes reset the display span.

## QA-017: Late resource samples retain memory history

Feature: Memory map zoom. Priority: Medium. Case revision: 1.

Preconditions: An HTTP dashboard fixture can keep memory.updated constant
while resource availability changes. It uses matching target and session IDs.

1. Load one memory sample while its resource sample is stale.
2. Supply a valid resource sample without changing memory.updated.
3. Supply a second memory sample with valid resources, then a third with
   stale resources. Inspect the resident-anonymous chart and page caption.
4. Change the sampler session. Inspect the charts.

Expected results: The first sample starts with Unknown page size. The late
resource sample adds RSS and anonymous bytes to that same history point.
Valid page metadata updates the caption. Later resource staleness retains
the learned page size and earlier resident-anonymous history. A new session
starts new history with Collecting… .

## QA-018: Live anonymous growth stays distinct from brk heap growth

Feature: Memory map zoom. Priority: Medium. Case revision: 1.

Preconditions: The standard bugbench fixture and an isolated sampler and
collector run with resource and memory intervals of 1 second. Start healthy
first. Then select mem-leak, which allocates large blocks through malloc.

1. Keep the live Memory map open on healthy and inspect heap size changes.
2. Select the owned mem-leak process with the target-control script.
3. Keep the browser open for at least two resource samples.
4. Compare Resident anonymous, heap mapping size, and heap boundary offset.

Expected results: Healthy unchanged samples refresh the measured interval
with zero heap change. The new target starts new browser history. Resident
anonymous increases for mem-leak. If the allocator uses mmap for these large
blocks, the brk heap can remain fixed with a zero heap-end offset. The chart
does not describe resident-anonymous growth as brk heap growth.

## QA-019: Heap span remains stable across bounded changes

Feature: Memory map zoom. Priority: Medium. Case revision: 1.

Preconditions: Serve the dashboard with the versioned QA HTTP fixture. Use a
complete layout, 4 KiB page metadata, a 1 MiB heap, and a neighboring 64 KiB
file mapping. Keep the browser open through all fixture changes. Change fixture
state outside the browser. Wait for at least two dashboard polls per change.

1. Open Memory map. Record the selected heap's grid range and cell count.
2. Grow the heap by 4 KiB, then contract it to 4 KiB below its original size.
3. Make memory stale, then fresh. Delay a new layout, then deliver it.
4. Unmap the neighboring file in the fixture. Grow the heap past its grid end.
5. Change the fixture target PID and restore the original heap and neighbor.

Expected results: Small growth and contraction keep the original grid range
and cell count. The heap mapping end, growth fact, and previous-layout legend
update. The neighbor retains its file-mapping label and color while present.
Stale or delayed coverage hides the margin. Recovery restores the retained
span. Growth outside that span creates a new span with at most 1 MiB margin
and 512 measured cells. Target change resets the span for the new target.

Source: [Original failure and fixture](runs/20261011T090200Z-pr65/index.md).

## QA-024: Sampler benchmark values and frequency controls

Feature: Sampler benchmark documentation. Priority: Medium. Case revision: 1.

Preconditions: Open `docs/sampler-benchmark.html` in a browser. Use the JSON
file from the same source revision. No sampler or collector is required.

1. Select 1, 2, 5, and 10 Hz. Select each thread count.
2. Compare the latency cards, chart labels, CPU, RSS, and interval share
   with the matching table rows and raw trial observations.
3. Select each frequency grid cell. Change the grid metric to CPU and back.
4. Open each metric explanation. Check the selected case and units.
5. Compare the separate sampling-loop charts with `sampling-performance.json`.
   Verify that their capacity values exclude UDP and use no frequency limit.
6. Download raw JSON. Expand the method and source disclosures.

Expected results: All selections agree. Latency and throughput charts show
all four frequencies against 100, 300, and 500 threads. The selected frequency
has a p95 latency line. The table retains all 12 cases. p50 and p95 use pooled
observations. Throughput is delivered records per second. CPU is percent of
one core. Help defines the measurement boundaries and limits.

## QA-025: Sampler benchmark access and offline use

Feature: Sampler benchmark documentation. Priority: Medium. Case revision: 1.

Preconditions: Download the HTML file. Open it without network access. Enable
reduced motion before loading the page.

1. Use Tab and Enter to select frequency, thread count, grid metric, and cells.
2. Open help with the keyboard. Close it with Escape. Check returned focus.
3. Use Pause motion and Enable motion. Check the moving status indicator.
4. Set a 390-pixel viewport and 200% zoom. Inspect all controls and graphs.
5. Disable JavaScript and reload. Read the measurement table and method.
6. Open the benchmark page link and infographic from the README.

Expected results: The page has no external asset dependency. Controls have
visible focus and accessible names. Grid selections retain keyboard focus.
Reduced motion starts with animations off. The page has no document-wide
horizontal scroll; the wide table scrolls within its container. Without
JavaScript, the complete table and measurement method remain available.

## QA-027: Profiling agent preserves measurement scope

Feature: Efficiency profiling agent. Priority: Medium. Case revision: 1.

Preconditions: Use a source checkout with the profiling agent and skill. Record
the source revision instead of a package version. Use isolated test processes,
configuration, ports, and data. Have a native benchmark and one compatible
profiler available. This agent case does not require a browser.

1. Invoke `$profile-efficiency` to compare methods without running workloads.
2. Request a bounded sampler profile. Check which benchmarks this revision has.
3. Check native completed-work counts and CPU cost before profiling. Inspect
   the measured component, raw evidence, self/inclusive attribution, and limits.
4. Repeat in an environment where `perf` is unavailable. Permit an installed
   fallback tool. Do not permit package installation or host permission changes.
5. Inspect the report and source diff. Ask for a PGO experiment plan without
   authorizing an optimization build.

Expected results: The skill starts one profiling agent, or reports that delegation
is unavailable. Method comparison and experiment planning do not start workloads
or builds. Measurement uses available revision-specific benchmarks or labels
missing coverage. It profiles the C++ component and records completed work,
binary identity, commands, artifacts, and profiler limits. A fallback report
separates simulated or instrumented results from native timing. Missing events
are unavailable, not zero. The agent preserves production source and build
defaults. The PGO plan uses representative training, independent validation,
matching executable profiles, and correctness checks.
