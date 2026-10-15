# PR #65 heap span fix retest

UTC execution: 2026-10-11T09:46:29Z to 2026-10-11T09:50Z.
Scope: Retest the reported heap span defect and its affected state transitions.
Results: QA-019 PASSED; full QA-016 BLOCKED by incomplete interaction coverage.
The [original failed run](../20261011T090200Z-pr65/index.md) remains unchanged.

## Tested identity and environment

Dashboard source: PR #65 fix commit
`957e763bd74eec6122f81618116c28dd6a383078`.
Dashboard SHA-256:
`df16db6701a5b864f572151ee59ffdb6a7e0221031e8a2b32c519e25e04e36f6`.
The user requested a fix and merge. This retest substitutes that exact source
dashboard into the saved isolated HTTP fixture. It is not a newly published
package test or a source build of the collector or sampler.

The fixture input remains captured data from CI merge
`baadbd7d819f5ac78c13084bef952b1b6c6f34c7`. Its collector and sampler identities,
artifact source, hashes, and missing published checksum verification remain
in the original run. No live collector or sampler was needed for this focused
HTTP fixture retest. Source addresses above `2^53` exercise exact arithmetic;
they are not real x86_64 target addresses.

Host: Omarchy 4.0.4, Linux 7.2.5-3-omarchy, x86_64.
Browser: T3 Code 0.0.45, Electron 44.4.2, Chrome 152.0.7977.130.
T3 tab: `tab_7`; viewport: 390×844.
Application: `http://127.0.0.1:19652/#memory-map`.
Runtime: `/tmp/pr65-qa-runtime`. Started and stopped only the test-owned fixture
server. Existing user installations and data were preserved.

Checked preview_status first. Navigation and read-only evaluation succeeded.
The screenshot retry still failed with:
`Preview automation snapshot failed on client preview-035180eb30c217995da643ac43b0a17d.`
No alternate browser or evaluation-based UI action was used. Evidence is actual
browser DOM text, grid classes, and supplemental cell styles. Console and
network diagnostics remain unavailable.

## Observed results

| Case | Revision | Status | Observation |
| --- | --- | --- | --- |
| QA-019 | 1 | PASSED | Small growth and contraction retained the span. Stale and delayed layouts omitted the margin; recovery restored it. Growth beyond the span reset it. Target change reset it. Neighbor cells retained file-mapping styles. |
| QA-016 | 1 | BLOCKED | The reported span defect passed its narrow retest. This run did not complete all help and selection actions from the full case. It does not mark the whole case PASSED. |

All other cases were outside this focused retest. Their current rows remain
unchanged. No live-workload, replay, full browser regression, or actual 64 KiB
host retest was performed.

### Original reproduction now passes

1. Open the fixed dashboard with `{"page":4096,"layout":1}`.
2. Observe the default heap selection. Its mapping end is
   `0x1000000000100000`. Grid end is `0x1000000000140000`, with 320 cells.
3. Change fixture state to
   `{"page":4096,"layout":2,"heap":1052672,"stack":4096}` without reloading.
4. After the next polls, inspect the heap caption, growth fact, and legend.

Expected and actual: Heap end changes to `0x1000000000101000`. Grid end stays
`0x1000000000140000`; cell count stays 320. Growth shows `+4.0 KiB in 1 s`.
The legend includes mapped since the previous layout and file mapping.
This corrects the original result, which changed the end to
`0x1000000000142000` and the count to 322.

Evidence: [Before](evidence/before.json), [growth](evidence/growth.json).

### Related transitions

The [observations](evidence/observations.json) retain each attempt.

- Contraction to 1044480 bytes changed the heap end to
  `0x10000000000ff000`; the original grid end and 320 cells stayed fixed.
- Stale memory omitted Heap display margin. Fresh memory restored the
  original grid end and 320 cells.
- A 1572864-byte heap exceeded the original span. The fixture first removed
  its neighboring file mapping to prevent an impossible overlap. The new grid
  end was `0x10000000001e0000`, with 480 cells and a 384 KiB margin.
- Delaying layout 6 with heap size 1576960 hid the margin and reported
  unavailable coverage. Delivery restored `0x10000000001e0000` and 480 cells.
- Changing PID to 202 and restoring the original heap and file mapping reset
  the grid end to `0x1000000000140000`, with 320 cells.
- The neighbor retained 16 cells with `var(--k-file)` and `/tmp/neighbor`
  labels. See [neighbor evidence](evidence/neighbor.json).

Early reads after 1.7 seconds sometimes showed the prior fixture state or
pending coverage before the next poll. Retained these reads as `delayed` and
`recovered`. A second delay/recovery sequence used 3.2-second waits and showed
both expected states as `delayed_confirmed` and `delayed_recovered`. No timing
requirement was contradicted, and no failed observation was replaced.

## Reproduction and validation

Use the [retest fixture server](evidence/fixture_server.py). Reuse `live.json`
and `map.json` from the original run, and put the fixed dashboard in
`/tmp/pr65-qa-runtime/share/dashboard.html`. The server reads `state.json` from
that same runtime. Start it with `python /tmp/pr65-qa-runtime/fixture_server.py`.
Open its URL in a real browser. Update the fixture state outside the browser.
Do not reload during the transitions above.

This server adds `no_neighbor:true` to remove the file before large growth.
Use `stale:true` or `delayed:true` to hide the margin. Clear that flag to test
recovery. Use `pid:202` with the original heap size to test target reset.

QA document validation passed: `make -j2`, `make -j2 check`, and `git diff --check`.
The Python suite ran 71 tests with one skip.
The privileged BPF test requires a separate environment and remains skipped.
