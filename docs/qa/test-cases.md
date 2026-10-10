# Manual test cases

These cases describe documented behavior. Current results link to versioned runs.
A dash in Tested package version means no package has been tested.
See [Senior Manual QA](../manual-qa.md) for invocation and package setup.
Use the PR #47 `bug-lab/bugbench.c` sample workload for owned test processes.
The [bug lab cases](bug-lab-cases.md) define QA-101 through QA-120.

## Current results

| Case ID | Status | Tested package version | Run | Evidence |
| --- | --- | --- | --- | --- |
| QA-001 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Healthy page](runs/20261009T035640Z-v0.1.0/evidence/healthy.txt) |
| QA-002 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Reloaded page](runs/20261009T035640Z-v0.1.0/evidence/target-reload.txt) |
| QA-003 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Validation text](runs/20261009T035640Z-v0.1.0/evidence/target-validation.json) |
| QA-004 | BLOCKED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Tool errors](runs/20261009T035640Z-v0.1.0/evidence/browser-tool-errors.txt) |
| QA-005 | BLOCKED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Tool errors](runs/20261009T035640Z-v0.1.0/evidence/browser-tool-errors.txt) |
| QA-006 | BLOCKED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Release metadata](runs/20261009T035640Z-v0.1.0/evidence/release.json) |
| QA-007 | NOT_RUN | - | - | - |
| QA-008 | NOT_RUN | - | - | - |
| QA-009 | NOT_RUN | - | - | - |
| QA-010 | NOT_RUN | - | - | - |
| QA-101 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Healthy page](runs/20261009T035640Z-v0.1.0/evidence/healthy.txt) |
| QA-102 | BLOCKED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [CPU page](runs/20261009T035640Z-v0.1.0/evidence/cpu-spin.txt) |
| QA-103 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Full retry](runs/20261009T035640Z-v0.1.0/evidence/cpu-oversub-retry.txt) |
| QA-104 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Quota page](runs/20261009T035640Z-v0.1.0/evidence/cpu-throttle.txt) |
| QA-105 | FAILED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [First page](runs/20261009T035640Z-v0.1.0/evidence/yield-storm.txt) |
| QA-106 | FAILED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Contention page](runs/20261009T035640Z-v0.1.0/evidence/lock-convoy.txt) |
| QA-107 | FAILED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Deadlock page](runs/20261009T035640Z-v0.1.0/evidence/deadlock.txt) |
| QA-108 | FAILED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Growth page](runs/20261009T035640Z-v0.1.0/evidence/mem-leak.txt) |
| QA-109 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Pressure page](runs/20261009T035640Z-v0.1.0/evidence/mem-oom.txt) |
| QA-110 | FAILED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Address-space page](runs/20261009T035640Z-v0.1.0/evidence/vm-bloat.txt) |
| QA-111 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Descriptor page](runs/20261009T035640Z-v0.1.0/evidence/fd-leak.txt) |
| QA-112 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Btrfs retry page](runs/20261009T035640Z-v0.1.0/evidence/disk-sync-retry.txt) |
| QA-113 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Fault page](runs/20261009T035640Z-v0.1.0/evidence/major-faults.txt) |
| QA-114 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [TCP page](runs/20261009T035640Z-v0.1.0/evidence/tcp-slow.txt) |
| QA-115 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [UDP page](runs/20261009T035640Z-v0.1.0/evidence/udp-drop.txt) |
| QA-116 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Socket page](runs/20261009T035640Z-v0.1.0/evidence/close-wait.txt) |
| QA-117 | FAILED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Listen page](runs/20261009T035640Z-v0.1.0/evidence/listen-full.txt) |
| QA-118 | BLOCKED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Churn page](runs/20261009T035640Z-v0.1.0/evidence/thread-churn.txt) |
| QA-119 | FAILED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Thread-growth page](runs/20261009T035640Z-v0.1.0/evidence/thread-leak.txt) |
| QA-120 | PASSED | 0.1.0 | [Run](runs/20261009T035640Z-v0.1.0/index.md) | [Final stopped page](runs/20261009T035640Z-v0.1.0/evidence/stopped-final.txt), [resumed page](runs/20261009T035640Z-v0.1.0/evidence/stopped-final-resumed.txt) |

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

Source: [Package installation](../../README.md#install-from-a-release-package).

## QA-002: Change target by PID

Feature: Target control. Priority: High. Case revision: 1.

Preconditions: QA-001 setup is running. Python and local target control are
available. Two owned processes with different PIDs are running.

1. Open the dashboard. Select **Change target**.
2. Enter the second process PID. Select **Monitor**.
3. Wait for its samples. Reload the page.

Expected results: The dashboard identifies the second process and displays
its threads. The saved target remains selected after page reload.

Source: [Target control](../../README.md#quick-start).

## QA-003: Invalid target input

Feature: Target validation. Priority: High. Case revision: 1.

Preconditions: QA-002 setup is available. A valid target is selected.

1. Open **Change target**. Clear the target field. Select **Monitor**.
2. Inspect the validation message and the current target.
3. Enter a nonexistent numeric PID. Select **Monitor**.
4. Inspect the validation message. Close the form and reload the dashboard.

Expected results: Both invalid inputs are rejected with a form validation
message. The original target remains active and saved.

Source: [Target validation](../../README.md#quick-start).

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

Source: [Named targets](../../README.md#quick-start).

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

Source: [Dashboard and replay](../../README.md#reference).

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

Source: [Package upgrade](../../README.md#install-from-a-release-package).

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
