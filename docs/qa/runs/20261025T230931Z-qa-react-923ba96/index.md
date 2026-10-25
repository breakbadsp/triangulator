# Full package QA: phase11 first run

UTC: 2026-10-25T23:09:31Z to 2026-10-25T23:11:16Z.

Package: `qa-react-923ba96567f7e7729434763e043bb60ee2fa3cc5`. Platform: `local-linux-x86_64-gcc16`.
Source commit: `923ba96567f7e7729434763e043bb60ee2fa3cc5`.
Source tree: `bf4047b9f29ee5486ecd9da884a3d0439af5f164`, equal to reviewed `3acd6a28a85cf5bfb4ce03ea3462433eecb596e1`.

Result: 1 PASSED, 1 FAILED, 0 BLOCKED, 114 NOT_RUN. Full did not pass. Sanity stopped at QA-002.

## Package and environment

The user authorized these local feature packages. No stable release or source build was substituted. Both downloaded `.sha256` files passed `sha256sum -c` before extraction. Both packages have the same archive VERSION. The binaries support `--help`; no compiled version is claimed. Package identity and parent build evidence are in [artifact-manifest.json](evidence/artifact-manifest.json). No separate release notes were supplied; the task brief and current case definitions set the scope.

| Component | Filename | SHA-256 | Source |
| --- | --- | --- | --- |
| sampler | `triangulator-sampler-qa-react-923ba96567f7e7729434763e043bb60ee2fa3cc5-local-linux-x86_64-gcc16.tar.gz` | `694a4295cdd5c65c6d161b53836013f2309790a6a1e79a16b55f6826e2a6df13` | [Archive](http://127.0.0.1:45269/triangulator-sampler-qa-react-923ba96567f7e7729434763e043bb60ee2fa3cc5-local-linux-x86_64-gcc16.tar.gz), [checksum](http://127.0.0.1:45269/triangulator-sampler-qa-react-923ba96567f7e7729434763e043bb60ee2fa3cc5-local-linux-x86_64-gcc16.tar.gz.sha256) |
| collector | `triangulator-collector-qa-react-923ba96567f7e7729434763e043bb60ee2fa3cc5-local-linux-x86_64-gcc16.tar.gz` | `646b01f349d29aa213e100c496ca1101b84a084bcc3eb2efdae8ad8e397a470e` | [Archive](http://127.0.0.1:45269/triangulator-collector-qa-react-923ba96567f7e7729434763e043bb60ee2fa3cc5-local-linux-x86_64-gcc16.tar.gz), [checksum](http://127.0.0.1:45269/triangulator-collector-qa-react-923ba96567f7e7729434763e043bb60ee2fa3cc5-local-linux-x86_64-gcc16.tar.gz.sha256) |

Host: Omarchy Linux, x86_64, kernel `7.2.8-9-omarchy`. Browser: T3 collaborative preview, incognito, Chrome `154.0.0.0`, viewport 1280 × 800 CSS pixels. Browser timezone: Asia/Kolkata.

Installed once under `/tmp/triangulator-qa-phase11-923ba96/triangulator`. The setup used packaged templates and `scripts/start.sh`; it selected owned PID 270445. HTTP: <http://127.0.0.1:57583>. UDP: 127.0.0.1:56846. [Setup recipe](evidence/setup.py), [collector configuration](evidence/collector.toml), [sampler configuration](evidence/sampler.toml).

The first launcher exited and its collector/sampler processes ended. Initial navigation returned `ERR_CONNECTION_REFUSED`. The same installation was started in retained exec session 1939. The browser then loaded normally. This was a harness setup issue, not a product retry. One incorrect link-name locator also timed out; the snapshot ref then opened the process page.

Runtime retained: collector PID 270535, sampler PID 270547, owned sleep fixture PIDs 270445 and 270446. Browser tab: `tab_2_dc011108-9ada-400d-9a9d-0a225d0f3758`. See [runtime identity](evidence/runtime.json). The fixture is `/usr/bin/sleep 86400`; no fixture source was compiled. Setup recipe revision: 1, based on package source commit above. No user service or installation was changed. Parent artifact server PID 269278 was preserved.

## QA-002 failure

Case revision: 1. One product attempt; no retry.

1. Open the Targets overview after QA-001 shows PID 270445 live.
2. Click Add target.
3. Enter `qa-second` in Target ID and `270446` in Process name or PID.
4. Click the Add target button inside the dialog.

Expected: Confirmation completes. Both targets remain live. The second process and its threads appear. Selection survives reload.

Actual: A visible Manage targets help panel covers the confirmation button. The fields accept text, but the browser click cannot reach the button. It returns `locator.click: Timeout 3000ms exceeded.` The second target is not added. Later QA-002 expectations cannot be reached.

Read-only browser inspection found the help paragraph at the button center `(787, 534)`. Its text starts with `Limits. Control requires a local sampler`. No console error or failed network request accompanied this product failure. No DOM or application state was changed through evaluation.

[Failure screenshot](evidence/qa002-blocked-submit.png). [Browser observations and diagnostics](evidence/observations.json).

## Scope and validation

Full selects 116 definitions: 96 in test-cases.md and 20 in bug-lab-cases.md. Only QA-001 and QA-002 were executed. The saved stop rule excludes all remaining cases from execution in this run, including QA-003 and QA-005. Their earlier current-result rows remain unchanged. QA-031 sanitizer evidence, WSL2, a second browser engine, an older package, a privileged observer, and user-systemd prerequisites were not assessed after the gate failed. No unavailable prerequisite is counted as a pass.

No case definition or application input changed. The package tree equals reviewed 3acd6a2. Per the task authorization, no application build or full make check was repeated for QA documents. Parent artifact manifest records successful static release validation. PR172 has successful format and QA-results checks; its AlmaLinux job was CANCELLED, which is not counted as a pass or failure. Local QA summary and link validation passed with `python3 scripts/qa_summary.py --write-readme --check`. `git diff --check` passed.

## Case results

| Case | Revision | Status | Observation |
| --- | ---: | --- | --- |
| QA-001 | 1 | PASSED | Verified both checksums; packaged startup needed no compiler; browser showed sleep, PID 270445, one fresh sleep thread, and live sample clocks. |
| QA-002 | 1 | FAILED | Manage targets help covered the Add target confirmation button. Browser click timed out; no second target appeared. |
| QA-003 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-004 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-005 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-006 | 1 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
| QA-007 | 2 | NOT_RUN | Not attempted: stopped at blocking Sanity failure QA-002. |
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
