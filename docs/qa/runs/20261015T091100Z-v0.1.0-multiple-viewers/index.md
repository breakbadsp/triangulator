# Multiple dashboard viewers: v0.1.0

Run date: 2026-10-15 UTC. Browser observations: 09:11–09:12 UTC.
Scope: simultaneous viewers, local filters and replay, shared target control,
new viewers, reconnect, separate browser engines, and saved watch conflicts.
Results: 2 PASSED, 0 FAILED, 3 BLOCKED, 2 NOT_RUN. All seven cases use revision 1.
The full installation, bug lab, help, memory, and socket suites are excluded.
The user requested the multiple-viewer scope.

## Package identity

The latest published stable release was
[v0.1.0](https://github.com/breakbadsp/triangulator/releases/tag/v0.1.0),
published 2026-10-08T19:19:37Z. Both components use el9-x86_64 packages.
Both published `.sha256` files passed before extraction.
Source revision: `188d0b5c6ef83df0c2ec5175cd944c550ba11801`.
Release notes include target control and historical inspection. The release
predates saved thread watches and current master `d1e4928`.

| Component | Published package | SHA-256 |
| --- | --- | --- |
| Sampler | [triangulator-sampler-0.1.0-el9-x86_64.tar.gz](https://github.com/breakbadsp/triangulator/releases/download/v0.1.0/triangulator-sampler-0.1.0-el9-x86_64.tar.gz) | `5a073d466f5a97074b0ba810363a80001d7426865bc45a0dc3279e1c3b445c0e` |
| Collector | [triangulator-collector-0.1.0-el9-x86_64.tar.gz](https://github.com/breakbadsp/triangulator/releases/download/v0.1.0/triangulator-collector-0.1.0-el9-x86_64.tar.gz) | `e734ac92c45725a4592f6859930f8a4e20b4ac19e61463567dfec1097f44a038` |

Evidence: [release metadata](evidence/release.json),
[sampler checksum](evidence/triangulator-sampler-0.1.0-el9-x86_64.tar.gz.sha256),
[collector checksum](evidence/triangulator-collector-0.1.0-el9-x86_64.tar.gz.sha256).

## Environment and method

- Host: Omarchy, Linux `7.2.5-3-omarchy`, x86_64. This host is not AlmaLinux.
- Installed runtime and `TRIANGULATOR_HOME`:
  `/tmp/triangulator-mv-20261015/triangulator`.
  Packaged `scripts/start.sh` and `scripts/set-target.sh` started the programs
  and selected the healthy fixture. No source product binaries were substituted.
- UDP `127.0.0.1:19400`; application `http://127.0.0.1:19401/` and
  `http://localhost:19401/`. These URLs reach the same collector.
- Browser: T3 Code 0.0.45, Chrome 152.0.7977.130, Electron 44.4.2, Linux.
  Two tabs, `tab_3` and `tab_4`, 1280 × 800 CSS pixels each.
  Separate origins isolate browser storage. They do not provide separate
  profiles, engines, people, remote machines, or independent browser processes.
- Product settings: 1 Hz thread sampling, resource samples every 5 seconds,
  memory-map sampling disabled, replay every second. See
  [sampler settings](evidence/sampler.toml) and
  [collector settings](evidence/collector.toml).
- Fixture: `bug-lab/bugbench.c` at `d1e49287591785d4dfddc9d3be3bac247ee5115d`.
  Built with `gcc -O2 -Wall -Wextra -pthread` only for test data.
  Fixture SHA-256 `d2f1baaf7ca5c55fef6b9581baf86ed21f17d5e039c875f3fe361518a636da50`.
  Owned healthy PID `2209952`, cpu-spin PID `2209953`, each with 3600-second limit.
  Collector PID `2209978`, sampler PID `2210004`.
- The first shell ended its background processes. The second shell stayed open
  in execution session `44155`. This was an environment setup issue.
  Existing installations and user data were preserved.

T3 navigation, CSS click and type tools performed UI actions. Read-only
`preview_evaluate` captured rendered DOM text and browser resource timings.
Evaluation did not change application state. Snapshot tools failed repeatedly.
Recording timed out. The next snapshot reported no available automation host
and instructed the agent not to retry. No screenshots or recordings were saved.
Durable browser JSON evidence preserves the first unconfirmed stale-value observation.
Console errors and full network diagnostics could not be collected.
See [browser tool errors](evidence/browser-tool-errors.txt).

## Results

| Case | Revision | Status | Observation and evidence |
| --- | --- | --- | --- |
| QA-038 | 1 | PASSED | Both tabs showed healthy PID 2209952, Connected, and advancing chart times. Each browser resource list showed repeated `/api/live` calls about one second apart. [A](evidence/initial-a.json), [B](evidence/initial-b.json), [later B](evidence/live-unfiltered-b.json). |
| QA-039 | 1 | PASSED | A entered `worker-0` in the thread search and selected Latest recording. A showed Historical at 14:41:37 local time; B retained an empty search and Live with advancing times. When B changed the target, A retained the healthy recording while B showed cpu-spin. [A replay and filter](evidence/replay-filter-a.json), [B live](evidence/live-unfiltered-b.json), [A after target change](evidence/historical-after-target-change-a.json), [B after target change](evidence/live-after-target-change-b.json). |
| QA-040 | 1 | BLOCKED | B selected cpu-spin PID 2209953. A returned to Live and showed cpu-spin PID 2209953. Immediately after opening Change target, its input value was old healthy PID 2209952. The observation did not capture input disabled state, target status, or completion of the target read. It cannot establish a stale enabled editor. Browser host loss prevented resolution. No stale form submission was attempted. [First observation](evidence/stale-target-a.json). |
| QA-041 | 1 | BLOCKED | Browser host loss prevented a new-viewer/history check after the target change. The two initial simultaneous tabs alone do not establish this case. [Tool errors](evidence/browser-tool-errors.txt). |
| QA-042 | 1 | BLOCKED | Browser host loss prevented the intentional outage and reconnect UI check. No reconnect pass is inferred from HTTP tests. [Tool errors](evidence/browser-tool-errors.txt). |
| QA-043 | 1 | NOT_RUN | Independent profiles, Firefox, Safari, mobile engines, and remote clients were not supplied or attempted. Two origins in one Chromium engine do not establish browser compatibility. |
| QA-044 | 1 | NOT_RUN | Saved thread watches are absent from v0.1.0. Test on a package that contains this feature. Current-source HTTP observations are separate from browser acceptance. |

## Unconfirmed observation: QA-040

1. Open A at `http://127.0.0.1:19401/` and B at `http://localhost:19401/`.
   Monitor healthy PID 2209952. Both initial target editors contain this PID.
2. In A, enter `worker-0` in thread search. Select Latest recording.
3. In B, open Change target. Enter cpu-spin PID 2209953. Select Monitor.
4. Observe B show `bb-cpu-spin PID 2209953 · Live · just now`.
   Observe A retain `bb-healthy PID 2209952 · Historical · just now`.
5. In A, select Live. Open Change target.
6. Expected: after the target read completes, the enabled editor identifies
   the current shared target. Observed immediately after opening: the header
   shows `bb-cpu-spin PID 2209953 · Live · just now`, but the input value
   is `2209952`. Input disabled state, target status and GET completion were
   not captured. This can be a valid intermediate state during the target read.

The initial report classified this observation as FAILED. Review found that
the evidence did not establish completion of the target read. The result is
BLOCKED. The original observation remains available. No retry or passing result
is claimed. Shared target selection itself worked. An already-open editor
during another viewer's save was not tested.

## Limits

This run supports two simultaneous views in one Chromium engine. It does not
establish a safe viewer count, remote access, cross-engine compatibility,
authorization isolation, saved-settings conflict handling, outage behavior,
or full regression readiness. Shared target changes affect all live viewers.
Replay and search state remained local in the tested sequence.
The collector was retained for parent-owned supplemental HTTP checks, then
stopped after those checks completed. See cleanup below.

## Cleanup

At 2026-10-15T09:15:55Z, packaged `scripts/stop.sh` stopped the owned sampler
PID `2210004` and collector PID `2209978`. `kill -TERM` stopped the owned
healthy fixture PID `2209952` and cpu-spin fixture PID `2209953`.
`ps` showed no remaining process for these four PIDs. Downloaded packages,
test configuration, recordings and logs remain in the isolated `/tmp` directory.
No user-owned installation or process was stopped.
