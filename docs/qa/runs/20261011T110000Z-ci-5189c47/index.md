# Full-suite browser QA: PR 65 CI build 5189c47

UTC execution: 2026-10-11T10:55Z to 12:00Z.
Target: [PR 65](https://github.com/breakbadsp/triangulator/pull/65), head
`5189c47317e594642ca96e09da58cb1ac14dd657`. This is master plus the memory zoom
changes. It is the newest build with CI binaries; no release contains the help,
memory zoom, or bug-lab finding changes.
Scope: every runnable case: QA-001 to QA-005, QA-007 to QA-009, QA-015, QA-016,
QA-018, and QA-101 to QA-120. Not re-run: QA-006 (no earlier release), QA-011
to QA-014, and QA-017 (PR 65 fixtures; see [earlier run](../20261011T090200Z-pr65/index.md)).
Results: 28 PASSED, 2 FAILED, 1 BLOCKED. QA-010 is in the
[v0.1.0 run](../20261011T095009Z-v0.1.0-retest/index.md).

## Product and environment

Downloaded the `almalinux-9-new-user-test` artifact of
[CI run 38129940141](https://github.com/breakbadsp/triangulator/actions/runs/38129940141):
`gh run download 38129940141 -n almalinux-9-new-user-test`. It holds static
x86_64 binaries, not versioned tar packages, and no checksum file. Download
verification against a published checksum was unavailable. Local identities:

| Component | SHA-256 |
| --- | --- |
| `release/triangulator-collector` | `34a3b2111decf5e72de992d1fbd6a83365ffb2324a2d261031d901b642d85bce` |
| `release/triangulator-sampler` | `92155e207fe35604c99add2ecfe6886ab797860f643a3e2cf8d4f2da8a427676` |
| `release/triangulator-socket-report` | `14b33d932fbab577ff8e631a8f2a33280fc3ccc18d0027849140ef09d6d65811` (not executed) |
| Dashboard served by the collector | `df16db6701a5b864f572151ee59ffdb6a7e0221031e8a2b32c519e25e04e36f6` |

The served dashboard has the same SHA-256 as `collector/dashboard.html` at
5189c47. Startup scripts and templates came from that commit (`git archive`).
No local product build was used.

Host: Omarchy 4.0.4, Linux 7.2.5-3-omarchy, x86_64, 6 logical CPUs.
Browser: headless Chromium 152.0.7977.82 driven by `playwright-core` with real
mouse and keyboard events. Viewports: 1280×800 (cases), 1400×900 (QA-007),
390×844 (QA-015 narrow). Runtime `/tmp/qa-6c3ba7cd/rt2`; UDP 19870,
dashboard HTTP 19871, fixture HTTP 19872. Settings: 2 Hz threads, 2 s resources,
5 s memory map, 5 s replay recording, raw storage on. Existing installations
were not changed. Only test-owned processes were stopped.

**Browser deviation.** The T3 preview tools worked for the first actions, then
reported `visible:false` and returned success without effect. `preview_snapshot`
and `preview_press` failed. With the user's approval, this run used headless
Chromium instead. [Harness scripts](harness/) are saved. UI actions are real
clicks and typing, with two exceptions: the target field is pre-filled with the
current target, so QA-004 and QA-003 clear it by setting its value to empty
before typing. QA-007 reads state with `evaluate`. Page diagnostics: the only
console error on any page is `404 /favicon.ico`, plus the expected `400` for
the invalid target in QA-003. Page state was never changed to satisfy an
expectation.

Fixture: `bugbench` built from `bug-lab/bugbench.c` (SHA-256
`d2f1baaf7ca5c55fef6b9581baf86ed21f17d5e039c875f3fe361518a636da50`; the source
at this checkout compiles to the same hash). Copied to `qa6c-fixture` so another
session's `pkill bugbench` cannot match it. Scratch files: `/tmp/qa-6c3ba7cd/scratch`;
`disk-sync` used btrfs `~/.cache/triangulator-qa-6c3ba7cd/scratch`.
`cpu-throttle` and `mem-oom` ran in `systemd-run --user --scope` with the
documented limits. Each fault was observed 70 s (QA-119: 165 s) with the page open.
Another QA session ran concurrently under `/tmp/tri-qa`; this run moved to its own
directory and ports. Its processes were not touched.

## Results

All rows: package PR 65 5189c47 (CI), case revision as defined in
[test-cases.md](../../test-cases.md).

| Case | Status | Observation | Evidence |
| --- | --- | --- | --- |
| QA-001 | PASSED | Packaged binaries started with no compiler. Dashboard showed `bb-healthy`, PID, five threads, verdict Healthy, no error banner. | [Observations](evidence/qa123-observations.txt), [page](evidence/qa001-live.txt) |
| QA-002 | PASSED | Change target + Monitor selected a second PID; five threads; target persisted after reload. | [Page](evidence/qa002-second.txt), [reload](evidence/qa002-reload.txt) |
| QA-003 | PASSED | Empty input: `Please fill out this field.` PID 2147483647: `no running process with PID 2147483647`. Original target stayed active after reload. | [Page](evidence/qa003-invalid.txt) |
| QA-004 | PASSED | Absent name accepted: header `Target absent`, `Waiting for a process named qa-named-proc to start.` After start: PID and 1 thread. After stop: `Target absent` again. Observation: the form keeps showing the waiting message while the process runs. | [Absent](evidence/qa004-1-absent.txt), [running](evidence/qa004-2-running.txt), [stopped](evidence/qa004-3-stopped.txt) |
| QA-005 | PASSED | Row click opened the drawer with metrics. Latest recording and Previous showed recorded times; drawer history ended at the replay time (`to` = 16:16:48). Live resumed. | [Drawer](evidence/qa005-1-drawer.txt), [replay](evidence/qa005-3-replay-drawer.txt), [live](evidence/qa005-4-live-again.txt) |
| QA-007 | FAILED | All 7 headings opened specific cards. 150 memory-map probes: all opened specific cards except hidden or transient ones; re-probe with Member regions open showed all 5 column headers, the heap bar, and zoom facts open cards. 40 of 40 information buttons opened a guide. Keyboard focus opened a card. Idle-row message and the resource socket message explained their panels. The Socket I/O panel message `Socket report helper unavailable…` opened no card (three attempts). See failure below. | [Sweep](evidence/qa007-help.json), [re-probe](evidence/qa007-reprobe.json), [idle message](evidence/qa007-idle-message.png) |
| QA-008 | BLOCKED | Steps 1–2: for 12 live bars and 4 fixture bars, every legend swatch color matched the grid and `not mapped` appeared only with gaps. No guard bar existed, and the mem-leak target ended before a new mapping outline could be observed (step 3). | [Legend](evidence/qa008-legend.json), [live](evidence/qa018-observations.json) |
| QA-009 | PASSED | Helper installed identical source (`cmp`), started `cpu-spin`, `next` stopped it and started `cpu-oversub`. A fresh helper process `previous` used saved state. Boundaries reported `No previous/next scenario.` `cpu-throttle` had CPUQuota 500 ms. `mem-oom` had MemoryMax 256 MiB, swap 0; after oom-kill status said `Process: stopped`. Helper did not change the sampler target. `stop` left an unrelated user service active. Observation: an oom-killed unit stays listed as failed. | [Start](evidence/qa009-1-start.txt), [navigation](evidence/qa009-2-navigation.txt), [end](evidence/qa009-3-end.txt) |
| QA-015 | PASSED | Desktop and 390 px: facts, legend, grid, and three charts visible; headings and rates on separate lines; charts stack at equal 328 px widths; no horizontal overflow. Enter/Enter opened and closed Member regions; it stayed open after a sample. Its help and the Thread stacks guide separate reserved size, residency, and stack depth. | [Observations](evidence/qa015-observations.json), [narrow](evidence/qa015-narrow.png) |
| QA-016 | PASSED | Heap margin help opened. Neighbor file color retained. A 4 KiB growth kept grid `0x1000000000000000–0x1000000000140000`, 320 cells. Growth past the span reset it with margin below 1 MiB and cells below 512. Contraction restored it. Stale and partial layouts had no margin. Selection and target changes reset it. The earlier FAILED result for 44decf5 is retained in its run. | [Sequence](evidence/qa016-sequence.json), [help](evidence/qa016-help-selection.json), [target](evidence/qa016-target-change.json) |
| QA-018 | PASSED | Healthy: heap change `0 B in 5 s`, then `0 B in 15 s`. New mem-leak target: charts showed `Collecting…`. Resident anonymous rose to +448.1 MiB/min while heap-end offset stayed 0 B. | [Observations](evidence/qa018-observations.json) |
| QA-101 | PASSED | Healthy, no warning. | [Page](evidence/qa101-healthy.txt) |
| QA-102 | PASSED | `worker-hot is saturating a core`; drawer: CPU 99.6%. | [Page](evidence/qa102-cpu-spin.txt), [drawer](evidence/qa102-cpu-spin-drawer.txt) |
| QA-103 | PASSED | `Threads are waiting for CPU`, run delay 236%, no configured quota claim. | [Page](evidence/qa103-cpu-oversub.txt) |
| QA-104 | PASSED | `CPU quota throttled 100% of periods`, 0.50-core quota. | [Page](evidence/qa104-cpu-throttle.txt) |
| QA-105 | FAILED | Two 70 s attempts: findings say only `saturating a core`; no kernel CPU or yield-loop text. Fixture kernel share was 57.9%. | [Page](evidence/qa105-yield-storm.txt), [first](evidence/qa105-yield-storm-first.txt), [CPU split](evidence/qa105-cpu-split.txt) |
| QA-106 | PASSED | `8 of 8 worker threads mostly wait on a futex but keep waking`, with lock-held explanation; no deadlock claim. | [Page](evidence/qa106-lock-convoy.txt) |
| QA-107 | PASSED | `2 threads have waited on a futex for over 61 s … Possible deadlock or lost wake-up`. | [Page](evidence/qa107-deadlock.txt) |
| QA-108 | PASSED | Top assessment `Worth a look`: `Resident memory grows without a plateau`, +448.1 MiB/min. | [Page](evidence/qa108-mem-leak.txt) |
| QA-109 | PASSED | `Memory is thrashing (69.2% full stall)`, memory.high 160 MB, limit 240 MB. | [Page](evidence/qa109-mem-oom.txt) |
| QA-110 | PASSED | Top assessment `Address space is close to RLIMIT_AS`, 3.0 of 3.0 GiB. | [Page](evidence/qa110-vm-bloat.txt) |
| QA-111 | PASSED | `99.0% of file descriptors in use`, 297 of 300, EMFILE. | [Page](evidence/qa111-fd-leak.txt) |
| QA-112 | PASSED | `I/O is stalling all work 19.5%`; 4 threads in uninterruptible wait. | [Page](evidence/qa112-disk-sync.txt) |
| QA-113 | PASSED | 235.1K major faults/s and the disk-read stall explanation. | [Page](evidence/qa113-major-faults.txt) |
| QA-114 | PASSED | 149.0 KB waiting to send; zero-window peer on the data connection. | [Page](evidence/qa114-tcp-slow.txt) |
| QA-115 | PASSED | 6222 UDP drops; receive buffer 84.4% full. | [Page](evidence/qa115-udp-drop.txt) |
| QA-116 | PASSED | 913 CLOSE-WAIT connections; missing `close()` explanation. | [Page](evidence/qa116-close-wait.txt) |
| QA-117 | PASSED | `12 incoming connections dropped`; SYN-SENT rows have no zero-window text. | [Page](evidence/qa117-listen-full.txt) |
| QA-118 | PASSED | Tile `Thread churn +0 / −0 · lower bound · seen starting / ending`. Its card says it is a lower bound and that short-lived threads are missed. | [Page](evidence/qa118-thread-churn.txt), [diag](evidence/qa118-diag.json) |
| QA-119 | PASSED | `Thread count keeps growing: 10 to 602 threads in 2.5 min`. | [Page](evidence/qa119-thread-leak.txt) |
| QA-120 | PASSED | Stopped: `5 stopped threads`, not absent. After SIGCONT: Healthy with fresh samples. | [Stopped](evidence/qa120-stopped-stopped.txt), [resumed](evidence/qa120-stopped-resumed.txt) |

## Confirmed failures

### QA-007: Socket I/O panel message has no help card

Priority: Low. Build: PR 65 5189c47.

1. Run the dashboard with no socket-report helper installed (as here).
2. Open the page with hover help on. Scroll to Socket I/O.
3. Rest the pointer on `Socket report helper unavailable. Install triangulator-socket-report next to the collector.` for 1.2 s. Repeat three times.

Expected: the message explains its panel (QA-007 step 4: other full-width messages
explain their panel). Actual: no card opened. The heading, the Resources
socket-table message, and the idle-row message all opened cards.
Evidence: `socket-io empty` entries in [qa007-help.json](evidence/qa007-help.json).

### QA-105: yield storm lacks kernel CPU finding

Priority: Medium. Same defect in [run v0.1.0](../20261011T095009Z-v0.1.0-retest/index.md).
Start `bugbench yield-storm 110`, select its PID, observe 70 s. Expected: the
saturated-thread finding names CPU spent in the kernel and a polling or yield loop
(`major-faults` shows this wording, so the feature exists). Actual: two attempts
show only `worker-N is saturating a core`. `/proc` showed 57.9% kernel time
([CPU split](evidence/qa105-cpu-split.txt)), so the fault developed.

## Limits

Cases QA-011 to QA-014 and QA-017 depend on HTTP fixtures and were not repeated;
their PR 65 44decf5 results stay current. QA-006 stays BLOCKED: the release API
lists only v0.1.0. This run does not cover AlmaLinux, privileged BPF, socket
report, or a real 64 KiB page-size host. Screenshots exist only for failures and
layout checks; passing lab pages are saved as DOM text.
