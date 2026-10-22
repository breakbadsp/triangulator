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
| QA-001 | PASSED | source 384352f | [Run](runs/20261020T191300Z-source-384352f-multi-target/index.md) | [API targets](runs/20261020T191300Z-source-384352f-multi-target/evidence/qa001-002-api-targets.txt) |
| QA-002 | PASSED | source 384352f | [Run](runs/20261020T191300Z-source-384352f-multi-target/index.md) | [API targets](runs/20261020T191300Z-source-384352f-multi-target/evidence/qa001-002-api-targets.txt) |
| QA-003 | PASSED | source 384352f | [Run](runs/20261020T191300Z-source-384352f-multi-target/index.md) | [Browser observations](runs/20261020T191300Z-source-384352f-multi-target/evidence/browser-observations.txt) |
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
| QA-082 | NOT_RUN | - | - | - |
| QA-083 | NOT_RUN | - | - | - |
| QA-084 | NOT_RUN | - | - | - |
| QA-085 | NOT_RUN | - | - | - |
| QA-086 | NOT_RUN | - | - | - |
| QA-087 | NOT_RUN | - | - | - |
| QA-088 | NOT_RUN | - | - | - |
| QA-089 | NOT_RUN | - | - | - |
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

## QA-073: Five production targets remain separate

Feature: Multi-target investigation. Priority: High. Case revision: 1.

Preconditions: One packaged sampler monitors five owned bugbench processes.
Use target IDs `control`, `cpu`, `memory`, `fds`, and `locks` for `healthy`,
`cpu-spin`, `mem-leak`, `fd-leak`, and `deadlock`. Enable resources and memory.

1. Select each target in the target picker. Wait for its named process and PID.
2. Compare thread names, counts, CPU use, RSS, descriptor limits, and wait states.
3. Keep a second tab on `cpu`. Switch the first tab through the other targets.
4. Reload an explicit target URL.

Expected: All five processes appear under one sampler. Each selected view shows
only its process, threads, resources, and memory. The other tab keeps its target.
An explicit target URL restores that target. Shared host and cgroup values are
labelled with their scope.

## QA-074: One of five production processes stops and restarts

Feature: Multi-target lifecycle. Priority: High. Case revision: 1.

Preconditions: QA-073 setup. Select targets by exact process name. Keep `locks`
and `control` in separate tabs.

1. Stop only the `deadlock` fixture. Inspect both tabs and the picker.
2. Start a new `deadlock` fixture with the same process name.
3. Inspect the old view, then select Show live.

Expected: Only `locks` becomes absent. Its final view identifies the old PID and
exit. The restarted process has a new PID. The final view names the new process
without replacing its old data. Show live displays the new process. Other
processes remain live.

## QA-075: Thread drawer preserves a target URL

Feature: Multi-target links. Priority: High. Case revision: 1.

Preconditions: At least two targets with threads. Open an explicit URL for a
nondefault target. Use a fresh browser profile.

1. Open a thread row. Check the URL target and thread fragment.
2. Close the drawer with Escape. Check the URL and selected target.
3. Restore the explicit URL. Open the thread and close it with Close thread details.
4. Open the resulting URL in the second profile.

Expected: Both close actions remove only the thread fragment. The target query
remains. The second profile opens the same process.

## QA-076: Add and remove a sixth investigation target

Feature: Local target management. Priority: High. Case revision: 1.

Preconditions: QA-073 setup with at least one free collector target slot. A
second tab observes another target. Record the sampler PID and configuration.

1. In Manage targets, enter `extra` and an owned PID. Select Add target, then
   cancel confirmation. Check the target list and configuration.
2. Repeat the add and confirm. Wait for `extra` in both target pickers.
3. Remove `extra` and confirm. Wait for it to leave both pickers.
4. Try an existing ID. Confirm if asked. Inspect the error and configuration.

Expected: Cancel makes no change. Confirmed add and removal update both viewers
and keep the same sampler process. Existing targets remain available. A duplicate
ID is rejected and preserves the configuration.

## QA-077: Five-target diagnosis includes the fault findings

Feature: Multi-target diagnosis. Priority: High. Case revision: 1.

Preconditions: QA-073 setup. Use the fault expectations of QA-101, QA-102,
QA-107, QA-108, and QA-111. Keep the memory target open for at least 70 seconds.

1. Inspect the healthy and CPU targets. Open the hot worker detail.
2. After at least 70 seconds, inspect the deadlock target and its waiting workers.
3. Inspect descriptor count, soft limit, and top assessment after exhaustion.
4. Observe memory growth for 70 seconds without switching its tab. Inspect Memory
   and the top assessment. Compare the other target tabs.

Expected: Healthy has no process resource-fault warning. CPU identifies the hot
worker. Locks shows a possible stuck-thread hint and wait duration without a
proved-deadlock claim. Descriptor exhaustion appears in Resources and assessment.
Sustained RSS growth appears in Memory and a warning in assessment. Findings
refer to the correct process. Sampler-budget and host-scope facts remain distinct.

## QA-078: Collector target capacity with five active processes

Feature: Target capacity. Priority: Medium. Case revision: 1.

Preconditions: Five active targets. Set collector `max_targets = 5` before start.
Record the sampler configuration and sessions.

1. Try to add a sixth owned target through Manage targets.
2. Inspect validation, all five existing targets, and the configuration.
3. Remove one target. Add the sixth target. Wait for its samples.

Expected: An add beyond capacity has a clear error and preserves active targets.
After a slot is free, the new target becomes live. No target receives another
process's data.

## QA-079: Kernel crash message on WSL2

Feature: Process exit reasons. Priority: High. Case revision: 1.

Preconditions: A WSL2 distribution with `kernel.dmesg_restrict = 0`. Check
that `readlink /proc/self/ns/pid` is not `pid:[4026531836]`. The dashboard is
open with live samples.

1. Monitor the `bug-lab` `mem-oom` workload until the OOM killer ends it.
2. Compare the PID on the Last process exit card with the PID in
   `dmesg | grep 'Killed process'`. They differ.
3. Monitor an owned target that writes through a null pointer, and wait for
   the segfault.

