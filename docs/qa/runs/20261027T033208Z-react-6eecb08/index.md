# Full QA: React dashboard 6eecb08

Run started at 2026-10-27T03:32:08Z UTC. Browser actions ran from 03:35:00Z through the failed click at 03:35:32Z; evidence capture followed.

Target: `feature/react-dashboard`, commit `6eecb082b8c9590e098cfc9b9dd65b2ae8d11b8d`.
Tested package: `dev-6eecb08`, `el8-x86_64`, sampler and collector.

Result: **1 PASSED, 1 FAILED, 0 BLOCKED, 114 NOT_RUN. Full did not pass.**
The Senior Manual QA workflow stops at a blocking Sanity failure. QA-002 prevented further execution. Earlier current-result rows remain historical; they are not passes for this package.

## Package and environment

The request named the feature branch. The latest stable release, `v0.1.0`, does not contain its React dashboard. The documented manual package workflow produced packages for the requested commit. No local source build or older package replaced them.

- [Workflow run and package source](https://github.com/breakbadsp/triangulator/actions/runs/40444709277).
- Download: `gh run download 40444709277 --name packages-el8 --dir /tmp/triangulator-qa-react-full-6eecb08/downloads`.
- Artifact: `packages-el8`, ID `12706719725`; [download API](https://api.github.com/repos/breakbadsp/triangulator/actions/artifacts/12706719725/zip).
- Artifact digest reported by GitHub: `sha256:0e8be7a4d820f91713179e2c4d4ffac476fe78d5aa1cc6d618d52fdba01e40ca`. The individual package checksums below were verified with the downloaded `.sha256` files before extraction.

| Component | Filename | Verified SHA-256 |
| --- | --- | --- |
| sampler | `triangulator-sampler-dev-6eecb08-el8-x86_64.tar.gz` | `0e3ac81be58ef82e0d2526c54b6fa6567ebc176e8c7bc97d7c88854f72fe2b64` |
| collector | `triangulator-collector-dev-6eecb08-el8-x86_64.tar.gz` | `92eb3f1c119195e1e7b665c1b6143e1ed1f5d439cf5e0c84f6ed6ece55e54eef` |

Both archives identify version `dev-6eecb08`. No separate release notes were supplied. The branch scope and current case definitions set the acceptance scope.

Host: Omarchy 4.0.6, Linux `7.2.8-9-omarchy`, x86_64, 6 logical CPUs. The EL8 binaries ran on this host; no browser pass on an AlmaLinux host is claimed.

Browser: T3 collaborative preview, default profile, Chrome `154.0.0.0`, 1280 × 800 CSS pixels, timezone `Asia/Calcutta`. URL: `http://localhost:45355`. No prior application data existed at this test origin.

Installed once at `/tmp/triangulator-qa-react-full-6eecb08/triangulator`, with an isolated `TRIANGULATOR_HOME`, UDP port 55745, and HTTP port 45355. The packaged `scripts/start.sh` started one collector and one sampler. Owned fixtures were `/usr/bin/sleep 86400`, PIDs 33895 and 33896. No fixture was compiled. Thread sampling was 5 Hz; resources were 2 s; memory was 5 s; recording was 1 s. The lower live-sample limit was 10,000 per target to limit test memory use.

[Setup recipe](evidence/setup.py), [runtime and package identity](evidence/runtime.json), [collector configuration](evidence/collector.toml), [sampler configuration](evidence/sampler.toml), [workflow metadata](evidence/package-workflow.json).

## Issue 1: Help covers Add target confirmation

Severity: major. Case: QA-002, revision 1. Package: `dev-6eecb08`, EL8. One attempt; no retry. This is also the failure recorded for the older `qa-react-923ba96` package. This run independently observed it on the requested commit, which includes the automatic Help delay change.

Steps:

1. Start the isolated installation and open the live dashboard of owned PID 33895.
2. Select All targets, then Add target.
3. Enter `qa-second` in Target ID and `33896` in Process name or PID.
4. Select the Add target button inside the dialog.

Expected: The addition completes. Both targets stay live. The second process and its threads appear. The selection survives reload.

Actual: Manage targets Help opens over the native dialog's confirmation button. The browser click returns `locator.click: Timeout 5000ms exceeded.` The second target does not appear, so its dashboard and persistence checks cannot run.

The enabled confirmation button occupies x=742.40..833.00, y=515.27..552.96. A read-only hit test at its center reaches the Help panel's `Limits. Control requires a local sampler` paragraph, inside `aside.help-card` and the target dialog. Both input values remain correct. The browser recorded no console error or failed HTTP request at the failure. No POST was sent by the failed confirmation click.

[Failure screenshot](evidence/qa002-help-covers-submit.png). [Browser state, diagnostics, actions, and hit test](evidence/observations.json).

## Issue 2: AlmaLinux 9 package build fails

Severity: major for EL9 packaging. This is a package setup failure, separate from the EL8 browser result.

Steps: Dispatch `release-package.yml` on `feature/react-dashboard` at commit `6eecb08`.

Expected: Both configured platform jobs produce sampler and collector packages.

Actual: [Package for AlmaLinux 9](https://github.com/breakbadsp/triangulator/actions/runs/40444709277/job/121993114815) fails during dependency installation, before compilation. The installed `curl-minimal-7.76.1-40.el9_8.7.x86_64` conflicts with the requested `curl-7.76.1-40.el9_8.8.x86_64`. The step exits with code 1. No EL9 artifact is uploaded. The EL8 job passes and supplies this run's packages. The overall workflow fails; its release publication job is skipped as expected for a branch dispatch.

[Failure log](evidence/el9-package-failure.log). No packaging fix or alternate EL9 build was attempted.

## Scope and validation

Full selects all 116 definitions: 96 dashboard/operation cases and 20 bug-lab cases. QA-001 passed. QA-002 failed. The remaining 114 cases were not attempted under the blocking Sanity rule, including QA-003 and QA-005. This run does not establish readiness for replay, the broader dashboard, bug-lab scenarios, upgrades, multiple viewers, other browser engines, WSL2, optional privileged observers, or other platforms.

All test-owned application and fixture processes were stopped after evidence capture. No user installation or service was changed.

Repository validation: `make -j2 check` passed. It ran six C++ test programs, 362 dashboard tests, parity checks, and 190 Python tests (one privileged BPF test was skipped). The Python run printed a non-failing `ResourceWarning` for an unclosed file. See the [complete check log](evidence/make-check.log). `python3 scripts/qa_summary.py --write-readme --check` and `git diff --check` passed. The README totals did not change because QA-001 remains PASSED and QA-002 remains FAILED. No application code or case definition was changed by this QA work. The [record refresh script](evidence/record_results.py) generates the complete case table and updates only the executed current-result rows; a second run produced no change.

## Case results

<!-- case-results -->

| Case | Revision | Status | Observation |
| --- | ---: | --- | --- |
| QA-001 | 1 | PASSED | Both checksums passed. Package startup needed no compiler. The browser showed sleep, PID 33895, fresh sample clocks, one thread, resources, memory data, and recordings. |
| QA-002 | 1 | FAILED | Manage targets Help covered the confirmation button. The browser click timed out. The second target was not added. |
| QA-003 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-004 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-005 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-006 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-007 | 3 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-008 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-009 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-010 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-011 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-012 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-013 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-014 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-015 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-016 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-017 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-018 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-019 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-020 | 2 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-021 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-022 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-023 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-024 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-025 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-026 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-028 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-029 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-030 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-031 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-032 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-033 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-034 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-035 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-036 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-037 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-038 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-039 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-045 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-046 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-047 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-048 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-049 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-050 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-051 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-052 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-053 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-054 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-055 | 2 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-056 | 2 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-057 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-058 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-059 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-060 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-061 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-062 | 2 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-063 | 2 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-064 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-065 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-066 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-067 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-068 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-069 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-070 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-071 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-072 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-073 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-074 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-075 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-076 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-077 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-078 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-079 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-080 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-081 | 2 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-082 | 3 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-083 | 2 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-084 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-085 | 2 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-086 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-087 | 5 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-088 | 2 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-089 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-090 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-091 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-092 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-093 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-094 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-095 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-096 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-097 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-098 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-099 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-100 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-101 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-102 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-103 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-104 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-105 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-106 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-107 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-108 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-109 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-110 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-111 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-112 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-113 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-114 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-115 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-116 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-117 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-118 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-119 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-120 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-121 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-122 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
