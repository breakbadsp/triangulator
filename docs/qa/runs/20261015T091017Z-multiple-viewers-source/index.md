# Multiple dashboard viewers: HTTP tests and source analysis

Run start: 2026-10-15 09:10:17 UTC.

Scope: Several viewers of one collector. These are supplemental HTTP tests and
source analysis. They do not establish a browser case as PASSED.
See the [package browser run](../20261015T091100Z-v0.1.0-multiple-viewers/index.md)
for UI results and package checksums.

## Software and environment

- Current source: `d1e49287591785d4dfddc9d3be3bac247ee5115d` on `master`.
- Source build: `make -j4 all`, with the default compiler and warning flags.
- Collector SHA-256:
  `fe2d9f51722b82f5c29a05811cdb107a372cc417a256571f8ca4087afcf4df05`.
- Host: Linux `7.2.5-3-omarchy`, x86_64, glibc 2.44.
- Source fixture: `tests/sampler_target.py`, with 26 threads. Sampling: 5 Hz.
  Resource sampling: 1 second. Replay recording: 1 second.
- The harness used a temporary runtime directory and unused loopback ports.
  It stopped its collector, sampler, and fixture after the run.
- A separate HTTP run used the verified v0.1.0 package runtime on port 19401.
  Its source revision is `188d0b5c6ef83df0c2ec5175cd944c550ba11801`.
  The fixture had five threads. All 522 ordinary live requests returned HTTP
  200. With 50 clients, the 95th percentile was 1012.03 ms and the maximum was
  1217.90 ms. Idle and incomplete connections delayed another request by
  5.08 and 4.92 seconds. The byte-per-second attempt held it for 7.00 seconds,
  until the first connection was closed. These results match the source risks.

## Confirmed results on current source

### Ordinary live reads

Each client sent one `/api/live` request per second for six rounds. Clients
started together. Each response contained about 16 KB. All 522 requests returned
HTTP 200 with valid JSON.

| HTTP clients | Requests | Median | 95th percentile | Maximum |
| --- | --- | --- | --- | --- |
| 2 | 12 | 0.65 ms | 1.06 ms | 1.24 ms |
| 10 | 60 | 2.01 ms | 3.86 ms | 4.46 ms |
| 25 | 150 | 3.18 ms | 9.77 ms | 1043.46 ms |
| 50 | 300 | 3.26 ms | 1015.01 ms | 1212.31 ms |

These are short API tests on loopback. They are not tests of 50 browser users.
A browser also requests resources, recordings, thread history, and other data.
The run does not establish a supported user limit.

### One connection delays all viewers

1. Open a TCP connection to the dashboard port.
2. Send no request, or send headers without the final blank line.
3. Send a complete `/api/live` request on a second connection.

The second request took 4.95 seconds with an idle first connection. It took
4.92 seconds with incomplete headers. A third attempt sent one header byte per
second. The second request was still waiting after seven seconds. It completed
only after the first connection was closed.

The [HTTP server](../../../../collector/http.hpp) accepts and handles one
connection at a time. Its five-second socket timeout applies to each read.
The header loop has no total request deadline. Thus, a slow or speculative
browser connection can delay every dashboard view. Slow response downloads,
large history queries, and target-control calls also share this serving thread;
their worst-case delays were not measured here.

Sample ingestion continued during all three delays. `raw_samples` increased,
`last_seen` advanced, and the reported packet loss and dropped samples stayed
at zero. This separates the HTTP delay from a collector ingestion failure.

### A stale settings save replaces another editor's rules

1. Start two editors with the same empty watch-rule list.
2. Save `worker-a` with `wake_ms = 500` from editor A.
3. Save `worker-b` with `wake_ms = 1000` from editor B's earlier state.
4. Read `/api/watches` again.

Both saves returned HTTP 200. The final list contained only `worker-b`.
The server did not report a conflict. The harness then reset the rules.

The [watch settings code](../../../../collector/watch.hpp) replaces the complete
list. It does not check an editor revision. The UI keeps unsaved edits local,
so two operators can overwrite each other's changes. This is a confirmed
API behavior and a multi-editor risk. A browser test of the new Settings tab
was not performed on current source.

## Other scenarios from source analysis

| Scenario | Expected effect and evidence |
| --- | --- |
| Several people view the same target | The API sends a shared snapshot. Viewers do not consume or remove samples. Ordinary live reads worked in this run. |
| Each person needs a different monitored process | One sampler has one shared target. A target save changes it for all viewers. Separate browser views do not create separate targets. |
| One person changes the target while another edits it | An already-open form does not poll for external target changes. Opening the form again fetches the target and disables submission during the read. The package browser observation did not establish whether that read had finished, so it does not confirm a stale enabled form. |
| Viewers open the page at different times | Live process trends and load averages use each view's local buffer. Their chart spans and derived values can differ. Resource and thread history use stored collector data. |
| One person inspects a recording | `replayAt`, filters, selected threads, and buffers stay in the browser view. The package browser run confirmed replay and filter isolation. |
| A tab stays in the background | Browser timer delays can reduce live observations. This run did not measure browser throttling or sleep recovery. |
| People need separate access permissions | HTTP has no authentication or user roles. The `X-Triangulator` and origin checks do not distinguish viewers from operators. See the documented [SSH tunnel setup](../../../setup.md#install-from-a-release-package). |

## Recommended changes

1. Give HTTP connections bounded concurrent handling and a total request
   deadline. Keep sample ingestion in its separate loop.
2. Add a revision check to watch-rule saves and resets. Reject stale changes
   with a clear conflict message and retain the unsaved draft.
3. Test a target form that stays open during another operator's target change.
   Check whether an old draft needs a warning before it replaces the new target.

These changes were not made. The user requested analysis and tests.

## Evidence and reproduction

- [Current-source HTTP observations](evidence/http-source.json).
- [v0.1.0 HTTP observations](evidence/http-v0.1.0.json).
- [Reproduction harness](harness/http_checks.py).

Run from the repository root after `make all`:

```sh
python3 docs/qa/runs/20261015T091017Z-multiple-viewers-source/harness/http_checks.py . /tmp/multiple-viewers-source.json
```

The default mode starts and stops isolated source-built programs. The optional
`--port PORT --runtime-revision REVISION` mode uses an existing test runtime,
skips watch-rule writes, and leaves that runtime running. Both modes deliberately
delay the test runtime's HTTP service during the slow-connection checks.

Not tested: Separate browser engines, independent browser profiles, remote
clients, high-latency links, large thread populations, large historical stores,
and sustained load. No result here establishes readiness for those conditions.

Validation: `make -j4 all` and `make -j4 check` passed. The check ran the six
native test programs and 119 Python tests. One privileged BPF case was skipped
because this run did not provide that environment. The QA summary and
`git diff --check` also passed.
