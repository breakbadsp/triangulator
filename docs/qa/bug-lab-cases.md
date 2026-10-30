# Bug lab cases

- Fixture: [bugbench.c](../../bug-lab/bugbench.c). Compile only the fixture; test downloaded product binaries.
- Use QA-001 setup, isolated scratch storage, and one owned scenario at a time. Select the fixture PID, not its wrapper.
- Record package version, fixture revision and hash, compiler, host limits, and configuration.
- Use 2 Hz thread samples, 2-second resource samples, 5-second memory samples, and 5-second recordings. Record changes.
- Run QA-101 first. Run each fault for at least 30 seconds longer than observation. Observe for 70 seconds unless the row says otherwise.
- Keep a real browser open from the start. Inspect the selected process, relevant sections, thread details, and help.
- Confirm that the fault developed. Missing host support is `BLOCKED`; a missing required response to an observed fault is `FAILED`.
- Save fixture logs and browser evidence. Resume stopped fixtures before termination. Stop only owned processes and scopes.
- Record results in [current results](test-cases.md#current-results). Case revision: 1 for every row.

| Case ID | Scenario | Feature | Priority | Additional setup | Expected results |
| --- | --- | --- | --- | --- | --- |
| QA-101 | `healthy` | Control | High | Run in an unconstrained scope with no unrelated pressure. | The selected healthy process has no resource-fault warning. Idle workers do not cause a lock, leak, or saturation warning. |
| QA-102 | `cpu-spin` | CPU saturation | High | None. | Overview identifies `worker-hot` as saturating a core. Its thread detail shows high CPU use. |
| QA-103 | `cpu-oversub` | CPU scheduling | High | Confirm that more runnable workers exist than available cores. | The dashboard reports threads waiting for CPU and shows run delay. It does not attribute this to a nonexistent CPU quota. |
| QA-104 | `cpu-throttle` | CPU quota | High | Start in a user scope with `CPUQuota=50%`. | The dashboard identifies quota throttling and the 0.50-core quota. The resource section shows throttled periods. |
| QA-105 | `yield-storm` | Kernel CPU time | Medium | Confirm sustained high system CPU time in the fixture. | The saturated-thread finding identifies CPU spent in the kernel and suggests a polling or yield loop. |
| QA-106 | `lock-convoy` | Lock contention | High | Confirm repeated futex waits and wakeups. | The dashboard gives a possible lock-contention hint and exposes waiting workers. It does not claim proof of a deadlock. |
| QA-107 | `deadlock` | Long futex waits | High | Observe at least 70 seconds with active sibling threads. | The dashboard gives a possible stuck-thread hint, exposes the waiting threads, and shows the longest futex wait. The Targets page, tri-scout `status_now`, and a recording give the same hint without an open tab. It does not claim a proved deadlock. |
| QA-108 | `mem-leak` | Resident memory growth | High | Keep the browser open for the full growth interval. | The Memory section identifies sustained RSS growth. A warning-level finding also appears in the top assessment. Growth refers to the current process and recent samples. tri-scout `status_now` gives the same finding. |
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
| QA-119 | `thread-leak` | Sustained thread growth | High | Observe for at least 165 seconds. Confirm continuing count growth. | The assessment reports sustained thread-count growth. The thread count increases; the finding distinguishes sustained growth from a short startup burst. The Targets page, tri-scout `status_now`, and a recording give the same finding without an open tab. |
| QA-120 | `stopped` | Stopped process | High | Run `healthy`. After 45 seconds, send `SIGSTOP` to its PID. Observe for another 25 seconds. | The dashboard reports stopped threads rather than an absent target. After `SIGCONT`, fresh samples and normal activity return. |
