# Release v0.1.0 retest and wire format overview

UTC execution: 2026-10-11T09:50Z to 10:45Z.
Package: [v0.1.0](https://github.com/breakbadsp/triangulator/releases/tag/v0.1.0),
the only published release. Scope: QA-001 to QA-005, QA-010, and QA-101 to QA-120.
Results: 18 PASSED, 8 FAILED, 0 BLOCKED. QA-006 and QA-007 were not run here.
This run retests cases that [the first v0.1.0 run](../20261009T035640Z-v0.1.0/index.md)
could not execute because browser interaction failed. The current-result table uses
the [newer CI build run](../20261011T110000Z-ci-5189c47/index.md) where it covers a case.

## Package identity and environment

Downloaded `triangulator-sampler-0.1.0-el9-x86_64.tar.gz` and
`triangulator-collector-0.1.0-el9-x86_64.tar.gz` with their `.sha256` files from the
release (`gh release download v0.1.0`). `sha256sum -c` passed for both before extraction.
Both packages contain the binaries, templates, and control scripts; no source build
was used. The collector's embedded dashboard lacks the later contextual help and
memory zoom features, so QA-007 and QA-008 to QA-018 do not apply to this package.

Same host and method as the [CI build run](../20261011T110000Z-ci-5189c47/index.md#product-and-environment),
including the browser deviation: headless Chromium 152.0.7977.82 via `playwright-core`
because the T3 preview stopped accepting clicks. Runtime `/tmp/qa-6c3ba7cd/rt`; UDP 19860,
HTTP 19861. Fixture SHA-256 `d2f1baaf7ca5c55fef6b9581baf86ed21f17d5e039c875f3fe361518a636da50`.
[Harness scripts](harness/) are saved. QA-010 used the source checkout's
`docs/wire-format-overview.html` (commit 93946af); it needs no package.

## Results

| Case | Status | Observation | Evidence |
| --- | --- | --- | --- |
| QA-001 | PASSED | Packaged programs started with no compiler. Dashboard showed the PID and five threads. | [Page](evidence/qa001-live.txt), [observations](evidence/qa123-observations.txt) |
| QA-002 | PASSED | Second PID selected; reload kept it. | [Page](evidence/qa002-second.txt) |
| QA-003 | PASSED | Empty and nonexistent PID rejected; original target kept. | [Page](evidence/qa003-invalid.txt) |
| QA-004 | PASSED | Absent name accepted, then PID shown on start, then absent after stop. Earlier BLOCKED result is superseded. | [Absent](evidence/qa004-1-absent.txt), [running](evidence/qa004-2-running.txt), [stopped](evidence/qa004-3-stopped.txt) |
| QA-005 | PASSED | Drawer, replay time, previous recording, and live return all behaved as expected. | [Drawer](evidence/qa005-1-drawer.txt), [replay](evidence/qa005-3-replay-drawer.txt) |
| QA-010 | PASSED | Both README/setup links open the page (file link and htmlpreview). Nav headings sit below the bar. Header sizes 48/64/64/80 B, rows 112/160/64/80 B, and example bytes match fields. Thread counts 1, 10, 11, 60 give 1, 1, 2, 6 chunks. Loss 50% shows the three loss states. Pause and resume work. Each clicked datagram dropped once and was logged. Dropped TRES summary: `no summary: sample discarded`. Dropped TVMA summary with all regions: `layout updated`. Dropped region part: `region parts missing; layout unchanged`. TVMA layout count stayed unchanged on summary-only samples. No script errors. | [Layouts](evidence/qa010-layouts.json), [interactive](evidence/qa010-interactive.json), [drops](evidence/qa010-drops.json), [extra](evidence/qa010-extra.json) |
| QA-101 | PASSED | Healthy, no warning. | [Page](evidence/qa101-healthy.txt) |
| QA-102 | PASSED | `worker-hot is saturating a core`; drawer CPU 99.6%. Earlier BLOCKED result is superseded. | [Page](evidence/qa102-cpu-spin.txt), [drawer](evidence/qa102-cpu-spin-drawer.txt) |
| QA-103 | PASSED | Waiting for CPU; run delay 265%. | [Page](evidence/qa103-cpu-oversub.txt) |
| QA-104 | PASSED | Quota throttling, 0.50 cores. | [Page](evidence/qa104-cpu-throttle.txt) |
| QA-105 | FAILED | No kernel CPU or yield-loop finding. | [Page](evidence/qa105-yield-storm.txt) |
| QA-106 | FAILED | Verdict Healthy; no lock-contention hint. | [Page](evidence/qa106-lock-convoy.txt) |
| QA-107 | FAILED | Verdict Healthy; no stuck-thread hint or longest futex wait. | [Page](evidence/qa107-deadlock.txt) |
| QA-108 | FAILED | RSS +7.5 MB/s shown in Resources; top assessment Healthy. | [Page](evidence/qa108-mem-leak.txt) |
| QA-109 | PASSED | `Memory is thrashing (100.0% full stall)`; memory.high 160 MB, max 240 MB. | [Page](evidence/qa109-mem-oom.txt) |
| QA-110 | FAILED | Memory map showed the RLIMIT_AS finding; top assessment stayed Healthy. | [Page](evidence/qa110-vm-bloat.txt) |
| QA-111 | PASSED | `99.3% of file descriptors in use`. | [Page](evidence/qa111-fd-leak.txt) |
| QA-112 | PASSED | I/O stall 19.9%, threads in uninterruptible wait (btrfs scratch). | [Page](evidence/qa112-disk-sync.txt) |
| QA-113 | PASSED | 231K major faults/s with the disk-read explanation. | [Page](evidence/qa113-major-faults.txt) |
| QA-114 | PASSED | Zero-window peer on a data connection. | [Page](evidence/qa114-tcp-slow.txt) |
| QA-115 | PASSED | UDP drops and receive-buffer pressure. | [Page](evidence/qa115-udp-drop.txt) |
| QA-116 | PASSED | 917 CLOSE-WAIT connections. | [Page](evidence/qa116-close-wait.txt) |
| QA-117 | FAILED | Listen overflow found, but SYN-SENT rows say `Peer window is zero`. | [Page](evidence/qa117-listen-full.txt) |
| QA-118 | FAILED | No churn tile or lower-bound label appeared with the churn fixture running; nothing showed that sampled counts are lower bounds. Earlier BLOCKED result is superseded. | [Page](evidence/qa118-thread-churn.txt) |
| QA-119 | FAILED | 602 threads; only `High thread churn`, verdict Healthy, no sustained-growth finding. | [Page](evidence/qa119-thread-leak.txt) |
| QA-120 | PASSED | `5 stopped threads`, then Healthy after SIGCONT. | [Stopped](evidence/qa120-stopped-stopped.txt), [resumed](evidence/qa120-stopped-resumed.txt) |

Every failure above reproduces by starting `bugbench SCENARIO 110` (`thread-leak 205`),
selecting its PID with the packaged `set-target.sh`, and observing 70 s (165 s) with
the page open. The same findings reproduced in the first v0.1.0 run, except QA-118,
which that run could not check. The CI build run shows QA-106 to QA-108, QA-110,
QA-117, QA-118, and QA-119 working in newer code; only QA-105 still fails.

`qa010-interactive.json` holds the first scripted drop attempt, which clicked the
wrong overlapping datagram; its thread-count and loss sections are valid. The drop
results come from `qa010-drops.json`. Screenshots exist for failing cases and
the wire page; passing lab pages are saved as DOM text.
