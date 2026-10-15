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
| QA-028 | NOT_RUN | - | - | - |
| QA-029 | NOT_RUN | - | - | - |
| QA-030 | NOT_RUN | - | - | - |
| QA-031 | NOT_RUN | - | - | - |
| QA-032 | PASSED | PR83 c454915 (source) | [Run](runs/20261014T172600Z-pr83-c454915/index.md) | [Browser observations](runs/20261014T172600Z-pr83-c454915/evidence/healthy-browser.json) |
| QA-033 | PASSED | PR83 c454915 (source) | [Run](runs/20261014T172600Z-pr83-c454915/index.md) | [Browser observations](runs/20261014T172600Z-pr83-c454915/evidence/stopped-browser.json) |
| QA-034 | NOT_RUN | - | - | - |
| QA-035 | NOT_RUN | - | - | - |
| QA-036 | NOT_RUN | - | - | - |
| QA-037 | NOT_RUN | - | - | - |
| QA-038 | PASSED | 0.1.0 | [Run](runs/20261015T091100Z-v0.1.0-multiple-viewers/index.md) | [Evidence](runs/20261015T091100Z-v0.1.0-multiple-viewers/evidence/initial-a.json) |
| QA-039 | PASSED | 0.1.0 | [Run](runs/20261015T091100Z-v0.1.0-multiple-viewers/index.md) | [Evidence](runs/20261015T091100Z-v0.1.0-multiple-viewers/evidence/replay-filter-a.json) |
| QA-040 | BLOCKED | 0.1.0 | [Run](runs/20261015T091100Z-v0.1.0-multiple-viewers/index.md) | [Evidence](runs/20261015T091100Z-v0.1.0-multiple-viewers/evidence/stale-target-a.json) |
| QA-041 | BLOCKED | 0.1.0 | [Run](runs/20261015T091100Z-v0.1.0-multiple-viewers/index.md) | [Evidence](runs/20261015T091100Z-v0.1.0-multiple-viewers/evidence/browser-tool-errors.txt) |
| QA-042 | BLOCKED | 0.1.0 | [Run](runs/20261015T091100Z-v0.1.0-multiple-viewers/index.md) | [Evidence](runs/20261015T091100Z-v0.1.0-multiple-viewers/evidence/browser-tool-errors.txt) |
| QA-043 | NOT_RUN | - | - | - |
| QA-044 | NOT_RUN | - | - | - |
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

## QA-030: Default thread sampling rate and saved settings

Feature: Sampling defaults and saved settings. Priority: High. Case revision: 2.

Preconditions: Use an isolated runtime directory, unused ports, and an owned
test process. Use matching sampler and collector packages.

1. Start with no active configuration. Verify that the startup script creates
   `config/sampler.toml` with `rate_hz = 5.0`, `resource_interval_s = 2`, and
   `memory_interval_s = 30`. Select the owned process. Receive
   thread datagrams and verify a 200 ms header interval and about five ticks
   per second. Count ticks, because one tick can use several datagrams.
2. Remove `rate_hz` from the active configuration. Restart the sampler. Verify
   that thread datagrams still have a 200 ms interval.
3. Set `rate_hz = 1.0`. Restart the programs, then repeat startup with the newer
   package. Verify that the saved setting remains 1.0 and thread datagrams have
   a 1000 ms interval. Verify that the resource and memory sampling intervals
   are 2 and 30 seconds when their settings are omitted.
4. Set `resource_interval_s = 5` and `memory_interval_s = 60`. Restart the
   programs, then repeat startup with the newer package. Verify that both
   saved intervals remain in effect.

Expected results: New configurations and omitted thread rates use 5 Hz.
Omitted resource and memory intervals use 2 and 30 seconds. Explicit saved
rates and intervals remain in effect after restart and package upgrade.

