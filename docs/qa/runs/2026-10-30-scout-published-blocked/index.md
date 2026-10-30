# QA run 2026-10-30-scout-published-blocked

- Time: 2026-10-30 03:27 UTC
- Version: unavailable

| Case | Revision | Status | Observation |
| --- | ---: | --- | --- |
| QA-126 | 1 | BLOCKED | Published v0.1.0 has no separate tri-scout.mjs asset; no source build authorized. |
| QA-127 | 1 | BLOCKED | Published v0.1.0 has no separate tri-scout.mjs asset; no source build authorized. |
| QA-128 | 1 | BLOCKED | Published v0.1.0 has no separate tri-scout.mjs asset; no source build authorized. |
| QA-129 | 1 | BLOCKED | Published v0.1.0 has no separate tri-scout.mjs asset; no source build authorized. |
| QA-130 | 1 | BLOCKED | Published v0.1.0 has no separate tri-scout.mjs asset; no source build authorized. |
| QA-131 | 1 | BLOCKED | Published v0.1.0 has no separate tri-scout.mjs asset; no source build authorized. |
| QA-132 | 1 | BLOCKED | Published v0.1.0 has no separate tri-scout.mjs asset; no source build authorized. |
| QA-133 | 1 | BLOCKED | Published v0.1.0 has no separate tri-scout.mjs asset; no source build authorized. |

## Package gate

The latest published stable release is [v0.1.0](https://github.com/breakbadsp/triangulator/releases/tag/v0.1.0), published on 2026-10-08. Its source tag is `188d0b5c6ef83df0c2ec5175cd944c550ba11801`. The complete [asset inventory](evidence/release.json) contains only collector and sampler archives for EL8/EL9 x86_64 and their checksums. It has no separate `tri-scout.mjs` asset. The documented [scout download](https://github.com/breakbadsp/triangulator/releases/latest/download/tri-scout.mjs) returned HTTP 404 on 2026-10-30.

Reproduce with `gh release view v0.1.0 --json assets` and `curl -L -o /dev/null -w '%{http_code}\n' https://github.com/breakbadsp/triangulator/releases/latest/download/tri-scout.mjs`.

No scout package was acquired. Its version, SHA-256, and checksum verification are unavailable. Collector and sampler packages were not downloaded or installed because the scout prerequisite failed. No source build replaced the missing release artifact. The QA-126 and QA-129 source-build steps were excluded under the published-artifact constraint.

## Scope and observations

Feature scope: live findings, scanner incidents, and historical queries across QA-126 through QA-133, plus all 20 bugbench scenarios in `bug-lab-cases.md`, including the healthy control. Case revisions are 1. Eight scout cases are BLOCKED. All 20 scenario comparisons are BLOCKED at the package gate; they did not run. Existing dashboard-only QA-101 through QA-120 results remain unchanged because this run did not retest their dashboard expectations.

No browser behavior case passed or failed. No product bug was confirmed. Detection delays, dashboard parity, incident recovery, retention, and history completeness were not measured. This run does not establish readiness.

Environment: Linux x86_64; repository revision `97ed406a035772d50a2099fc966d2c50fed6f622`. T3 `preview_status` reported `available=false`, with no tab. No browser was opened after the package blocker. Browser version, viewport, application URL, fixture hash/compiler, and runtime configuration are not applicable because installation and fixture execution did not start. No test processes or data were created. [Compact observations](evidence/observations.json) record the scenario statuses.

Sanity QA-001/002/003/005 did not start because the requested scout artifact is missing. Unrelated regression and client/SSH integration beyond this scope are excluded. No case definitions changed. Publish a compatible separate `tri-scout.mjs` release asset to unblock a new run.

## Record validation

`qa_record.py` ran `qa_summary.py --write-readme --check` successfully. `git diff --check` passed. `make check` passed, including dashboard checks, native builds, and 190 Python tests. These source validation checks do not establish scout package behavior.
