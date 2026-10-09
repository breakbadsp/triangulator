# Manual test cases

These cases describe documented behavior. No case has been executed in this
change. A dash in Tested package version means no package has been tested.
See [Senior Manual QA](../manual-qa.md) for invocation and package setup.
Use the PR #47 `bug-lab/bugbench.c` sample workload for owned test processes.
The [bug lab cases](bug-lab-cases.md) define QA-101 through QA-120.

## Current results

| Case ID | Status | Tested package version | Run | Evidence |
| --- | --- | --- | --- | --- |
| QA-001 | NOT_RUN | — | — | — |
| QA-002 | NOT_RUN | — | — | — |
| QA-003 | NOT_RUN | — | — | — |
| QA-004 | NOT_RUN | — | — | — |
| QA-005 | NOT_RUN | — | — | — |
| QA-006 | NOT_RUN | — | — | — |
| QA-101 | NOT_RUN | — | — | — |
| QA-102 | NOT_RUN | — | — | — |
| QA-103 | NOT_RUN | — | — | — |
| QA-104 | NOT_RUN | — | — | — |
| QA-105 | NOT_RUN | — | — | — |
| QA-106 | NOT_RUN | — | — | — |
| QA-107 | NOT_RUN | — | — | — |
| QA-108 | NOT_RUN | — | — | — |
| QA-109 | NOT_RUN | — | — | — |
| QA-110 | NOT_RUN | — | — | — |
| QA-111 | NOT_RUN | — | — | — |
| QA-112 | NOT_RUN | — | — | — |
| QA-113 | NOT_RUN | — | — | — |
| QA-114 | NOT_RUN | — | — | — |
| QA-115 | NOT_RUN | — | — | — |
| QA-116 | NOT_RUN | — | — | — |
| QA-117 | NOT_RUN | — | — | — |
| QA-118 | NOT_RUN | — | — | — |
| QA-119 | NOT_RUN | — | — | — |
| QA-120 | NOT_RUN | — | — | — |

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
