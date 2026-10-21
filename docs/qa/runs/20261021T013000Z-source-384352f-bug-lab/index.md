# Bug lab QA on master 384352f (QA-101 to QA-120)

UTC run: 2026-10-20, 19:30–20:25. Runner: `bug-lab/run-lab.sh` from this checkout,
run against the isolated runtime (`TRIANGULATOR_HOME=/tmp/tri-qa/home`, HTTP 19401).
Each scenario ran for 70 s (thread-leak 165 s), with the fixture PID selected as the
`default` target. Capture: the dashboard overview text saved as `evidence/<scenario>.txt`.

Results: 19 PASSED, 1 BLOCKED (QA-112), 0 FAILED.

## Product identity

Source build of `origin/master` at `384352f`. No release package. No checksum claim.

## Environment and settings

- Sampler: 2 Hz threads, resource 2 s, memory 5 s. Collector: replay 5 s. Set per the case preconditions.
- `cpu_budget_pct` 2.0 (raised for the QA-032 10 Hz run; not the default).
- Collector watch rules `MsgP` 1000 ms and `PrdDist` 2000 ms were still in `collector.toml`
  from QA-032. No bugbench thread matches them. The Assessment therefore starts with
  "2 watch rules match no thread" in every scenario (ISS-9). This is a test artifact of
  the runtime config, not a fixture result. The per-scenario findings below are
  taken from the full Assessment text.
- Fixture: `bug-lab/bugbench.c` built with `gcc -O2 -pthread`. `cpu-throttle` and `mem-oom`
  ran in `systemd-run --user --scope` with the limits from the case.

## Results

| Case | Scenario | Result | Evidence in the Assessment text |
| --- | --- | --- | --- |
| QA-101 | healthy | PASSED | No resource finding. Only the watch-rule artifact (ISS-9). |
| QA-102 | cpu-spin | PASSED | "worker-hot is saturating a core", 99.8% of one core. |
| QA-103 | cpu-oversub | PASSED | "Threads are waiting for CPU", run delay 233%. Quota is named only as one of two possible causes (ISS-10). |
| QA-104 | cpu-throttle | PASSED | "CPU quota throttled 100% of periods", "0.50 cores". |
| QA-105 | yield-storm | PASSED | Saturating in the kernel (60.7% of CPU), "looks like a polling or yield loop". |
| QA-106 | lock-convoy | PASSED | 7 futex waits. "Futex waits are locks", hint wording, no deadlock claim. |
| QA-107 | deadlock | PASSED | 2 threads waited on a futex over 57 s. Wording "deadlock or lost wake-up" (ISS-10). |
| QA-108 | mem-leak | PASSED | "Resident memory grows without a plateau", +448.5 MiB/min. |
| QA-109 | mem-oom | PASSED | "Memory is thrashing (100.0% full stall)", cgroup limits. |
| QA-110 | vm-bloat | PASSED | "Needs attention now": "Address space is close to RLIMIT_AS", 3.0 of 3.0 GiB. |
| QA-111 | fd-leak | PASSED | "93.3% of file descriptors in use", 280 of 300. |
| QA-112 | disk-sync | BLOCKED | Host storage does not stall. Writers are running in kernel at 99% CPU, host I/O pressure 0. See [recheck](evidence/qa112-recheck.txt). |
| QA-113 | major-faults | PASSED | "252.7K major page faults/s", "read back from disk, which stalls the faulting thread". |
| QA-114 | tcp-slow | PASSED | "131.0 KB waiting to be sent; the peer advertises a zero window". |
| QA-115 | udp-drop | PASSED | "5315 UDP datagrams dropped", receive buffer 84.4% full. |
| QA-116 | close-wait | PASSED | "885 connections in CLOSE-WAIT", missing `close()` hint. |
| QA-117 | listen-full | PASSED | "12 incoming connections dropped", accept queue 300% full. |
| QA-118 | thread-churn | PASSED | Churn card "lower bound · seen starting / ending, last minute". |
| QA-119 | thread-leak | PASSED | "Thread count keeps growing", 8 to 602 threads, +238 threads/min. |
| QA-120 | stopped | PASSED | "5 stopped threads", reported as stopped, not absent. The SIGCONT resume step was not captured (ISS-11). |

Runner logs: all 20 fixtures printed `done`. The collector and sampler logs had no errors.

## Issues

Severity scale: **Blocker** stops the product or loses data. **Major** breaks a documented
expected result. **Minor** is a wrong or confusing behavior with a workaround. **Low** is
documentation, wording, or an observation for the owner.

- **ISS-9 (Low, test artifact): stale watch rules add a warning to every scenario.**
  Not a product defect. The rules match no thread. Their presence is still a warning in the
  top Assessment. Owner: confirm this wording is intended for rules that match nothing.
- **ISS-10 (Low): hedged wording.** QA-103 names "the cgroup's CPU quota (cpu.max)" as
  a possible cause. The case says it must not attribute the saturation to a nonexistent quota.
  QA-107 uses "deadlock or lost wake-up". Both are hedged, but the wording should separate
  "possible" from "quota" for the reader.
- **ISS-11 (Low): QA-120 resume not verified.** The runner sends SIGCONT after the
  capture. The capture does not show the recovered state.

No blocker or major issue found. QA-112 is blocked by host storage, not by the product.

## Issue follow-up

Status on 2026-10-21. The results above stay as recorded for `384352f`.

- ISS-9: intended behavior. QA-035 expects "A watch rule matches no thread".
- ISS-10: QA-103 part fixed in PR #123. When `cpu.max` is `max`, the CPU
  pressure finding says that the cgroup has no CPU quota. The QA-107 text
  ("Possible deadlock or lost wake-up") already claims no proved deadlock,
  so it is unchanged.
- ISS-11: open. The runner change is in `TODO.md`.
