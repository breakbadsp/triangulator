# QA run 20261030T034910Z-source-97ed406-scout

- Time: 2026-10-30 03:50 UTC
- Version: source 97ed406 (0.1.0)

| Case | Revision | Status | Observation |
| --- | ---: | --- | --- |
| QA-101 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-102 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-103 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-104 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-105 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-106 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-107 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-108 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-109 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-110 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-111 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-112 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-113 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-114 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-115 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-116 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-117 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-118 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-119 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-120 | ? | BLOCKED | Existing user sampler PID 1531596 prevents isolated collection under the one-sampler constraint. Scenario not launched; detection delay and false positives unmeasured. |
| QA-126 | 1 | BLOCKED | Partial direct MCP checks only. No isolated sampled target; complete case expectations were not executed. See scope and MCP evidence. |
| QA-127 | 1 | BLOCKED | Partial direct MCP checks only. No isolated sampled target; complete case expectations were not executed. See scope and MCP evidence. |
| QA-128 | 1 | BLOCKED | Partial direct MCP checks only. No isolated sampled target; complete case expectations were not executed. See scope and MCP evidence. |
| QA-129 | 1 | BLOCKED | Partial direct MCP checks only. No isolated sampled target; complete case expectations were not executed. See scope and MCP evidence. |
| QA-130 | 1 | BLOCKED | Partial direct MCP checks only. No isolated sampled target; complete case expectations were not executed. See scope and MCP evidence. |
| QA-131 | 1 | BLOCKED | Partial direct MCP checks only. No isolated sampled target; complete case expectations were not executed. See scope and MCP evidence. |
| QA-132 | 1 | BLOCKED | Partial direct MCP checks only. No isolated sampled target; complete case expectations were not executed. See scope and MCP evidence. |
| QA-133 | 1 | BLOCKED | Partial direct MCP checks only. No isolated sampled target; complete case expectations were not executed. See scope and MCP evidence. |

## Scope and execution limits

The user authorized a source build. `make -j2 all scout` succeeded at source
`97ed406a035772d50a2099fc966d2c50fed6f622`. Component SHA-256 values,
fixture source hash, Node version, host, and isolated ports are in
[evidence/identity.json](evidence/identity.json). No published package or
published checksum was used. The MCP server reports version `0.1.0`.

All 20 bugbench scenarios and QA-126 through QA-133 were selected. All 28
cases are BLOCKED. No complete case passed or failed. Other cases are excluded
because this request covers scout and bugbench, not Full regression.

Before sampler startup, `/proc/1531596/exe` identified the existing user sampler:
`/home/daksh/triangulator/bin/triangulator-sampler`, with configuration
`/home/daksh/triangulator/config/sampler.toml`. No second sampler was started.
The existing installation was not changed or stopped. Scenario processes were
not launched because isolated collection could not proceed. Constrained
scenarios and the 165-second thread-leak observation remain unexecuted.
The concurrency proof was not run because it starts another sampler.

## Observations

[Real stdio MCP requests and replies](evidence/mcp.json) show initialization,
seven advertised tools, empty current target lists, a missing incident store
with unknown coverage and explicit gaps, invalid incident window and ID errors,
and an invalid history target error. After `enabled=false`, the next status
call returned a tool error and serve exited 2. The scanner stayed running for
three seconds without recordings and exited 2 after the switch edit. This does
not prove incident persistence, retention, restart, concurrent writes, historical
metrics, limits on populated replies, client integration, or SSH behavior.

A real collaborative Chromium tab loaded `http://127.0.0.1:56939/` at
1280 by 800. Its browser version was not captured. The page title was
`Targets · Thread monitor`. Visible text said `No targets yet. A target appears
here when its sampler sends its first data to this collector.` The console had
no entries. The page also stated that the local sampler sends to a different
collector. This empty view agrees with the empty MCP list. It is not a scenario
or dashboard case pass. The tab was closed after inspection.

No fault was collected. Current verdict correctness, incident/history evidence,
detection delays, false positives, and data gaps for each scenario are unknown.
The earlier blocked package run from PR #206 remains unchanged.

The reusable driver is `scripts/qa/qa_scout_mcp.py`. It starts only an isolated
collector, scanner, and MCP server. It never starts a sampler. An initial local
driver attempt failed in its process-search regular expression before component
startup. The corrected inspection found the existing sampler. A preliminary
MCP run and the final retained run gave the same empty-target behavior.

Browser observations are saved in [evidence/browser.json](evidence/browser.json).
All test-owned collector, scanner, and serve processes were stopped. The
existing user sampler remained running. No product code was changed.

Validation: `make check` passed, including 190 Python tests. The QA record writer
ran `scripts/qa_summary.py --write-readme --check` successfully. Python compile
and `git diff --check` passed. These checks do not replace scenario acceptance.