Source: [Sampling defaults](../setup.md#install-from-a-release-package).

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

## QA-028: Process details card

Feature: Dashboard process details. Priority: Medium. Case revision: 1.

Preconditions: Run the sampler as the target's user with no extra privileges.
Start a test process from a known directory with arguments, such as
`python3 -c 'import time; time.sleep(1e6)' --port 8080`. Pin one copy to two
cores with `taskset -c 0,1`. Open the dashboard Summary section.

1. Find **Process details** under the summary tiles. Compare each value with
   `/proc/PID/cmdline`, `exe`, `cwd`, `stat` and `status`, and with `ps`.
2. Check Started and the run time against `ps -o lstart,etime -p PID`.
3. Pause on each label for 1.2 seconds, then open its information button.
4. Start the target as another user, or replace its executable on disk while it
   runs. Wait up to 10 seconds. Check Executable and Working directory.
5. Start a target with a command line over 380 characters.
6. Restart the target, or select another with **Change target**. Watch the card.
7. Inspect a recorded moment, then return to **Live**. Stop the target and open
   the final view.

Expected results: The card shows the command line, executable, working
directory, start time with run time, parent PID, user and group IDs, and allowed
CPUs, as the target has them (for example `0-1` after taskset). The start time
agrees with `ps` to about a second. Each label has a help card and a guide
that names its limits. Values the sampler may not read show **Not available**
with the reason for a hidden path. A replaced executable ends with
`(deleted)`. A long command line ends with `…`. After a target change the card
is hidden until the new process's values arrive, and never shows the previous
process. A recorded moment shows the process as recorded, with run time counted
to the recording time. The final view keeps the card, with run time counted to
the stop time. The card never shows capabilities, seccomp or OOM score, which
only `/api/live` carries.

## QA-029: Summary CPU and memory trends

Feature: Summary process load. Priority: Medium. Case revision: 1.

1. Monitor a process whose RSS grows, for example a bug-lab leak workload.
   Keep the Summary open for at least two minutes.
2. Switch the chart window between 1 min, 5 min, and 15 min.
3. Hover each chart. Open help from the Resident memory (RSS) and Virtual size
   (VmSize) labels.
4. Inspect a recorded moment, then return to Live.
5. Restart the sampler without `memory_interval_s`, so memory-map sampling is
   off.

Expected results: Under the load chart, RSS and VmSize charts share its time
window. The current values match the Resources and Memory map tiles. RSS steps
about every 2 s and VmSize about every 30 s. The axes use binary units. Tooltips
and help open the RSS and VmSize topics, and the help data tables list the
memory values. The memory charts are hidden in a recorded view, like the load
chart, and return in Live. With memory-map sampling off, the VmSize chart shows
the collector's reason instead of empty axes.

## QA-031: Complete sanitizer test runs

Feature: Build and test commands. Priority: High. Case revision: 1.

1. Install a supported compiler, its sanitizer runtimes, SQLite development
   files, Python, and Node.js on Linux.
2. Run `make -j2 check-sanitizers` from a clean checkout.
3. Check the address and thread test logs and report directories.
4. Run `make check`, then `make check SANITIZER=thread STATIC=1`.

Expected results: The sanitizer command runs the address and undefined behavior
mode, then the thread mode. Both modes run all six C++ tests and the Python and
dashboard tests. The optional privileged eBPF test retains its existing opt-in
requirement. The allocation tests report zero allocations. Any sanitizer report
fails the command. `make check` rebuilds with normal linkage and passes. The
static sanitizer combination fails with a clear error before compilation.

## QA-032: Named periodic workers match configured wake intervals

Feature: Collector watch rules. Priority: High. Case revision: 1.

Preconditions: Use a build that includes PR #83. Use isolated configuration,
data, and ports. Start two real Linux threads named `MsgP-fast` and `MsgP-peer`
with 1-second timers, two named `PrdDist-main` and `PrdDist-peer` with 2-second
timers, and an unmatched `Control-idle` with a 1-second timer. Select their
process with the actual sampler at 10 Hz. Configure `[[watch]]` prefixes
`MsgP` with `wake_ms = 1000` and `PrdDist` with `wake_ms = 2000`.
Do not append `*`. No saved watch rules must exist.

1. Open the dashboard in a real browser. Read the thread table and Monitor.
2. Through the browser, read `GET /api/watches` and `GET /api/live`.
3. Read nine live views over at least 8 seconds. Compare `last_ran` across views.
4. Compare fixture counters and `/proc/PID/task/TID/schedstat` as supporting
   evidence. Confirm that the fixture timers run and CPU use stays near zero.

Expected results: All five worker names appear. Monitor reports a 100 ms sample
interval. The rule source is `config`. Both `MsgP` threads report `wake_ms = 1000`;
both `PrdDist` threads report `wake_ms = 2000`; the control reports `null`.
`last_ran` advances for every worker, even when every observed state is sleep.
The sampled elapsed time stays within its configured interval plus one sample
interval. Allow 0.25 seconds for sampler buffering and 0.5 seconds for browser
refresh when comparing the view with wall time. Rules describe expected intervals;
they do not change the fixture timers. PR #83 does not add watch settings or
watch-specific assessment warnings to the dashboard.

## QA-033: A watched worker stops waking but remains alive

Feature: Collector watch activity. Priority: High. Case revision: 1.

Preconditions: QA-032 passes. The fixture can stop `MsgP-fast`'s timer loop and
block on an Event without ending the thread. Its peers continue their timers.

1. Stop the timer loop for `MsgP-fast`. Leave its thread and process alive.
2. Through the browser, read five `GET /api/live` views at 3-second intervals
   after the final timer wake. Read the dashboard Assessment.
3. Select Threads, then All threads through browser controls. Read `MsgP-fast`.
4. Check fixture counters and `/proc` as supporting evidence.

Expected results: The same TID remains present, with `wake_ms = 1000`,
`stale = false`, and a futex wait. `last_ran` stays fixed while `last_sample`
advances. Elapsed time increases beyond 1 second. Healthy peers continue to
advance. The All threads table shows the blocked worker as idle in a futex wait.
Watch-specific dashboard warnings are outside PR #83; a Healthy assessment is
not evidence that the collector missed the stopped wakeups.

## QA-034: Watched thread stops waking

Feature: Dashboard watched-thread assessment. Priority: High. Case revision: 1.

Preconditions: Use the bug-lab or `examples/buggy-workload` `deadlock` scenario
with an isolated runtime directory and unused ports. Open the dashboard Summary.

1. Add the rule `worker-` with `wake_ms` 500 (`[[watch]]` in `collector.toml`, or
   `POST /api/watches`). Wait about 10 seconds.
2. Read the Assessment. Open the finding. Pause on it for 1.2 seconds, then open
   its information button.
3. Open one thread from the finding and read the **Watched** line.
4. Change the rule to `wake_ms` 3600000. Wait for the next refresh.
5. Pause the sampler (`kill -STOP`) for 30 seconds, then resume it.
6. Open **Inspect a moment** at a time after step 1 and read the Assessment.
7. Remove all rules.

Expected results: One serious finding, "N watched threads stopped waking up" (or
"worker-a stopped waking up" for one thread), names the worst threads first with
how long each has not run and its wake interval, and says they may be deadlocked
or waiting without a timeout. It links to the worst thread, and its help opens
the Watched threads topic. The thread details show "Watched: wakes at least every
500 ms · last ran X s before the latest sample · overdue". A 3,600,000 ms rule
clears the finding and an "on schedule" line replaces it. Pausing the sampler
raises no stopped-waking finding for the time it was paused. A recorded view uses
the recorded wake intervals and shows no "rule matches no thread" finding. With
no rules, no watch finding or Watched line remains.

## QA-035: Watched thread busy loop and rule with no match

Feature: Dashboard watched-thread assessment. Priority: High. Case revision: 1.

Preconditions: Use the `cpu-spin` scenario (threads `worker-spin` and
`worker-poll`) with an isolated runtime directory and unused ports.

1. Add the rules `worker-spin` with `wake_ms` 500 and `gone-` with `wake_ms` 200.
   Wait about 10 seconds.
2. Read the Assessment and its help for each watched finding.
3. Replace the rules with `misc-` at 1000 ms. Wait for the next refresh.
4. Select **Change target** and choose a process that has no `misc-` thread.
5. Stop the target and read the final view.

Expected results: `worker-spin` has a serious "is running instead of sleeping"
finding that says it is expected to sleep and wake every 500 ms but uses about
100% of a core, and it has no "saturating a core" finding of its own. The
unwatched `worker-poll` keeps the generic "saturating a core" finding. A warning
"A watch rule matches no thread" names `gone-` and says the threads may have
exited or been renamed. After step 3 the warning disappears without a flash of a
false warning for `misc-`, and "1 watched thread wakes on schedule (misc-)" is
shown while no watched thread is stuck or busy. In step 4 the unmatched rule is
reported once the new target has threads. The final view of an ended target shows
no unmatched-rule warning.

Screenshots: [stopped waking](../screenshots/watch-assessment-stopped-waking.png),
[busy](../screenshots/watch-assessment-busy.png) and
[thread details](../screenshots/watch-thread-drawer-overdue.png) from a live run
of the scenarios; this is not a recorded QA run.

## QA-036: Edit, save and reset watched-thread rules in Settings

Feature: Settings tab, Watched threads. Priority: High. Case revision: 1.

Preconditions: Use an isolated runtime directory, unused ports and matching
packages. Put one `[[watch]]` rule (`prefix = "worker-"`, `wake_ms = 500`) in
`collector.toml`. Monitor an owned process that names its threads with a common
prefix (the bug-lab `lock-convoy` workload names eight threads `worker-N`).

1. Open the dashboard and select **Settings** in the section nav.
2. Check the source line, the table and **Matching threads now**. Check that
   **Save** is off and **Reset to config file** is off.
3. Change the interval to 250. Check that **Save** turns on and an unsaved-edits
   warning appears. Set it back to 500 and check both turn off again.
4. Add a rule with prefix `misc-` and 1000 ms. Add another with a prefix
   longer than 15 bytes (for example `this-prefix-is-way-too-long`), then one
   with 5 ms, one with `1.5`, and one that repeats `worker-`. Also type `ééééééééé`
   (nine two-byte characters). Check the message beside each field and **Save**.
5. Type a prefix that no thread starts with, then one that matches threads of
   a longer rule. Watch **Matching threads now** while you type.
6. Fix or remove the invalid rows. Select **Save**. Check the message and the
   source line. Reload the page and open **Settings**. Restart the collector and
   check the rules again.
7. Make an edit and do not save it. Reload the page and check the browser warns.
   Use **Discard edits**.
8. Select **Reset to config file** and answer Cancel, then OK. With an unsaved
   edit pending, check what the question says.
9. With the saved rules in place, stop the collector, write an invalid
   `data_dir/watch-rules.json`, and start it again. Open **Settings**.
10. Make a request the collector refuses, for example by stopping the collector's
    write access to `data_dir` before **Save**, and check the message.
11. Throttle the network in the browser developer tools so that `/api/watches`
    takes a few seconds. With the editor open, select **Settings** again and
    change an interval before the reply arrives.

Expected results: Before any save, the source reads "From the config file
(collector.toml)." and the table shows the `[[watch]]` rules. Each live thread is
counted under the longest matching prefix, with a few names; the count updates
as you type and as threads start and stop. Each problem is shown beside its
field (empty prefix, more than 15 UTF-8 bytes, same prefix as another rule,
interval not a whole number or outside 10 to 3,600,000, more than 64 rules).
**Save** stays off while anything is invalid or nothing changed. After a save the
page says "Saved and applied.", the source reads "Saved from the dashboard. These
replace the [[watch]] rules in collector.toml until you reset.", and the rules
survive a reload and a restart even if collector.toml still lists other rules.
Reset asks first, keeps the rules if you cancel, and then shows the config file
rules and source again. A saved file the collector could not read shows a visible
warning and the config file rules. A refused save shows the collector's message
unchanged and keeps the edits. An edit made while a read is pending stays, with
the unsaved-edits warning. The Assessment is not changed by this case.

## QA-037: Settings tab read-only states and help coverage

Feature: Settings tab. Priority: Medium. Case revision: 1.

Preconditions: Use an isolated runtime directory, unused ports and a recorded
process view (leave `replay_interval_s` at its default).

1. Open **Settings**. Pause on the section title, the **Watched threads** title,
   the source line, each column heading, a prefix field, an interval field, a
   **Matching threads now** cell, **Remove**, **Add rule**, **Save**,
   **Discard edits**, **Reset to config file** and the status line for 1.2
   seconds. Select the information button for each heading.
2. Check the section nav: the Settings tab exists, is highlighted when the page is
   scrolled to the bottom, and its help says so.
3. Make an unsaved edit, then use **Inspect a moment** to open a recording.
   Return to **Live**.
4. Open the Alert settings control (when an alerting program is present) and
   check that it is unchanged.
5. Serve the dashboard from a collector build that has no `/api/watches`, or
   block that URL in the browser, and open **Settings**.
6. Stop the collector and watch **Settings** with the editor already open.
7. Start the collector again, open **Settings**, and stop the monitored process so
   the final view is shown. Then start the process again with the same thread
   names, and watch **Matching threads now** without editing.

Expected results: Every heading, column, label, button and message shows a help
card after 1.2 seconds and has a guide with meaning, example, how to read it and
limits, with no empty or unrelated topic. While a recorded moment is inspected,
the card shows a note that Settings cannot be edited, with no editor, and your
unsaved edit is back after you return to Live. Without `/api/watches`, the card
shows a note that names the endpoint and says to edit `collector.toml` instead,
not a broken editor. **Matching threads now** counts no threads in a recording.
The existing Alert settings behave as before. With the collector stopped, **Save**
shows "Could not reach the collector" and keeps your edits. In the final view,
**Matching threads now** drops to 0 when the process exits and counts the
restarted threads again, without an edit.


## QA-038: Simultaneous live dashboard viewers

Feature: Multiple viewers. Priority: High. Case revision: 1.

Preconditions: One isolated packaged collector and sampler monitor an owned
healthy process. Two browser views use separate origins or independent profiles.

1. Open the dashboard in both views. Observe the process name, PID and Connected
   status in each view.
2. Keep both views open for at least 20 seconds. Observe advancing chart times
   and repeated live requests in each view.

Expected results: Both views show the same monitored PID and fresh live data.
Opening the second view does not stop the first view.

## QA-039: Local search and replay state

Feature: Multiple viewers. Priority: High. Case revision: 1.

Preconditions: QA-038 setup. Recording is enabled. Two owned targets run.

1. In A, enter an exact worker name in thread search. Leave B unfiltered.
2. In A, select Latest recording. Keep B Live. Observe both views.
3. In B, change the target to the second process. Observe both views again.

Expected results: A retains its search value and historical process. B retains
an empty search and receives live data from the selected process. Replay and
search selections do not propagate between viewers.

## QA-040: Shared target change and another viewer's target editor

Feature: Shared target control. Priority: High. Case revision: 1.

Preconditions: Two views monitor the same owned target. A second owned target
runs. Both views initially load the first target into their target editor.

1. Put A in replay. In B, select Change target, enter the second PID, and
   select Monitor.
2. Observe B update to the second PID. Observe A retain its historical process.
3. In A, select Live. Verify the header changes to the second PID.
4. Open Change target in A. Wait for its target read to complete and the input
   and Monitor button to become enabled. Read its value and status without
   submitting it.

Expected results: The live target is shared. Replay remains local. After the target read completes and the
editor is enabled in A, its value identifies the current shared target. The editor
must not silently offer the earlier target as the current target.

## QA-041: New viewer and stored history

Feature: Multiple viewers and history. Priority: Medium. Case revision: 1.

Preconditions: An isolated packaged collector records an owned target for at
least 60 seconds. A remains open while a fresh browser view is prepared.

1. Open B with empty browser storage. Verify its live process name and PID.
2. Compare the overview trend start in A and B.
3. In B, open a recording from before B opened. Inspect the process name and
   recording time. Return B to Live. Observe A throughout these actions.

Expected results: B shows the current live target. Tab-local trends start when
B opens. Stored recordings remain available in B. B's replay does not change A.

## QA-042: Two viewers after a collector outage

Feature: Multiple viewers and reconnect. Priority: High. Case revision: 1.

Preconditions: An isolated packaged collector and owned sampler are running.
Two views show live data. Only test-owned processes may be stopped.

1. Stop the test collector for 15 seconds. Observe both headers and charts.
2. Restart the same packaged collector with the same configuration and data.
3. Wait for new sampler data. Observe both views without reloading them.

Expected results: Both views identify unavailable or stale data during the
outage. Both resume fresh live data after recovery. Stale charts must not be
presented as fresh observations. Record any need for a manual page reload.

## QA-043: Independent browser engines and profiles

Feature: Browser compatibility for multiple viewers. Priority: High. Case revision: 1.

Preconditions: One isolated packaged service is reachable from two independent
browser profiles. Chromium and Firefox are available. Safari requires an
available supported Apple test device. Record all actual engines and versions.

1. Repeat QA-038 and QA-039 with independent profiles in Chromium and Firefox.
2. Repeat with Safari on an available Apple device.
3. Change the shared target from one browser and inspect the other browser.

Expected results: Live data, local filters, local replay and shared target
behavior match across the tested engines. Record unavailable engines as unrun.
Two tabs or two origins in one engine do not satisfy this case.

## QA-044: Concurrent saved thread watch edits

Feature: Shared saved thread watches. Priority: High. Case revision: 1.

Preconditions: A published package contains saved thread watches. Two independent
views open the same initial watch list. Use only isolated test settings.

1. In A, prepare an added rule without saving. In B, prepare a different rule
   from the same initial list.
2. Save A. Save B from its earlier state. Reload both views.
3. Inspect both saved rule lists and any conflict or overwrite warning.

Expected results: A stale save must preserve the other user's saved rule or
identify the conflict before it silently replaces that rule. Record the exact
order and final rules. If the package lacks watches, leave the case NOT_RUN.