Expected: The card shows "Killed by the out-of-memory killer" and then
"Segmentation fault", not "No kernel crash message". Kernel messages show the
kernel lines with the outer PID and the target's name.

## QA-067: Single-target install after a collector-only upgrade

Feature: Multi-target compatibility. Priority: High. Case revision: 1. Status: NOT_RUN.

Preconditions: A single-target install from before multi-target support
(package 0.1.0, or a source build of commit c7b46cd) monitors one owned
process. It has thread history, recordings, and saved watch rules. Keep its
sampler binary and configuration files.

1. Record the target label, PID, thread list, oldest thread-history sample,
   recording list, saved watch rules, and `/api/health`.
2. Stop only the collector. Install the new collector. Keep `collector.toml`
   unchanged, then start the collector.
3. Open the dashboard without `?target=`. Compare everything from step 1.
4. Run the QA-005 and QA-036 steps on this install.
5. Keep the same workload for 10 minutes at the same rate. Compare how far
   back thread history reaches with the old install.
6. Read `/api/targets`, and read `/api/live` with and without `?target=`.

Expected: The collector starts with the old configuration file. The dashboard
shows a plain target label, no target picker, and no budget badge. PID,
threads, recordings, and watch rules match step 1. Thread history reaches as
far back as before. The old sampler appears as one `default` target, and
`/api/live` returns the same data with and without `?target=`.

## QA-068: Sampler upgrade with an unchanged single-target configuration

Feature: Multi-target compatibility. Priority: High. Case revision: 1. Status: NOT_RUN.

Preconditions: QA-067 has passed. The sampler configuration still uses
`target_process` or `target_pid`, not `[[target]]` tables.

1. Stop the old sampler. Install the new sampler, then start it with the same
   configuration file.
2. Check that the recordings, watch rules, and history from before the upgrade
   are still shown for the same target.
3. Restart the collector while the sampler runs. Then restart the sampler
   while the collector runs.
4. Stop both. Start the sampler, wait 5 seconds, then start the collector.
5. After each restart in steps 3 and 4, check the memory map, the recordings,
   and the watch rules.
6. Compare sampler CPU and RSS with the old sampler for the same workload.

Expected: The target is still the `default` target. It keeps all earlier
recordings, watch rules, and history, and it has gaps only during outages.
After every restart the memory map appears within a few seconds. One sampler
process runs. Its CPU use is close to the old sampler's. With the default
budget, the effective rate equals `rate_hz` and no throttle badge appears.

## QA-069: Change the single target through the API and scripts

Feature: Multi-target compatibility. Priority: High. Case revision: 2. Status: NOT_RUN.

Preconditions: QA-068 setup. A local sampler and a loopback dashboard. Two owned
processes, A and B. The sampler monitors A.

1. With `POST /api/target` (JSON `{"target":"PID"}` and `X-Triangulator: 1`),
   switch monitoring from A to B by PID.
2. Switch to a process name that is not running yet, then start it. Send an
   empty target and a nonexistent PID.
3. Run `scripts/set-target.sh <pid>` and `scripts/set-target.sh <name>`.
   Run `scripts/set-rate.sh 2`, then `scripts/set-rate.sh 5`.
4. After each change, reload the dashboard. Check the saved watch rules, the
   earlier recordings, and `GET /api/target`.
5. In Manage targets, add a second target, then remove it. Repeat steps 1-4.
6. Add an address that is not loopback to `sampler_ips`, or bind the dashboard
   to an address that is not loopback. Check target control in the dashboard
   and through `POST /api/target`.

Expected: You can change the single target through `POST /api/target` and the
one-argument script without a target ID, as before. The dashboard offers
Manage targets, which adds or removes targets by ID. The target stays `default`
and keeps its watch rules and earlier recordings. Invalid input changes
nothing. The one-argument script and `/api/target` work before and after the
add-and-remove cycle. A setup with a remote sampler or a dashboard that is not
loopback offers no target control, and the API refuses the change.

## QA-070: Shipped and earlier configuration files

Feature: Multi-target compatibility. Priority: High. Case revision: 1. Status: NOT_RUN.

Preconditions: The new collector and sampler binaries, and the configuration
files of the install from QA-067.

1. Start the collector with each configuration in turn: the shipped
   `config/collector.toml` unchanged, the earlier `collector.toml`, one with
   `sampler_ip = "127.0.0.1"`, and one with a `sampler_ips` list.
2. Start the sampler with the shipped `config/sampler.toml` and with the
   earlier `sampler.toml`.
3. Set `max_targets = 8` with `max_live_samples = 2000000`. Then try
   `max_targets = 0` and `max_targets = 65`.
4. Run the QA-001 steps with `scripts/start.sh` and `scripts/stop.sh`.
5. While the sampler runs, write an invalid `[[target]]` table and send SIGHUP.

Expected: Every valid configuration starts without edits. Each invalid
`max_targets` or `max_live_samples` value fails at startup with a message that
names the key. The invalid reload is rejected, and the running targets
continue unchanged.

## QA-071: Two or three targets: add, remove, and re-add

Feature: Multi-target lifecycle. Priority: High. Case revision: 2. Status: NOT_RUN.

Preconditions: A local sampler and a loopback dashboard with one `default`
target. Owned processes A (monitored), B, and C.

1. In Manage targets, add `b` for B. Check that `default` keeps its session,
   history, and recordings.
2. Open one tab on `default` and one on `b`. Remove `b`. Reload the `b` tab.
3. In the `b` tab, request `/api/history`, `/api/resources`, `/api/replay`, and
   `/api/live` with `?target=<host>/b`.
4. Add `b` again for C within one second of removing it. Keep it open for
   2 minutes.
5. Add `c` for B, for three targets. Check each tab. Stop process B.
6. In Manage targets, remove `c` and `b`.

Expected: Adding or removing one target never interrupts the others. A
removed target's tab still loads the dashboard and keeps the picker visible to
choose another target. Its data requests return HTTP 404 and never show
another target's data. A target removed with `scripts/set-target.sh --remove`
instead stays listed as silent until `target_idle_expiry_s`, because the
collector does not see that change. A target that is removed and quickly added again stays
live. With three targets, each tab shows only its own target, and only the
stopped target becomes absent. Back at one target, the label is plain, the
picker is hidden, and the earlier recordings remain.

