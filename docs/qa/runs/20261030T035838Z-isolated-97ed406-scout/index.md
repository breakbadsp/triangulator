# QA run 20261030T035838Z-isolated-97ed406-scout

- Time: 2026-10-30 04:26 UTC
- Version: source 97ed406 (0.1.0)

| Case | Revision | Status | Observation |
| --- | ---: | --- | --- |
| QA-101 | 1 | PASSED | healthy: Healthy control had no resource-fault finding or stored incident. First MCP finding: none during observation. |
| QA-102 | 1 | BLOCKED | cpu-spin: Saturation finding and high worker-hot CPU appeared in MCP and browser. The required thread-detail interaction was not completed. First MCP finding: 10 s (10 s polling resolution). |
| QA-103 | 1 | PASSED | cpu-oversub: Expected finding and relevant dashboard state observed. First MCP finding: 10 s (10 s polling resolution). |
| QA-104 | 1 | BLOCKED | cpu-throttle: Delegated cgroup setup returned EBUSY. CPU quota fixture was not launched. First MCP finding: none during observation. |
| QA-105 | 1 | BLOCKED | yield-storm: CPU-wait finding observed. Two-CPU affinity split four yield workers; saturated-thread prerequisite was not established. One namespace-wide TCP retransmission warning was unrelated to this socket-free fixture. First MCP finding: 10 s (10 s polling resolution). |
| QA-106 | 1 | PASSED | lock-convoy: Expected finding and relevant dashboard state observed. First MCP finding: 10 s (10 s polling resolution). |
| QA-107 | 1 | FAILED | deadlock: Two worker threads remained in futex wait with zero switches and an active heartbeat. No live finding or stored incident appeared through 70 s. First MCP finding: none during observation. |
| QA-108 | 1 | FAILED | mem-leak: Dashboard showed sustained RSS growth and a memory incident was stored. Live MCP stayed Healthy with no finding through 70 s. Dashboard/MCP parity failed. First MCP finding: none during observation. |
| QA-109 | 1 | BLOCKED | mem-oom: Delegated cgroup setup returned EBUSY. Memory-limited fixture was not launched. First MCP finding: none during observation. |
| QA-110 | 1 | PASSED | vm-bloat: Expected finding and relevant dashboard state observed. First MCP finding: 10 s (10 s polling resolution). |
| QA-111 | 1 | BLOCKED | fd-leak: Real descriptors reached 91.7% and live MCP became critical at 70 s. Complete dashboard expectations were not captured before fixture replacement. First MCP finding: 60 s (10 s polling resolution). |
| QA-112 | 1 | BLOCKED | disk-sync: Fixture ran 70 s. Final writers were running; required uninterruptible I/O stalls were not established. CPU findings were observed. First MCP finding: 10 s (10 s polling resolution). |
| QA-113 | 1 | BLOCKED | major-faults: Major faults and kernel saturation were detected in MCP and browser. Related I/O-stall expectation was not established. First MCP finding: 10 s (10 s polling resolution). |
| QA-114 | 1 | PASSED | tcp-slow: Expected finding and relevant dashboard state observed. First MCP finding: 10 s (10 s polling resolution). |
| QA-115 | 1 | PASSED | udp-drop: Expected finding and relevant dashboard state observed. First MCP finding: 10 s (10 s polling resolution). |
| QA-116 | 1 | PASSED | close-wait: Expected finding and relevant dashboard state observed. First MCP finding: 10 s (10 s polling resolution). |
| QA-117 | 1 | PASSED | listen-full: Expected finding and relevant dashboard state observed. First MCP finding: 10 s (10 s polling resolution). |
| QA-118 | 1 | BLOCKED | thread-churn: Fixture ran 70 s. Dashboard displayed lower bound for churn. Required help disclosure was not opened; no complete UI pass. First MCP finding: none during observation. |
| QA-119 | 1 | FAILED | thread-leak: Thread count grew to hundreds over 165 s. Dashboard warned about growth and scanner stored a thread incident. Live MCP stayed Healthy. Sampler throttling was disclosed. First MCP finding: none during observation. |
| QA-120 | 1 | PASSED | stopped: Five stopped threads detected by 50 s (within 5 s of SIGSTOP). After SIGCONT, fresh samples returned Healthy within 5 s. First MCP finding: 50 s (10 s polling resolution). |

