# Stable package QA: v0.1.0

Run date: 2026-10-09 UTC. Execution started at 03:56 UTC and ended at 04:33 UTC.
Scope: all 26 documented cases, revision 1. No case definition changed.
Result: 14 PASSED, 7 FAILED, 5 BLOCKED, 0 NOT_RUN.
The package does not meet all current suite expectations on this test host.
These results do not establish readiness on AlmaLinux 8 or AlmaLinux 9.

## Package identity

The latest published stable release was
[v0.1.0](https://github.com/breakbadsp/triangulator/releases/tag/v0.1.0),
published at 2026-10-08T19:19:37Z. The release API listed no earlier release.
Both downloaded components have version 0.1.0 and platform el9-x86_64.
Both published `.sha256` checks passed before extraction.

| Component | Published package | SHA-256 |
| --- | --- | --- |
| Sampler | [triangulator-sampler-0.1.0-el9-x86_64.tar.gz](https://github.com/breakbadsp/triangulator/releases/download/v0.1.0/triangulator-sampler-0.1.0-el9-x86_64.tar.gz) | `5a073d466f5a97074b0ba810363a80001d7426865bc45a0dc3279e1c3b445c0e` |
| Collector | [triangulator-collector-0.1.0-el9-x86_64.tar.gz](https://github.com/breakbadsp/triangulator/releases/download/v0.1.0/triangulator-collector-0.1.0-el9-x86_64.tar.gz) | `e734ac92c45725a4592f6859930f8a4e20b4ac19e61463567dfec1097f44a038` |

Source revision: `188d0b5c6ef83df0c2ec5175cd944c550ba11801` (PR #43).
Release notes describe the packaged collector, target control, replay, resource
monitoring, memory map, and contextual help. The current suite and bug lab
fixture are later than this release. The run checks the current documented
expectations; it does not change the release tag or package version.
The product binaries came from the release packages. No source build replaced them.

Evidence: [release metadata](evidence/release.json),
[sampler checksum](evidence/triangulator-sampler-0.1.0-el9-x86_64.tar.gz.sha256),
[collector checksum](evidence/triangulator-collector-0.1.0-el9-x86_64.tar.gz.sha256).

## Environment and method

- Host: Omarchy 4.0.4, x86_64, Linux 7.2.5-3-omarchy. This is not AlmaLinux.
- Host resources: 6 logical CPUs, 15,765 MiB RAM, 31,531 MiB swap.
  Initial available RAM: 5,725 MiB. Descriptor limit: 524288.
  Process limit: 62781. Disk-backed scratch storage had 330 GiB free.
- Isolated installation: `/tmp/triangulator-qa-20261009/triangulator`.
  `TRIANGULATOR_HOME` selected this directory for every packaged control script.
  UDP: `127.0.0.1:19560`. Application URL: `http://127.0.0.1:19561/`.
- Browser: T3 Code 0.0.45, Chrome 152.0.7977.130, Electron 44.4.2.
  Viewport: 1280 × 800 CSS pixels. Tabs: `tab_d`, then recovery tab `tab_e`.
- Fixture: `bug-lab/bugbench.c` at
  `e59ccbb826e90f558b1a70e066ba2ada3854ca1e`.
  Compiler: GCC 16.2.1 20260810. Command:
  `gcc -O2 -pthread bug-lab/bugbench.c -o /tmp/triangulator-qa-20261009/bugbench`.
  Fixture SHA-256:
  `d2f1baaf7ca5c55fef6b9581baf86ed21f17d5e039c875f3fe361518a636da50`.
- Settings: 2 Hz thread samples, 2-second resource samples, 5-second memory-map
  samples, 5-second replay recording, raw storage enabled. Collector groups:
  `io-`, `worker-`, `sender-`, `misc-`. See
  [sampler settings](evidence/sampler.toml) and
  [collector settings](evidence/collector.toml).
- Most fixture scratch files used `/tmp`, which is tmpfs. The storage-stall
  retry used `$HOME/.cache/triangulator-qa-20261009/scratch` on btrfs.
  The four run-owned `sync-*.dat` files were removed after that retry.
- Each full fault observation used 70 seconds. Thread growth used 165 seconds.
  The page stayed open. Fixture durations exceeded observation by 40 seconds.
  Packaged `set-target.sh` selected the fixture PID. The cgroup cases used
  test-owned user scopes with their documented limits and the fixture PID.
  [Attempt times and process observations](evidence/attempts.json) preserve the
  main sequence. The first 33-second CPU scheduling attempt is retained as an
  incomplete attempt; the full 70-second retry supplies its result.

The initial setup accidentally put collector `[[group]]` sections in the sampler
configuration. The sampler rejected that configuration. Removing those sections
allowed the packaged startup procedure to complete. This was a setup error.
The execution tool ended early background processes when their shell sessions
closed. Holding the test sessions open kept the packaged programs running.
Existing installations and user data were not changed.

## Browser evidence limits

`preview_status` initially reported no tab. `preview_open` attached a real browser.
Read-only `preview_evaluate` supplied the rendered page text saved below.
Focused T3 tools performed the successful target and validation actions.
Evaluation did not change the DOM or application state.

`preview_snapshot` repeatedly failed, including `save:true` and text-only calls.
Recording also timed out. Some click/type calls failed or disconnected the host.
Later click calls returned success without changing the form, drawer, or replay
state, even after scroll and coordinate retries. New-tab recovery restored read
access, but not all interactions. These are environment blockers, not confirmed
product defects. No screenshot, recording, or full console/network diagnostic
capture was available. Failure evidence therefore consists of durable browser
text and fixture observations. See [tool errors](evidence/browser-tool-errors.txt).
No alternate browser was used because `preview_open` continued to report available.

## Case results

All rows test package 0.1.0 and case revision 1.

| Case | Status | Observation | Evidence |
| --- | --- | --- | --- |
| QA-001 | PASSED | Both packaged programs started without a product build. The browser identified the fixture PID and five threads. No application error prevented those behaviors. Full diagnostic capture was unavailable. | [Healthy page](evidence/healthy.txt) |
| QA-002 | PASSED | Two owned processes ran. Change target and Monitor selected PID 676047. The browser showed five threads. Reload retained the target. | [Reloaded page](evidence/target-reload.txt) |
| QA-003 | PASSED | Empty input produced `Please fill out this field.`. PID 2147483647 produced `no running process with PID 2147483647`. The original target stayed active and remained after reload. | [Validation text](evidence/target-validation.json), [healthy page](evidence/healthy.txt) |
| QA-004 | BLOCKED | Change target interaction failed when selecting the prepared absent name. Named start/stop browser expectations could not be executed. | [Tool errors](evidence/browser-tool-errors.txt) |
| QA-005 | BLOCKED | Thread-row and Latest recording clicks did not change the drawer or live view. The browser interaction failure prevented replay and history checks. | [Tool errors](evidence/browser-tool-errors.txt) |
| QA-006 | BLOCKED | No earlier published package was available. The earlier-version installation and upgrade preconditions could not be created. | [Release metadata](evidence/release.json) |
| QA-101 | PASSED | Healthy control showed five sleeping threads, Healthy, and No problems detected during core checks. No lock, leak, or saturation warning appeared. | [Healthy page](evidence/healthy.txt), [fixture log](evidence/healthy.log) |
| QA-102 | BLOCKED | The page identified worker-hot as saturating a core at 99.8% CPU. Thread-row clicks did not open its detail drawer, so the detail expectation was not checked. | [CPU page](evidence/cpu-spin.txt), [tool errors](evidence/browser-tool-errors.txt) |
| QA-103 | PASSED | Eighteen runnable workers exceeded six CPUs. The page reported Threads are waiting for CPU and run delay of 213% of CPU time. It did not assert a configured CPU quota. | [Full retry](evidence/cpu-oversub-retry.txt), [incomplete first attempt](evidence/cpu-oversub.txt) |
| QA-104 | PASSED | The page identified 100% throttled periods and a 0.50-core quota. Resources also showed CPU throttling at 100% of periods. | [Quota page](evidence/cpu-throttle.txt), [fixture log](evidence/cpu-throttle.log) |
| QA-105 | FAILED | Saturated-thread findings omitted kernel CPU and polling/yield-loop guidance. A repeated run confirmed 57.2% kernel CPU time and the same missing finding. | [First page](evidence/yield-storm.txt), [retry page](evidence/yield-storm-retry.txt), [CPU split](evidence/yield-storm-cpu-split.txt) |
| QA-106 | FAILED | Seven futex waiters and 105 context switches/s were visible. The page reported Healthy and omitted the possible lock-contention hint. | [Contention page](evidence/lock-convoy.txt), [fixture log](evidence/lock-convoy.log) |
| QA-107 | FAILED | Two workers remained in futex wait while the sibling heartbeat ran. After 70 seconds, the page reported Healthy and omitted the possible stuck-thread hint and longest futex wait. | [Deadlock page](evidence/deadlock.txt), [fixture log](evidence/deadlock.log) |
| QA-108 | FAILED | RSS grew to 519.7 MB, with +7.1 MB/s shown in Resources. The memory page showed a growth rate but no growth warning. The top assessment remained Healthy. | [Growth page](evidence/mem-leak.txt), [fixture log](evidence/mem-leak.log) |
| QA-109 | PASSED | The page showed Memory is thrashing at 74.4% full stall and an uninterruptible worker. Resources showed memory.high 160 MB and memory.max 240 MB. No kernel kill occurred in this interval. | [Pressure page](evidence/mem-oom.txt), [fixture log](evidence/mem-oom.log) |
| QA-110 | FAILED | Memory map showed CRITICAL address-space pressure at 3.0 GB of a 3.0 GB RLIMIT_AS. The top assessment remained Healthy and omitted that finding. | [Address-space page](evidence/vm-bloat.txt), [fixture log](evidence/vm-bloat.log) |
| QA-111 | PASSED | Resources showed 279 of 300 descriptors. The assessment warned that 93.0% were in use and described EMFILE. | [Descriptor page](evidence/fd-leak.txt), [fixture log](evidence/fd-leak.log) |
| QA-112 | PASSED | First attempt on tmpfs was BLOCKED: no storage-stall symptom. The btrfs retry showed 19.9% full I/O stall and four threads in uninterruptible wait. | [First page](evidence/disk-sync.txt), [retry page](evidence/disk-sync-retry.txt), [retry log](evidence/disk-sync-retry.log) |
| QA-113 | PASSED | The page reported 240.1K major faults/s and explained that reading memory from disk stalls the faulting thread. | [Fault page](evidence/major-faults.txt), [fixture log](evidence/major-faults.log) |
| QA-114 | PASSED | Resources showed queued TCP data. The assessment reported 131 KB waiting to be sent and a zero-window peer on the data connection. | [TCP page](evidence/tcp-slow.txt), [fixture log](evidence/tcp-slow.log) |
| QA-115 | PASSED | The page reported 6264 UDP drops and an 84.4% full receive buffer with 6.8 KB unread. | [UDP page](evidence/udp-drop.txt), [fixture log](evidence/udp-drop.log) |
| QA-116 | PASSED | Resources and the assessment identified 861 CLOSE-WAIT connections and the possible missing close() problem. | [Socket page](evidence/close-wait.txt), [fixture log](evidence/close-wait.log) |
| QA-117 | FAILED | Listen overflow was detected. SYN-SENT socket rows nevertheless said Peer window is zero: the peer is not reading, and the assessment repeated that warning. | [Listen page](evidence/listen-full.txt), [fixture log](evidence/listen-full.log) |
| QA-118 | BLOCKED | The fixture created short-lived threads, but only three current threads were sampled. Browser interaction failures prevented the required help check. Lower-bound labeling and its help explanation were not fully checked. | [Churn page](evidence/thread-churn.txt), [fixture log](evidence/thread-churn.log), [tool errors](evidence/browser-tool-errors.txt) |
| QA-119 | FAILED | After 165 seconds, the page showed 602 threads and High thread churn. It remained Healthy and omitted the required sustained thread-count-growth finding. | [Thread-growth page](evidence/thread-leak.txt), [fixture log](evidence/thread-leak.log) |
| QA-120 | PASSED | After SIGSTOP, five threads were reported as stopped rather than absent. A longer-fixture retry confirmed normal fresh samples after SIGCONT. An earlier retry exceeded its fixture duration while stopped; its observations are retained. | [First stopped page](evidence/stopped.txt), [retry stopped page](evidence/stopped-retry.txt), [final stopped page](evidence/stopped-final.txt), [resumed page](evidence/stopped-final-resumed.txt) |

## Failure reproduction

Use the package setup and settings above. For each fault case, start
`bugbench SCENARIO 110`, select its actual PID with the packaged `set-target.sh`,
open the browser at the start, and keep it open for 70 seconds. For QA-119, use
`bugbench thread-leak 205` and 165 seconds of observation. Check the named section
and the top assessment. Expected results are in the unchanged
[case definitions](../../test-cases.md) and
[bug lab definitions](../../bug-lab-cases.md).

1. QA-105, `yield-storm`: expect kernel CPU and polling/yield guidance in the
   saturated-thread finding. Actual: only generic core-saturation findings.
   The repeated 70-second attempt confirms the fault developed; both pages are retained.
2. QA-106, `lock-convoy`: expect a possible lock-contention hint and waiting
   workers. Actual: waiting workers were visible, but the hint was absent.
3. QA-107, `deadlock`: expect a possible stuck-thread hint and longest futex wait.
   Actual: neither appeared despite long futex waits and an active heartbeat.
4. QA-108, `mem-leak`: expect sustained RSS growth identification and a warning
   in the top assessment. Actual: numeric growth appeared without that warning.
5. QA-110, `vm-bloat`: expect the warning/critical memory-map finding in the top
   assessment. Actual: Memory map was CRITICAL while the assessment was Healthy.
6. QA-117, `listen-full`: expect backlog pressure and no zero-window peer finding
   on SYN-SENT. Actual: both the socket rows and assessment showed that finding.
7. QA-119, `thread-leak`: expect sustained growth distinguished from startup.
   Actual: only a churn notice appeared while the count increased to 602.

No application console/network errors were captured because browser diagnostics
were unavailable. The confirmed failures are finding-content failures, not
inferences from those missing diagnostics. No product fix or fixed-package retest
was performed.

## Validation and cleanup

The QA documentation worktree built with `make -j2` and passed `make check`.
All C++ checks passed. Python ran 68 tests; one privileged BPF test was skipped
by its documented environment requirement. The source build was only a required
commit check and was not installed as the product under test.

Only test-owned fixtures, sampler, and collector processes were stopped. The
test-owned cgroup scopes ended when their fixture processes stopped.
Run-owned scratch files were removed. Downloaded packages, settings, logs, and
recorded history remain in the isolated runtime for inspection. Existing user
installations and all historical QA records were preserved.
