# Bug lab manual cases

Fixture: [`bug-lab/bugbench.c`](../../bug-lab/bugbench.c) from PR #47.
Each row below is one case definition. It uses the common preconditions and
numbered steps, plus its scenario-specific setup and expected results.
Record results only in the [current-result table](test-cases.md) and new run
records. All cases start as NOT_RUN.

## Common preconditions

Use downloaded sampler and collector packages for the requested version.
QA-001 setup is running in an isolated installation. The test host has enough
CPU, memory, descriptors, and scratch storage for the selected fixture.
Run one scenario at a time. Record host limits and any added resource limits.

Build the fixture with `gcc -O2 -pthread bug-lab/bugbench.c -o PATH` in a test
directory. Record its source revision, executable SHA-256, and compiler version.
Set `BUG_LAB_DIR` to separate scratch storage for this run. Use matching sampler
and collector thread groups from the documented bug lab setup.
Use 2 Hz thread sampling, 2-second resource samples, 5-second memory samples,
and 5-second replay recording. Record any change to these settings.

Select the owned fixture by PID with the downloaded package's `set-target.sh`.
For a `systemd-run` scope, identify the fixture PID inside the scope before
target selection. The wrapper PID must not become the monitored target.
Python is required for these control scripts. The cgroup cases require a working
user systemd manager and support for the specified limits.

Source: [Bug lab setup](../../bug-lab/README.md) and
[report method](../bug-lab-report.md#how-it-was-run).

## Common steps

1. Run QA-101 as the control before the fault cases. Record its result separately.
2. Start the row's scenario with a duration at least 30 seconds longer than its
   observation interval. Use 70 seconds of observation unless the row specifies
   another interval. Apply the row's additional setup.
3. Select the fixture PID. Open the dashboard in the shared real browser at the
   start of observation. Confirm the target PID and fresh samples. Keep the page
   open for the full interval. Inspect Overview, Threads, Resources, and Memory
   map as relevant. Open thread details and help text where the row requires it.
4. Check the expected results. Save browser evidence and fixture logs. Check that
   the intended fault developed. If the host cannot produce the required symptom,
   record BLOCKED with the reason. An observed fault with a missing required
   finding is FAILED. Do not require historical screenshot numbers to match.
5. Stop the owned fixture. Resume a stopped fixture before termination. Stop only
   test-owned scopes. Retain evidence and remove only run-owned scratch files.
   Run the healthy control again if a fault leaves stale state or apparent
   findings in the next case.

The fixture's intentional faults are the test input. Judge the dashboard's
documented response. Known measurement limits are part of the expected result.
The historic report provides context; its verdicts are not current test results.

## Case definitions

All cases have case revision 1. The Feature column names the behavior under test.

| Case ID | Scenario | Feature | Priority | Additional setup | Expected results |
| --- | --- | --- | --- | --- | --- |
| QA-101 | `healthy` | Control | High | Run in an unconstrained scope with no unrelated pressure. | The selected healthy process has no resource-fault warning. Idle workers do not cause a lock, leak, or saturation warning. |
| QA-102 | `cpu-spin` | CPU saturation | High | None. | Overview identifies `worker-hot` as saturating a core. Its thread detail shows high CPU use. |
| QA-103 | `cpu-oversub` | CPU scheduling | High | Confirm that more runnable workers exist than available cores. | The dashboard reports threads waiting for CPU and shows run delay. It does not attribute this to a nonexistent CPU quota. |
| QA-104 | `cpu-throttle` | CPU quota | High | Start in a user scope with `CPUQuota=50%`. | The dashboard identifies quota throttling and the 0.50-core quota. The resource section shows throttled periods. |
| QA-105 | `yield-storm` | Kernel CPU time | Medium | Confirm sustained high system CPU time in the fixture. | The saturated-thread finding identifies CPU spent in the kernel and suggests a polling or yield loop. |
| QA-106 | `lock-convoy` | Lock contention | High | Confirm repeated futex waits and wakeups. | The dashboard gives a possible lock-contention hint and exposes waiting workers. It does not claim proof of a deadlock. |
| QA-107 | `deadlock` | Long futex waits | High | Observe at least 70 seconds with active sibling threads. | The dashboard gives a possible stuck-thread hint, exposes the waiting threads, and shows the longest futex wait. It does not claim a proved deadlock. |
| QA-108 | `mem-leak` | Resident memory growth | High | Keep the browser open for the full growth interval. | The Memory section identifies sustained RSS growth. A warning-level finding also appears in the top assessment. Growth refers to the current process and recent samples. |
| QA-109 | `mem-oom` | Cgroup memory pressure | High | Use `MemoryHigh=160M`, `MemoryMax=240M`, and `MemorySwapMax=0` in a user scope. | While pressure is observed, the dashboard shows memory stalls or thrashing and the cgroup limits. If the kernel kills the fixture, the dashboard later shows target absence; record the termination evidence separately. |
| QA-110 | `vm-bloat` | Virtual memory limits | High | Confirm that mappings and address reservation approach `RLIMIT_AS`. | Memory map reports address-space pressure near the limit. Its warning or critical finding also appears in the top assessment. |
| QA-111 | `fd-leak` | Descriptor exhaustion | High | Confirm growth toward the fixture's descriptor limit. | Resources shows descriptor count and limit. The assessment warns about high descriptor use. |
| QA-112 | `disk-sync` | Storage stalls | Medium | Use scratch storage that produces observable `fsync` stalls. | The dashboard identifies I/O stalls and shows affected threads in uninterruptible wait. |
| QA-113 | `major-faults` | Major page faults | Medium | Confirm uncached reads produce major faults. | The dashboard reports major page-fault rate and related I/O stalls. |
| QA-114 | `tcp-slow` | TCP backpressure | High | Loopback sockets are available. | Resources shows queued TCP data and a zero-window or slow-peer finding on a data-moving TCP connection. |
| QA-115 | `udp-drop` | UDP receive loss | High | Loopback sockets are available. Confirm receive-buffer drops. | Resources reports UDP datagram drops and receive-buffer pressure. |
| QA-116 | `close-wait` | Socket lifecycle | High | Confirm accumulating CLOSE-WAIT connections. | Resources and the assessment identify excess CLOSE-WAIT connections and a possible application close problem. |
| QA-117 | `listen-full` | Listen backlog | High | Confirm a full listen queue or dropped incoming connections. | Resources reports listen-queue pressure or incoming drops. SYN-SENT sockets do not get a zero-window peer finding. |
| QA-118 | `thread-churn` | Sampling limits | High | Run with the documented sampling rate. | Thread creation and exit counts are identified as a lower bound. Help explains that short-lived threads can be missed. Low sampled counts are not presented as proof of no churn. |
| QA-119 | `thread-leak` | Sustained thread growth | High | Observe for at least 165 seconds. Confirm continuing count growth. | The assessment reports sustained thread-count growth. The thread count increases; the finding distinguishes sustained growth from a short startup burst. |
| QA-120 | `stopped` | Stopped process | High | Run `healthy`. After 45 seconds, send `SIGSTOP` to its PID. Observe for another 25 seconds. | The dashboard reports stopped threads rather than an absent target. After `SIGCONT`, fresh samples and normal activity return. |
