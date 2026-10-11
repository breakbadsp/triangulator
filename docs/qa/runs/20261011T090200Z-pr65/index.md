# PR 65 memory zoom browser QA

UTC execution: 2026-10-11T09:02Z to 2026-10-11T09:14Z.
Target: [PR 65](https://github.com/breakbadsp/triangulator/pull/65),
head `44decf5d15c16f6221bb689ae89831e0f3e7d7d0`.
Scope: Memory zoom changes and affected regression cases.
Results: 3 PASSED, 1 FAILED, 5 BLOCKED. No complete release acceptance claim.

## Product and environment

Downloaded the `almalinux-9-new-user-test` CI artifact from
[run 38125162087](https://github.com/breakbadsp/triangulator/actions/runs/38125162087).
Artifact ID: 11697550290. Download command:
`gh run download 38125162087 -n almalinux-9-new-user-test`.
This is a PR CI artifact, not published release 0.1.0. It contains separate
static x86_64 release binaries, not versioned tar packages. No checksum file
was published for these artifact binaries. Download verification against a
published checksum was unavailable. Local SHA-256 identities follow.

| Component | Source identity | SHA-256 |
| --- | --- | --- |
| `release/triangulator-collector` | CI merge `baadbd7d819f5ac78c13084bef952b1b6c6f34c7` | `b28cff532080dced5215352971dfbf99d8631842f76dbc12e16eb82193ec83f0` |
| `release/triangulator-sampler` | Same CI merge | `92155e207fe35604c99add2ecfe6886ab797860f643a3e2cf8d4f2da8a427676` |
| `release/triangulator-socket-report` | Same CI merge; not executed | `14b33d932fbab577ff8e631a8f2a33280fc3ccc18d0027849140ef09d6d65811` |
| Dashboard | PR head 44decf5 | `ef9cb4f031e6ebdc52e2fe621435d19c717582a1000f9ee42194e2fc642ba9dd` |

The CI merge parents are master 12267f15197b6b5fb4a6ab839d650a9fde00a432 and
PR head 44decf5d15c16f6221bb689ae89831e0f3e7d7d0. The dashboard HTTP response
has the same SHA-256 as `collector/dashboard.html` at that PR head. No local
product build was used for browser testing. Local builds validate the QA commit.

Host: Omarchy 4.0.4, Linux 7.2.5-3-omarchy, x86_64. Browser: T3 Code 0.0.45,
Electron 44.4.2, Chrome 152.0.7977.130. T3 tab: `tab_7`.
Viewports: 1280×800 initially; 390×844 for narrow layout.
Runtime: `/tmp/pr65-qa-runtime`; UDP 19650, collector HTTP 19651,
HTTP fixture 19652. Application URLs: `http://127.0.0.1:19651/#memory-map`
and `http://127.0.0.1:19652/#memory-map`.

Copied the CI binaries, PR-head startup/control scripts, and configuration
templates into the isolated runtime. Used `TRIANGULATOR_HOME` and documented
`scripts/start.sh` and `scripts/set-target.sh`. Memory and resource intervals
were 1 second. `max_live_samples` was 10000. Existing installations were preserved.
The initial shell ended its child processes. Restarted test-owned processes
in retained exec sessions before browser execution. That setup attempt did
not establish a product failure.

Compiled only `bug-lab/bugbench.c` from 44decf5 with `cc -O2 -pthread`.
Live workloads: healthy and mem-leak. Target selection used the control script
after browser target input failed. No UI target-control pass is claimed.
API fixtures use real captured collector JSON with controlled addresses,
page metadata, timestamps, target IDs, and coverage flags. They do not test
kernel 64 KiB sampling or impossible real x86_64 virtual addresses.

## Results

[Observations](evidence/observations.json) contain read-only browser DOM text,
layout geometry, and supplemental history reads. No application or DOM state
was changed through evaluation scripts. Fixture state changed in the HTTP
server before the dashboard fetched it. Browser navigation loaded each fixture.

| Case | Revision | Status | Observation and limit |
| --- | --- | --- | --- |
| QA-008 | 1 | BLOCKED | Heap legend matched heap, gap, and neighboring file cells. Selecting all other bars did not produce reliable browser actions. Full legend coverage was not established. |
| QA-011 | 2 | PASSED |4 KiB and 64 KiB captions used binary units. Missing, zero, wrong-target, and initially stale metadata showed Unknown and byte cell sizes. Valid page size survived later resource staleness. Session change reset metadata/history. Non-padding grid cells stayed at or below 512. |
| QA-012 | 1 | BLOCKED | Unchanged live samples refreshed measured zero-growth intervals. Fixture heap growth/contraction and stale/delayed availability were observed. Target and session reset history. Full main-stack selection and outline behavior were not established. |
| QA-013 | 1 | BLOCKED | Contiguous heap showed 0 B. Grouped high-address anonymous mappings showed 128 KiB gap. Partial, truncated, stale, and delayed layouts showed Unavailable with 32 unknown cells. The Largest unmapped gap guide did not open through reliable automation. |
| QA-014 | 1 | BLOCKED | High-address fixture preserved heap+ 4 KiB, contraction− 4 KiB, and stack− 4 KiB offsets. Missing or stale layouts had unavailable boundaries. New session showed Collecting. Both chart guides and every sampled-step rendering expectation were not established. |
| QA-015 | 1 | BLOCKED | Narrow charts had equal 328 px widths and successive vertical positions; document width 390 px matched viewport. Member regions was observed open in one attempt across samples. Keyboard and guide actions did not complete reliably. |
| QA-016 | 1 | FAILED | Heap margin help opened and explained a stable span. Neighboring file color remained. A 4 KiB heap increase shifted the display end despite fitting inside the previous margin. See failure below. |
| QA-017 | 1 | PASSED | Late resource arrival filled RSS 2134016 and anonymous 159744 into the same memory timestamp. Two valid points produced 156 KiB→156 KiB history. A later stale resource sample retained that chart and 4 KiB caption. New session showed Collecting. |
| QA-018 | 1 | PASSED | Healthy unchanged heap showed 0 B with advancing intervals. New live mem-leak target reset history. Anonymous resident bytes increased 221.4→270.2 MiB at +445.2 MiB/min, while brk heap stayed 132 KiB and heap-end offset stayed 0 B. |

Cases outside these 9 cases were excluded as unrelated to the requested PR.
Their current-result rows remain unchanged. The full bug-lab suite, installation
upgrade, replay, privileged BPF, and actual 64 KiB host were not tested.
Earlier QA-108 release findings remain historical; QA-018 does not replace them.

## Confirmed failure: heap grid span resets during small growth

Priority: Medium. Case: QA-016. Tested identity: PR 65 head 44decf5 dashboard,
CI merge baadbd7 collector/sampler. Repeated on 4 KiB metadata after an initial
64 KiB display fixture showed the same behavior. The 4 KiB retry uses aligned
addresses and a page-sized change. Retained both observations.

1. Serve the unchanged PR dashboard with a complete current fixture. Use
   heap start `0x1000000000000000`, size 1048576, and page size 4096.
2. Open Memory map. The default selection is the heap. Keep help closed.
3. Observe grid range `0x1000000000000000–0x1000000000140000`, 320 cells.
4. Set heap size 1052672 and layout ID 2. Wait for the next dashboard poll.
5. Observe heap end `0x1000000000101000` and grid end
   `0x1000000000142000`, 322 cells.

Expected: The previous grid range stays fixed because the 4 KiB growth fits
within its existing 256 KiB margin. Existing cells change from unmapped to mapped.
Actual: The grid end increases by 8 KiB and its cell count changes. This breaks
the stable-span behavior stated in QA-016, the implementation checklist, and
Heap display margin help. No console or network evidence was available.

Durable browser evidence: [Before](evidence/margin-repro-before.json),
[after](evidence/margin-repro-after.json). A separate earlier attempt is in
`margin-growth` observations from the 64 KiB metadata fixture.

### Fixture reproduction

Use [fixture_server.py](evidence/fixture_server.py), [live.json](evidence/live.json),
and [map.json](evidence/map.json). The script reads `/tmp/pr65-qa-runtime`.
Put these files there; put the exact PR dashboard in `share/dashboard.html`.
Create `state.json` with `{"page":4096,"layout":1}`. Run
`python /tmp/pr65-qa-runtime/fixture_server.py`, then open HTTP 19652 in a real
browser. After recording the first caption, replace `state.json` with
`{"page":4096,"layout":2,"heap":1052672,"stack":4096}`. Do not reload the page.
Wait for polling and compare the second caption. Stop only that fixture server.

Other fixture switches: `page:null`, `page:0`, `page:65536`,
`resource_pid:999`, `resource_stale:true`, `partial:true`, `truncated:true`,
`stale:true`, `delayed:true`, `gap_only:true`, `session:"newsession"`.
`stamp` keeps memory.updated constant for delayed resource arrival. Set stale
resources first, then clear resource_stale while retaining stamp; increment
stamp for a later memory sample. Navigation starts fresh metadata/history cases.

## Browser limits and validation

Snapshot and recording tools failed. Keyboard input failed. Several click tools
reported success without the requested visible change. Retried with inspected
selectors and one coordinate attempt. [Tool errors](evidence/browser-tool-errors.txt)
retain those failures. Used only T3 preview tools; no alternate browser.
No screenshot/video was obtained. Durable DOM text is the failure evidence.
Console/network diagnostics and full visual guide verification remain blocked.
These tool limits are not reported as product defects.
Stopped only the test-owned sampler, collector, healthy workload, and fixture server.
The mem-leak workload ended after its configured duration.

Validation passed: `make -j2`, `make -j2 check`, and `git diff --check`.
The privileged BPF test was skipped because its separate environment was unavailable.