## QA-072: Freed target slots and a paused sampler

Feature: Multi-target lifecycle. Priority: Medium. Case revision: 1. Status: NOT_RUN.

Preconditions: The collector uses `max_targets = 2` and
`target_idle_expiry_s = 60`. One local sampler monitors `default` and `b`.

1. Rename `b` to `c` in the sampler configuration by hand. Send SIGHUP. Watch
   `/api/targets` for 2 minutes.
2. Pause the sampler with `kill -STOP` for 30 seconds, then send `kill -CONT`.
3. Pause the sampler for 90 seconds, then send `kill -CONT`.

Expected: `c` stays absent while both slots are in use. It appears soon after
`b` has been silent for 60 seconds, and `b`'s stored history remains. After
either pause, all targets return to live without a restart. No target stays
missing or inactive.

## QA-064: Per-target watch settings and recordings

Feature: Target settings. Priority: High. Case revision: 2. Status: NOT_RUN.

Preconditions: Two targets have distinct thread names. Both have recordings.

1. Open each target in a separate tab. Save a different watch rule in each tab.
2. Check the thread watch values. Reset one target and check the other target.
3. Restart the collector. Check that each saved rule remains with its target.
4. Set one target's `replay_interval_s` to 0 in its collector `[[target]]`
   table. Restart the collector and inspect each target's recordings.
5. Upgrade a single-target data directory. Check its saved watch rules and
   old recordings through the `default` target.
6. List the larger sampler address first in `sampler_ips`. Run a `default`
   target on each host. Save a watch rule for each `default` target.
7. Start a sampler before the collector, so the collector hears samples before
   the TTGT of the target with `replay_interval_s = 0`.

Expected: Changes affect only the selected target. Saved settings survive a
restart. A disabled recording interval stops new recordings for that target,
also after a late TTGT names it. Old default settings and recordings remain
available. Only the `default` target of the smallest address uses
`data_dir/watch-rules.json` and `data_dir/replay`; the other `default` target
uses its own files.

## QA-065: Target control commands

Feature: Target configuration. Priority: High. Case revision: 1. Status: NOT_RUN.

Preconditions: One local sampler runs two named targets.

1. Run `scripts/set-target.sh ID NAME|PID` for one configured target.
2. Use `--add ID NAME|PID` and `--remove ID`. Check the dashboard after each command.
3. Run `scripts/set-rate.sh HZ`. Check that all configured target IDs remain.
4. Try an invalid ID, a duplicate ID, and removal of the last target.
5. Run `scripts/set-target.sh --help`. Check that the configuration does not change.

Expected: Valid commands update and reload the same sampler process. A selector
change affects only its target. A rate change applies to all targets. Invalid
commands preserve the configuration.

## QA-066: Socket reports across hosts

Feature: Target socket data. Priority: High. Case revision: 2. Status: NOT_RUN.

Preconditions: Two allowed sampler hosts have targets with the same PID.
Each host runs its optional socket observer with a distinct observer ID.

1. Select each target. Compare its socket report with its host's workload.
2. Stop one socket observer. Check the other target's report.
3. Request a selected target with the other host's observer ID.
4. Stop both socket observers and restart the collector. Select a target whose
   PID is unique, then call `/api/socket-io` without `?target=`.

Expected: Each selected target shows only its host's socket observations.
A request with the wrong observer ID is rejected. After the restart, the
unique-PID target and the bare call (the default target) still show the
stored totals and history; a target whose PID another target shares reports
no socket observations until its observer reports.

## QA-061: Per-tab target selection

Feature: Dashboard target selection. Priority: High. Case revision: 2. Status: NOT_RUN.

Preconditions: Two targets have different PIDs, thread names, and stored views.

1. Open two tabs with different `?target=<host>/<id>` values.
2. Set a filter, select a thread, open memory details, and inspect a recording.
2a. Close the thread drawer with Escape, then with Close thread details. Check that the URL keeps `?target=` and drops `#thread=`.
3. Switch one tab to the other target. Check that those view choices reset.
4. Check that the second tab retains its target. Open the first tab's URL again.
5. Open a new tab at the dashboard URL without `?target=`. Check that the Targets overview opens and no earlier target opens.
6. Test one target and an unavailable target in the URL. Test narrow screen and zoom.

Expected: Each tab shows only its selected target. A switch does not change
sampler configuration. One target uses a plain label. Links retain selection.
A new tab does not reopen the last target.

## QA-062: Manage local targets

Feature: Dashboard target management. Priority: High. Case revision: 3. Status: NOT_RUN.

Preconditions: A local sampler uses a runtime configuration owned by the user.
The dashboard listens on loopback. A second browser tab observes the targets.

1. On the Targets overview, select Add target. Check that a dialog opens with
   focus in Target ID, and that Escape and Cancel close it.
2. Add a target with a new ID. Cancel confirmation, then confirm it. Check
   that the dialog closes and the status line under the heading reports it.
3. Check that all viewers see the new tile and existing sessions stay.
4. Select Remove on that tile. Check that it leaves the overview in both tabs.
5. Try a duplicate ID, invalid ID, stale selector, and removal of the last
   target (Remove is disabled when one target is left).
6. Check that a target page has no Manage targets control, and that tiles of
   a remote sampler host have no Remove.
7. With the dialog open, select the help button beside its heading. Check
   that the guide opens and its controls work. Check that a remote dashboard
   shows no control error under the Targets heading.
8. Add a target in the second tab. Check that Remove updates in the first tab
   without a reload.

Expected: Only confirmed changes edit the sampler configuration. Invalid or
stale changes preserve it. One sampler process handles the resulting set.

## QA-063: Target access and sampler budget badges

Feature: Dashboard target status. Priority: High. Case revision: 2. Status: NOT_RUN.

Preconditions: Targets include limited access and a throttled sampler.

1. Select the limited-access target. Read its badge and contextual help.
2. Select a throttled target. Compare CPU, effective rate, and budget with the API.
3. Make an unselected target absent or silent. Check the attention count.
4. Select another target. Check the count and badges for the selected target.
5. Open help with keyboard focus. Check the labels in light and dark themes.