## Package and environment

The user approved source-build testing. Binaries came from the prior successful
build of `97ed406a035772d50a2099fc966d2c50fed6f622`. No product source differs
from that revision. No published package or checksum was used. Component and
fixture SHA-256 values, Node version, platform, and ports are in
[evidence/identity.json](evidence/identity.json). Its revision field identifies
the QA checkout commit, not a different product build.

Run time: 2026-10-30 03:58:38–04:21:25 UTC. One sampler, collector, scanner,
and MCP server ran in one user/PID namespace with private `/proc`. Fixtures
ran sequentially at 2 Hz, resource interval 2 s, memory interval 5 s. Recordings
used 1 s instead of the documented 5 s. Each executed fixture ran at least
70 s; thread-leak ran 165 s. Fixtures had two-CPU affinity to bound host load.
The service reached 883 MB memory and 512 MB swap peaks. Cgroup setup failed;
the two constrained fixtures were skipped. Host sampler PID 1531596 remained
at `/home/daksh/triangulator/bin/triangulator-sampler` and was not signalled.
The test sampler could not read `/dev/kmsg`; kernel exit messages were unavailable.

The T3 browser used Chrome 152.0.7977.167, viewport 1280×800, and the isolated
HTTP port from identity.json. Browser text is in [evidence/browser.json](evidence/browser.json).
Capture filenames describe the intended capture point. The text identifies the
actual process: some captures occurred after the next fixture started. Those
captures do not prove the prior fixture passed. Healthy control was also observed
in the initial browser session. Full help and thread-detail interactions were
not completed. No screenshot files were available from the preview tools.

## Results and limits

20 attempted: 9 PASSED, 3 FAILED, 8 BLOCKED. Eighteen fixtures executed.
PASSED applies to the observed scenario expectations, not full UI regression.
Other manual cases are excluded from this requested bugbench scope. Prior blocked
records and QA-126 through QA-133 results remain unchanged.

The main failures are the missing stuck-thread response and live MCP parity for
RSS and thread growth. To reproduce, run the isolated driver on this source,
observe deadlock for 70 s, mem-leak for 70 s, and thread-leak for 165 s. Compare
`status_now` with the current dashboard and `list_incidents`. Raw data are in
[evidence/observations.json](evidence/observations.json),
[evidence/fleet.json](evidence/fleet.json), and [evidence/mcp.json](evidence/mcp.json).
Finding delays have 10-second polling resolution. Healthy control had no false
positive. The yield fixture had an unrelated namespace-wide TCP warning. This
run shared the host network namespace, so network-wide findings can include
unrelated traffic. No false-positive rate is inferred from one run.

Incident list counts can include an overlapping prior session. Match the session
in each status reply and incident ID before assigning an incident to a fixture.
The driver queried up to three incident details per window. Empty lists do not
prove complete coverage. The scanner stored RSS and thread-growth incidents
that live MCP omitted.

After collector restart, all 54 history queries failed with Unknown target:
[evidence/history-mcp-first.json](evidence/history-mcp-first.json). A single retry
started one isolated sampler on an owned namespace process to restore the target
key. All 54 `timeseries`, `top_threads`, and `compare` calls then succeeded across
the 18 recorded fixture windows: [evidence/history-mcp.json](evidence/history-mcp.json).
CPU-spin history ranked the hot thread near 99.3% CPU. Coverage remains unknown;
replies disclose missing samples, discovery limits, and unknown throttle history.
This also exposes a restart limitation: history requires a currently known target.

The first setup attempt is retained in [evidence/setup-attempt.json](evidence/setup-attempt.json).
Only test-owned processes and services were stopped. No product fixes were made.
`make check` passed; see [evidence/check.log](evidence/check.log). The source build
and checksum provenance remain in the preceding run record.