Expected: Badges explain access limits and the shared sampler CPU budget.
The attention count excludes the selected target. Help does not change selection.

## QA-060: Sampler CPU budget

Feature: Sampler CPU budget. Priority: High. Case revision: 1. Status: NOT_RUN.

Preconditions: One sampler monitors enough owned threads to exceed a small
configured `cpu_budget_pct`. A matching collector lists its targets.

1. Set `rate_hz=5` and `cpu_budget_pct=0.1`. Observe at least 10 seconds.
2. Check that all targets report the same lower effective rate.
3. Check that CPU use, the budget, and the configured rate remain visible.
4. Reduce the target thread count. Observe rate recovery after low CPU use.
5. Check that every target session stays the same during each rate change.

Expected: The rate decreases after excess CPU use and stays at or above
0.2 Hz. The rate increases after sustained low CPU use. History stays valid.

## QA-059: Multiple sampler targets and reload

Feature: Multiple sampler targets. Priority: High. Case revision: 1. Status: NOT_RUN.

Preconditions: One sampler and a matching collector. Two owned test processes.

1. Configure two `[[target]]` tables with distinct IDs. Start the sampler.
2. Check that one sampler process and one thread report both target sessions.
3. Add a third target and send SIGHUP. Check that the first two sessions stay.
4. Reorder the tables and send SIGHUP. Check that all sessions stay.
5. Change `rate_hz` and send SIGHUP. Check that all sessions change.
6. Stop one process. Check that only its target becomes absent.
7. Use an invalid or duplicate ID. Check that reload retains the old settings.

Expected: Target streams stay separate. Resource and memory-map samples rotate
across targets. Invalid settings cannot replace a running configuration.

## QA-058: Target API selection

Feature: Multiple target API. Priority: High. Case revision: 1. Status: NOT_RUN.

Preconditions: A collector accepts two announced targets with different IDs.

1. Read `/api/targets`. Check the host, ID, PID, session, status, and access.
2. Read `/api/live?target=<host>/<id>` for each target in separate clients.
3. Read resource history and replay for each target. Check the PID and session.
4. Replace one target process. Check that only its session changes.
5. Read an unknown key. Check that the API returns HTTP 404.

Expected: Each response contains only the selected target. The default API
uses `default` when present, then the first key by host and ID.

## QA-045: Concurrent viewers and slow connections

Feature: Dashboard HTTP concurrency. Priority: High. Case revision: 1.

Preconditions: An isolated matching package monitors an owned process. Use
20 independent Chrome profiles or devices. Use only the test runtime's ports.
Prepare a TCP client that can hold an incomplete HTTP request open.

1. Open the dashboard in all 20 views. Compare the current PID and freshness.
2. Keep one raw connection idle. Keep another connection sending an incomplete
   header one byte per second. Observe all dashboard views for 10 seconds.
3. Inspect a recording or thread history in one view. Keep the others live.
4. Close the raw connections. Check that all live views continue to refresh.
5. Stop and restart the test collector. Observe both the outage and recovery.

Expected results: Slow connections do not stop other views from refreshing.
An incomplete request closes after its total five-second read deadline even
when bytes keep arriving. History and replay stay local to their view. All
views identify an outage and recover without presenting stale data as fresh.
Automated HTTP tests alone do not satisfy these browser expectations.

## QA-046: Conflicting watch-rule saves and resets

Feature: Shared watched-thread settings. Priority: High. Case revision: 1.

Preconditions: An isolated package supports conditional watch-rule updates.
Two Chrome views load the same saved rules in Settings.

1. Edit a rule in A and a different rule in B. Save A, then save B.
2. Check B's fields, conflict message, Save, Reset to config file, and
   Reload current rules. Inspect A's saved rules from a fresh view.
3. Select Reload current rules in B and cancel. Repeat with a failed network
   read. Then restore the connection and confirm the reload.
4. Edit and save from B. Check that the reviewed current rules remain unless
   the operator deliberately changed them.
5. Load the saved rules in A and B again. Save a change in A, then attempt
   Reset to config file in B. Check the conflict and the saved rules.
6. Restart the collector while an edited draft is open. Attempt to save it.
7. Open help for Save, Reset to config file, and Reload current rules.

Expected results: A stale save or reset returns HTTP 409 and changes no saved
rule. The draft stays visible. Save and Reset remain off until current rules
are loaded. Cancel and a failed reload preserve the draft. A successful reload
replaces it only after confirmation and enables editing of the current list.
A collector restart also refuses an earlier draft. Help explains that settings
are shared, why the change was refused, and how to retain edits before reloading.
Leave this case NOT_RUN until these steps are executed in the browser.

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

Feature: Dashboard target exit. Priority: High. Case revision: 3.

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
4. Drag the **Timeline** back to an earlier time and release, then select **Live**. Verify the
   final view returns, not an empty page. Repeat with a live target: open a
   recording, kill and restart the process, then select **Live**. Verify the
   final view of the old process appears, not the new process.
5. Open a new browser tab. Verify it shows the final view without earlier
   trends.
6. Start a new target. Verify the banner names its PID and the final view stays.
   Select **Show live** and verify the new target appears and the banner closes.
7. In Manage targets, add a target with a process name that is not running.
   Select it in the target selector. Verify that it shows as absent with no
   final view.
8. Pause over the banner. Verify its help explains the final view and its limits.

Expected results: The exited process stays inspectable until **Show live**.
Nothing is cleared silently. A newly selected target is not reported as an exit.

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

Feature: Process exit reasons. Priority: High. Case revision: 3.

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
7. End the target again, then run `scripts/set-target.sh ID NAME` with a
   process name that is not running. Verify the Assessment says
   "Target process is absent", not
   "Target process ended", and the header does not use the ended process's
   name.
8. Open a recording after the exit on the Timeline. Verify the card shows the recorded
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

Feature: Dashboard navigation. Priority: Medium. Case revision: 2.

Preconditions: The dashboard is open with live samples.

1. Open the page at the top. Verify that Summary is highlighted.
2. Select each section tab. Verify that exactly one tab is highlighted and has
   `aria-current="location"`. Use the keyboard to select a tab.
3. Scroll down and up through the sections without selecting tabs. Verify that
   the highlight follows the section below the header.
4. Scroll to the bottom. Verify that Settings is highlighted.
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

## QA-002: Add a target by PID

Feature: Target control. Priority: High. Case revision: 2.

Preconditions: QA-001 setup is running. Python and local target control are
available. Two owned processes with different PIDs are running. Use one free target slot.

1. Open the dashboard. On the Targets overview, select the **Add target** tile.
2. Enter a new target ID and the second process PID. Select **Add target**,
   then accept the confirmation.
3. Select the new target's tile. Wait for its samples. Reload the page.

Expected results: The new target is listed. The dashboard identifies the
second process and displays its threads. The first target continues to report.
The selected target remains selected after page reload.

Source: [Target control](../setup.md#quick-start).

## QA-003: Invalid target input

Feature: Target validation. Priority: High. Case revision: 2.

Preconditions: QA-002 setup is available. A valid target is selected.

1. On the Targets overview, open **Add target**. Enter a new target ID. Clear the process field.
   Select **Add target**.
2. Inspect the validation message and the configured targets.
3. Enter a nonexistent numeric PID. Select **Add target**.
4. Inspect the validation message. Close the form and reload the dashboard.

Expected results: Both invalid inputs are rejected with a validation message,
and no confirmation is shown. No target is added. The original targets remain
active and saved.

Source: [Target validation](../setup.md#quick-start).

## QA-004: Wait for a named process

Feature: Target lifecycle. Priority: High. Case revision: 2.

Preconditions: Local target control is available. Choose an exact Linux process
name of at most 15 bytes. No process with that name is running. Prepare an owned
test process that can start with this name.

1. In **Manage targets**, add a new target ID with the absent process name.
   Accept the confirmation. Select the new target in the target selector.
2. Inspect the dashboard after the sampler reloads.
3. Start the prepared process with that exact name.
4. Wait for samples. Stop only that process. Wait for the next target scan.

Expected results: The name is accepted. The dashboard first reports the target
as absent, then identifies it and shows threads when it starts. After the
process stops, the target is absent again, and the tab keeps the final view of
the process with a **Show live** banner
([final view](../collector-reference.md#final-view-after-the-target-exits)).
A selector changed on an existing target with `scripts/set-target.sh ID NAME`
also keeps the earlier process's final view until **Show live**: the tab cannot
tell this change from an exit.

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

Feature: Agent and command workload session. Priority: Medium. Case revision: 2.

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
6. Add a PATH symlink to `scripts/bugbench-session` as described in
   [Bug lab](../../bug-lab/README.md). Change to a directory outside the checkout.
   Run `bugbench-session --help`, then run it with no action and the same
   `--home` test directory. Verify that it resumes the saved scenario.
7. Use the command's `list`, `next`, `previous`, `run healthy --seconds 60`,
   `status`, and `stop` actions. Verify that the command and agent share the
   saved position and limits. Reject an unknown scenario or a nonpositive
   duration without stopping a running scenario.

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

Feature: Dashboard process details. Priority: Medium. Case revision: 2.

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
6. Restart the target, or select another target in the target selector. Watch
   the card.
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

Feature: Summary process load. Priority: Medium. Case revision: 2.

1. Monitor a process whose RSS grows, for example a bug-lab leak workload.
   Keep the Summary open for at least two minutes.
2. Switch the chart window between 1 min, 5 min, and 15 min.
3. Hover each chart. Open help from the Resident memory (RSS) and Virtual size
   (VmSize) labels.
4. Inspect a recorded moment, then return to Live.
5. Set `memory_interval_s = 0` and restart the sampler, so memory-map sampling
   is off.

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

Feature: Collector watch activity. Priority: High. Case revision: 2.

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
The Assessment warns that the TID is set to wake at least every 1000 ms but has
not run for the elapsed time.

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
6. On the **Timeline**, open a recording from after step 1 and read the Assessment.
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

Feature: Dashboard watched-thread assessment. Priority: High. Case revision: 2.

Preconditions: Use the `cpu-spin` scenario (threads `worker-spin` and
`worker-poll`) with an isolated runtime directory and unused ports.

1. Add the rules `worker-spin` with `wake_ms` 500 and `gone-` with `wake_ms` 200.
   Wait about 10 seconds.
2. Read the Assessment and its help for each watched finding.
3. Replace the rules with `misc-` at 1000 ms. Wait for the next refresh.
4. Run `scripts/set-target.sh ID PID` for a process that has no `misc-` thread.
   The target keeps its ID, so its watch rules stay. If a final view banner
   appears, select **Show live**.
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
3. Make an unsaved edit, then use the **Timeline** to open a recording.
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

## QA-038: Timeline and past assessments show a recorded finding

Feature: Timeline. Priority: High. Case revision: 5.

Preconditions: Use an isolated runtime, unused ports, and enabled recording.
Use a bug-lab workload that can switch between healthy activity and a CPU spin.
Record both states before opening the dashboard.

1. Open **Timeline**, then **Past assessments**. Read the Timeline marks and
   Past assessments rows. Compare their times with
   the controlled CPU spin.
2. Select the spin finding. Scroll through the dashboard and read the top bar,
   Assessment, and thread table. Compare them with the selected recording.
3. Select **Back to live**. Drag the handle onto the finding mark and release
   it. Use **◀** and **▶**. Release the handle at the right end.
4. From Live, use one ArrowLeft step on the handle and release it. Then move
   it to the right end again. Repeat after new live samples arrive.
5. Change each severity checkbox and the type filter. Compare the visible
   rows with the timeline marks.

Expected results: The row and mark identify the controlled finding. Selecting
it moves every panel to its worst recorded moment without scrolling the page.
The row shows its detail and selection, and the top bar identifies the recorded
time. The buttons and handle open recordings consistently. The previous step
opens a recording; the right end returns to Live. Filters change rows and marks
together. Live trends return when the recorded view closes.

## QA-039: Earlier Timeline periods, empty states, and help

Feature: Timeline. Priority: Medium. Case revision: 4.

Preconditions: As QA-038, with at least two hours of recordings. Use a second
isolated collector with recording disabled.

1. Scroll the findings list to its end, select **Load earlier**, and release
   the handle at the left end. Observe the list position and timeline bounds.
2. Stop only the test collector. Select **Load earlier**, then restart it and
   retry. Open the collector with recording disabled.
3. Hover for 1.2 seconds on the Timeline title, handle, marks, **◀**, **▶**,
   **Live**, top-bar return button, Past assessments title, severity controls,
   type filter, row, status line, and **Load earlier**.
4. Open the Timeline and Past assessments guides with pointer and keyboard.
   Check Escape and touch access. Check the controls below 640 pixels wide.

Expected results: Earlier checks extend the timeline without resetting the
list position. The error identifies the failed read and permits a retry. The
collector with recording disabled shows a clear empty state. Help appears for
every control and explains recording gaps, coarse checks, and missing live
trends. The guides remain readable with keyboard and touch. Controls wrap on a
narrow screen, and the list scrolls inside the card.

## QA-047: Simultaneous live dashboard viewers

Feature: Multiple viewers. Priority: High. Case revision: 1.

Preconditions: One isolated packaged collector and sampler monitor an owned
healthy process. Two browser views use separate origins or independent profiles.

1. Open the dashboard in both views. Observe the process name, PID and Connected
   status in each view.
2. Keep both views open for at least 20 seconds. Observe advancing chart times
   and repeated live requests in each view.

Expected results: Both views show the same monitored PID and fresh live data.
Opening the second view does not stop the first view.

## QA-048: Local search and replay state

Feature: Multiple viewers. Priority: High. Case revision: 3.

Preconditions: QA-047 setup. Recording is enabled. Two owned processes run, and
each is a configured target.

1. In A, enter an exact worker name in thread search. Leave B unfiltered.
2. In A, select a recording on the Timeline. Keep B Live. Observe both views.
3. In B, select the second target in the target selector. Observe both views
   again.

Expected results: A retains its search value and historical process. B retains
an empty search and receives live data from the selected process. Replay and
search selections do not propagate between viewers.

## QA-049: Shared target set and another viewer's Manage targets

Feature: Shared target control. Priority: High. Case revision: 2.

Preconditions: Two views show the same owned target. A second owned process
runs. Local target control is available.

1. Put A in replay. In B, add a target for the second PID in Manage targets.
2. Observe that A keeps its recorded view and its selected target.
3. In A, select Live. Verify that A still shows its selected target, and that
   the target selector lists the new target.
4. Open Manage targets in A. Wait for the target list to load and **Add
   target** to become enabled. Read the list without a change.

Expected results: The target set is shared. The selected target and replay
stay local to each view. After the list loads, A lists the target that B added.
A must not show the earlier target set as the current one.

## QA-050: New viewer and stored history

Feature: Multiple viewers and history. Priority: Medium. Case revision: 1.

Preconditions: An isolated packaged collector records an owned target for at
least 60 seconds. A remains open while a fresh browser view is prepared.

1. Open B with empty browser storage. Verify its live process name and PID.
2. Compare the overview trend start in A and B.
3. In B, open a recording from before B opened. Inspect the process name and
   recording time. Return B to Live. Observe A throughout these actions.

Expected results: B shows the current live target. Tab-local trends start when
B opens. Stored recordings remain available in B. B's replay does not change A.

## QA-051: Two viewers after a collector outage

Feature: Multiple viewers and reconnect. Priority: High. Case revision: 1.

Preconditions: An isolated packaged collector and owned sampler are running.
Two views show live data. Only test-owned processes may be stopped.

1. Stop the test collector for 15 seconds. Observe both headers and charts.
2. Restart the same packaged collector with the same configuration and data.
3. Wait for new sampler data. Observe both views without reloading them.

Expected results: Both views identify unavailable or stale data during the
outage. Both resume fresh live data after recovery. Stale charts must not be
presented as fresh observations. Record any need for a manual page reload.

## QA-052: Independent browser engines and profiles

Feature: Browser compatibility for multiple viewers. Priority: High. Case revision: 1.

Preconditions: One isolated packaged service is reachable from two independent
browser profiles. Chromium and Firefox are available. Safari requires an
available supported Apple test device. Record all actual engines and versions.

1. Repeat QA-047 and QA-048 with independent profiles in Chromium and Firefox.
2. Repeat with Safari on an available Apple device.
3. Change the shared target from one browser and inspect the other browser.

Expected results: Live data, local filters, local replay and shared target
behavior match across the tested engines. Record unavailable engines as unrun.
Two tabs or two origins in one engine do not satisfy this case.

## QA-053: Concurrent saved thread watch edits

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

## QA-054: Assessment first and folded panels

Feature: Dashboard layout. Priority: Medium. Case revision: 2.

Preconditions: Use an isolated runtime and a bug-lab workload that can run
healthy and then trigger a warning, such as a CPU spin or packet loss. Clear
this site's browser storage first.

1. Open the dashboard on a healthy target at full width and below 1050 pixels
   wide. Note what is visible without scrolling.
2. Check that Timeline, Past assessments, Process details, Core placement, Network stack
   drops, Address space & zoom, and Monitor health start closed. Open and close
   each with the pointer, then with Tab and Enter.
3. Open Core placement and close Monitor health. Reload the page.
4. Clear storage again. Stop the sampler for longer than its silence timeout,
   or cause packet loss. Watch Monitor health. Repeat with a memory-map warning
   for Address space & zoom, and a resource or network warning, such as a
   slow socket reader, for Network stack drops.
5. Close Monitor health while the problem lasts and wait for several samples.
6. Hover for 1.2 seconds on each panel heading, and open "How to read this
   page".

Expected results: The Assessment verdict and findings are visible without
scrolling at both widths. The Assessment comes before
the metric tiles and the Process load and Memory use cards at every width.
Every panel opens and closes with pointer and keyboard. After
the reload, the panels keep the user's choice. With no saved choice, a panel
opens by itself for a warning or worse of its kind and does not close by
itself. A panel the user closed stays closed. Each heading shows its help
topic, and the page guide explains folded panels.

## QA-055: Dashboard appearance and summary layout

Feature: Dashboard redesign. Priority: Medium. Case revision: 1.

Preconditions: Use an isolated runtime with a healthy target, then a CPU-spin
workload. Clear the site storage. Use desktop and 390-pixel-wide viewports.

1. Read Summary. Check Assessment, metric tiles, Process load, Memory use,
   and the closed Timeline in this order. Confirm that the assessment is
   visible without scrolling. Compare the memory values with their help topics.
2. Select Light and Dark from Theme. Reload after each choice. Select System
   and change the operating system appearance. Check charts, tables, selected
   tabs, the thread drawer, and the help guide in both themes.
3. Use the keyboard to select a theme and open Timeline. Open a past recording,
   then select Live. Close Timeline and reload. Confirm its saved state.
4. Open help for Color theme, Memory use, and Timeline with pointer and keyboard.
5. Check the narrow viewport and 200% browser zoom. Scroll the navigation to
   Settings. Confirm that cards and controls stay within the page. Wide data
   tables must scroll inside their own containers.
6. Start a CPU-spin workload. Confirm that the assessment shows its finding
   with text and a status color. Open the affected thread. With more than 8
   findings, such as a workload with many saturated threads, confirm that
   Show more lists the rest and keeps keyboard focus across live updates.
7. Open the page with the collector unavailable. Confirm that Waiting for data
   has a neutral dot. Block browser storage and change the theme. Confirm that
   the control still works for the current page.

Expected results: Both themes use readable labels and clear keyboard focus.
The selected theme persists when storage is available. System follows the
operating system. Status colors retain their meanings. All existing controls,
recordings, metric values, contextual help, and every Assessment finding remain
available. No page-wide
horizontal overflow occurs at either viewport or at 200% zoom.

## QA-056: Help names the source of each value

Feature: Contextual help. Priority: Medium. Case revision: 1.

Preconditions: An owned workload is monitored with resource and memory-map
samples available. Hover help is on. Note the target PID and one thread TID.

1. Pause over CPU, Run delay, and a thread state in the threads table. Read the
   Source line on each card.
2. Open the guides for CPU, Run delay, Pressure stalls (PSI), Open files, Recv-Q,
   one Network stack drops counter, Virtual size (VmSize), and Exit status.
   Read each Source section.
3. Run two of the Check it yourself commands with the noted PID and TID, such
   as `cat /proc/PID/task/TID/schedstat` and `ls /proc/PID/fd | wc -l`.
4. Open the guides for Color theme and Add watch rule.
5. Repeat step 1 in the dark theme and at a 390-pixel-wide viewport.

Expected results: Each card for a measured value ends with a short Source line
that names its file and field, such as `/proc/PID/task/TID/schedstat`. Each
guide has a Source section that says which program reads the file, how often,
and how the collector or the page derives the shown value. The commands print
the counters the guide names, and their values are consistent with the page.
Values computed in the page, such as Process load and Assessment, say so.
Controls and display settings have no Source section. File paths use code
type, stay readable in both themes, and wrap inside the card.

Source: [Contextual help design](../contextual-help-design.md).

## QA-057: Network counter column names

Feature: Network counter labels. Priority: Low. Case revision: 1.

Preconditions: The dashboard has network resource samples and stored history.

1. Open Network stack drops & errors. Check the short column names:
   Rate (/s), In range, and Total.
2. Pause over each column name for 1.2 seconds. Check that each tooltip
   explains its time period. Open the help guide.
3. Change the selected time range. Compare the count with the latest rate and
   cumulative count. Repeat for a counter without stored history.

Expected results: Help explains events per second, events counted in the
selected range, and the cumulative kernel counter. It gives an example and
explains that other processes can contribute. The cumulative count can include
older events. Missing history shows an unavailable value, not zero.

## QA-080: Thread state colors agree across views

Feature: Thread state colors. Priority: Medium. Case revision: 1.

Preconditions: Run Bugbench `cpu-spin` and select its PID as the target.

1. Open Threads. Compare `worker-hot` with the main thread and `worker-idle`
   threads in the thread map, state chart, current state pills, and Last ~10 s.
2. Compare the `hrtimer_nanosleep` bar in Where threads wait with the Sleep
   legend. Select it and check the table filter. Open a sleeping thread and
   compare its state mix and state history colors.
3. Repeat in Light, Dark, and System themes. Read the Thread states and Wait
   channel help guides.
4. When available, inspect samples with Other and No access. Compare their
   separate state chart bands and legend entries with the map and state mix.
   Check that a state still has a legend entry when only older samples show it.

Expected results: Running is blue. Sleep is green in every state view,
including wait-channel bars. Other and No access use separate gray colors.
Wait-channel groups with multiple states and the combined remaining channels
use neutral gray. The wait-channel filter still selects the matching threads.
Help explains the color mapping and mixed groups.

## QA-081: Past assessments show resident memory growth

Feature: Timeline. Priority: High. Case revision: 1.

Preconditions: Use an isolated runtime, unused ports, enabled recording, and
resource samples. Run the bug-lab `mem-leak` workload for at least 3 minutes,
then stop its growth or the process. Open the dashboard after that.

1. Open **Timeline**, then **Past assessments**. Set the type filter to
   **Memory**. Read the rows and the Timeline marks.
2. Select the "Resident memory grows without a plateau" row. Read the
   Assessment, the Memory section RSS tile, and the top bar.
3. Select **Load earlier** until the leak period is in an earlier period.
   Compare the row times with the first check.

Expected results: A Memory row "Resident memory grows without a plateau"
covers the leak period, with a matching Timeline mark. Selecting it shows the
same finding in the Assessment of the recorded view, and the RSS tile shows the
recorded growth rate. Times in earlier periods can be less exact, but the row
stays.

## QA-082: Targets overview lists every target

Feature: Targets overview. Priority: High. Case revision: 1. Status: NOT_RUN.

Preconditions: Use an isolated runtime and unused ports. Run two bug-lab
workloads, for example `cpu-spin` and `memory-leak`, as two targets.

1. Open `http://127.0.0.1:9401/` without `?target=`.
2. Count the tiles. Compare the count with the monitored targets.
3. Read one tile. Check the status dot, process name, verdict pill, the line
   `host · target-id · PID n`, the worst finding title, and "N more findings".
4. Check the stats Threads, CPU, Memory, and Updated. Check the badges
   "Limited access" and "Sampler throttled" when their condition applies.

Expected results: The Targets overview opens by default. It shows one tile for
each target. Each tile shows its own process, PID, and stats. A badge appears
only when its condition applies.

## QA-083: Tile sort order, level colors, and count pills

Feature: Targets overview. Priority: High. Case revision: 1. Status: NOT_RUN.

Preconditions: Targets at several levels. For example, run `cpu-spin` for a
serious or critical level and `idle-baseline` for a healthy level. Use a target with
no samples for the no data level, if available.

1. Read the order of the tiles. Check that the worst tile is first.
2. Check the left edge of each tile. Red is critical, orange is serious, amber
   is warning, green is healthy, and gray is no data.
3. Read the count pills above the grid. Check that each count equals the
   number of tiles at that level.
4. Read the browser tab title. Check that it starts with "(N) " when N targets
   are at warning or worse. Check that it has no prefix when none are.
5. Check that tiles at the same level sort by target key.

Expected results: Tiles sort worst first, then by key. Each color matches its
level. Each count pill matches its tiles. The tab title count matches the
number of targets at warning or worse.

## QA-084: Open a target from its tile and return

Feature: Targets overview navigation. Priority: High. Case revision: 1. Status: NOT_RUN.

Preconditions: At least two targets. Start with the Targets overview open.

1. Select a tile. Check that the URL changes to `?target=host%2Fid` and that
   the dashboard shows only that target.
2. Select **← All targets** at the left of the top bar. Check that the
   Targets overview opens.
3. Open a tile. Select the browser Back button. Check that the overview returns.
4. Open the dashboard URL with an empty value, `?target=`. Check that the
   collector default target opens.
5. Open a new tab at the dashboard URL without `?target=`. Check that the
   overview opens and that no earlier target opens.
6. Middle-click a tile. Check that a new tab opens that target and that the
   overview tab stays open.

Expected results: Each tile opens its own target. **← All targets** returns to
the overview. Browser Back returns to the overview. An empty `?target=` opens
the default target. A new tab does not reopen the last target. Middle-click
opens the target in a new tab.

## QA-085: Overview empty state and collector outage

Feature: Targets overview. Priority: Medium. Case revision: 1. Status: NOT_RUN.

Preconditions: Use an isolated runtime with a collector that you can stop and
start. Remove all targets for step 1.

1. Open the overview with no targets. Check the text "No targets yet...".
2. Add one target. Check that a tile replaces the empty text.
3. Stop the collector while the overview is open. Wait for one 5 s poll. Check
   the banner "Collector unavailable".
4. Start the collector again. Check that the banner clears and that the tiles
   update.

Expected results: With no targets, the page shows "No targets yet...". When
the collector stops, the banner "Collector unavailable" appears. The banner
clears and the tiles update when the collector returns.

## QA-086: Overview polling and hidden tab

Feature: Targets overview. Priority: Medium. Case revision: 1. Status: NOT_RUN.

Preconditions: At least two targets. Open the overview in one browser tab.
Open the browser network panel.

1. Watch the collector requests for 30 s. Check that the overview requests
   data about every 5 s.
2. Switch to another browser tab for 30 s. Check that the overview sends no
   requests while its tab is hidden.
3. Return to the overview tab. Check that the tiles update.

Expected results: The overview polls every 5 s while its tab is visible. It
polls nothing while its tab is hidden. The tiles update when the tab returns.

## QA-087: Overview in dark and light themes

Feature: Targets overview appearance. Priority: Medium. Case revision: 1. Status: NOT_RUN.

Preconditions: At least two targets at different levels.

1. Set the theme to Dark. Check that the page background is matte black.
2. Check that the status dots, colored left edges, count pills, verdict pills,
   and badges are readable.
3. Set the theme to Light. Check that the overview uses light colors and that
   each level keeps its color meaning.
4. Set the theme to System. Change the operating system between dark and light.
   Check that the overview follows the change.

Expected results: The dark overview has a matte black background. Level
colors keep their meaning in both themes. The overview follows System.

## QA-088: Keyboard focus and help topics on the overview

Feature: Targets overview help. Priority: Medium. Case revision: 1. Status: NOT_RUN.

Preconditions: At least two targets at different levels.

1. Press Tab until a tile has focus. Check that the focus is visible.
2. Press Enter on the focused tile. Check that the target dashboard opens.
3. Return with the browser Back button. Press Tab again. Check that the focus
   order follows the sorted tile order.
4. Focus a tile and wait 1,200 ms. Check that the help card for `fleet-tile`
   opens. Check that its text says the verdict uses only the latest live view
   and that trend rules do not run on tiles.
5. Open the help for the Targets heading. Check that the help card for `fleet`
   describes the level counts. Open its detailed guide from the information
   button.

Expected results: Each tile can get keyboard focus, and Enter opens its target.
The `fleet` and `fleet-tile` help topics open with the same delay and
behavior as other dashboard help.

## QA-089: Select one of several processes with the same name

Feature: Targets overview target management. Priority: Medium. Case revision: 1. Status: NOT_RUN.

Preconditions: QA-062 setup. Start two owned processes with the same name, for
example two copies of `build/buggy-workload idle-baseline`.

1. On the Targets overview, open **Add target**. Enter a new target ID and the
   shared process name. Select **Add target**.
2. Check that the status says how many processes have the name, and that
   **Matching processes** lists each one with its PID, user, start time, and
   command line.
3. Select the second process. Check that its PID fills **Process name or PID**
   and that the status says a PID does not follow a restart.
4. Select **Add target** and confirm. Check that the new tile shows the
   selected PID.
5. Open **Add target** again. Check that the list is hidden.

Expected results: An ambiguous name does not change the configuration. The
list shows every matching process, at most 20. The chosen PID is added.
