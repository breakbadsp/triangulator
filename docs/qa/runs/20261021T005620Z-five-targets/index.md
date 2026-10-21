# Five-process investigation on the current CI package

UTC: 2026-10-21 00:55–01:04. Result: 6 PASSED, 2 FAILED, 2 BLOCKED,
1 NOT_RUN. This is a feature run with affected Sanity cases. It is not Full.

## Package and environment

The stable release v0.1.0 predates the requested multi-target feature. This run
uses the matching downloadable Release CI packages from
[run 39518873537](https://github.com/breakbadsp/triangulator/actions/runs/39518873537),
artifact `packages-el9` (ID `12310276992`). No product source build was used.
Both components identify version `dev-384352f`. Source revision:
`384352f99b85b3ce849af32429a3be78726a09fd`.

| Package filename | SHA-256 |
| --- | --- |
| triangulator-sampler-dev-384352f-el9-x86_64.tar.gz | cccbb44b375b3cb95da6713c79cbfe5db00ad874fe504b2c98ceae6b62604094 |
| triangulator-collector-dev-384352f-el9-x86_64.tar.gz | 307b7d75c550b51e45f0436f8e1dd087ed9edc74d052ab9abeeed2043a525f6b |

Both published sidecars passed `sha256sum -c` before extraction. The artifact
source is `https://api.github.com/repos/breakbadsp/triangulator/actions/artifacts/12310276992/zip`.
The sidecars and active configurations are in [evidence](evidence/).

Host: Omarchy 4.0.5, x86_64, Linux 7.2.8-9-omarchy. The EL9 static packages run
on this Arch-derived host. Browser: T3 preview, Chromium 154.0.0.0, Linux,
1280 × 800. URL: `http://127.0.0.1:19471`. UDP: loopback port 19470.
Runtime: `/tmp/triangulator-five-39518873537/install/triangulator`.
Configuration, data, logs, PIDs, and ports are separate from the normal install.

Only the fixture was compiled: `gcc -O2 -pthread bug-lab/bugbench.c -o /tmp/triangulator-five-39518873537/bugbench`.
Compiler: GCC 16.2.1 20260810. Fixture source revision equals the package source
revision. Executable SHA-256:
`d2f1baaf7ca5c55fef6b9581baf86ed21f17d5e039c875f3fe361518a636da50`.
Commands use packaged `scripts/start.sh`, `scripts/set-target.sh`, and
`scripts/set-rate.sh`, with `TRIANGULATOR_HOME` set to the isolated runtime.

## Setup and scope

One sampler (PID 265591) monitored five exact process names:
`control=bb-healthy`, `cpu=bb-cpu-spin`, `memory=bb-mem-leak`,
`fds=bb-fd-leak`, and `locks=bb-deadlock`. Initial fixture PIDs were 265522,
265523, 265528, 265531, and 265535. Each fixture used a 3600-second duration.
Restarted locks used PID 274898. The later memory observation used PID 302177.
Thread sampling started at 5 Hz, resource sampling at 2 s, memory sampling at
5 s, and recording at 1 s. The shared CPU budget was 1%. It reduced the thread
rate to about 4.01 Hz. A packaged rate command then set 4 Hz; the rate later
reduced to 3.60 Hz. This is shared sampler status, not a process fault.

The first start command returned before the browser could connect. Its sampler
and collector had ended when the command session ended. A retained command
session fixed the test setup. Duplicate fixture processes from that setup made
name selection ambiguous. Stopping those owned duplicate processes restored
selection. These setup failures are not product failures.

The feature run reused the documented fault expectations from QA-101, QA-102,
QA-107, QA-108, and QA-111. It did not execute their complete one-at-a-time
procedures or update their result rows. QA-077 records the combined workflow.
CPU-sensitive observations finished before the parent ran `make -j2 check`.
The parent reported all C++ executables and 167 Python tests passed, with one
expected privileged BPF skip. Log: `/tmp/triangulator-five-target-make-check.log`.

## Results

All case revisions below are 1. Package: `dev-384352f (CI)`.
Browser observations, URL states, and failure evidence are in
[observations.json](evidence/observations.json). The `stage` field identifies
the observation. No passing screenshots were saved.

| Case | Status | Observation |
| --- | --- | --- |
| QA-001 | PASSED | Verified both packages; packaged startup loaded the dashboard and five named processes with live threads. No browser error prevented this behavior. |
| QA-002 | BLOCKED | The current UI has Manage targets and Add target. The revision 1 procedure requires Change target and Monitor. The alternate add workflow ran as QA-076. |
| QA-003 | BLOCKED | The same obsolete control names prevent exact execution. Duplicate-ID rejection was checked in QA-076; empty and nonexistent PID steps remain unexecuted. |
| QA-005 | PASSED | Live CPU drawer showed worker-hot at about 100% and stored history. Healthy recordings at 06:30:18 and 06:32:25 showed the correct process and sample time. History ended at the recording time; Live resumed updates. |
| QA-061 | FAILED | Independent target selection worked, but closing a drawer discarded the target query. See F-01. Narrow-screen, zoom, and unavailable-target substeps remain unexecuted. |
| QA-073 | PASSED | Five picker entries matched the expected PIDs, threads, RSS, descriptor limits, and waits. CPU stayed selected in the second tab during first-tab switching. An explicit URL restored CPU. |
| QA-074 | PASSED | Only locks stopped. Final view retained PID 265535 and later named new PID 274898. Show live selected the new process. Control stayed live. |
| QA-075 | FAILED | Escape and Close thread details both removed the target query. Reopening the resulting URL selected control rather than locks. See F-01. |
| QA-076 | PASSED | Cancelled add did not add extra. Confirmed add appeared in both pickers. Confirmed removal left both pickers. Sampler PID stayed 265591. Duplicate control was rejected: this target id is already configured. Final configuration retained the original five targets. |
| QA-077 | PASSED | CPU assessment named worker-hot at 99.7–99.9%. Descriptor target reached 300/300 with a top finding. Locks named two long futex waits and a possible deadlock, without claiming proof. Memory had sustained RSS growth in both Memory and assessment. Healthy remained Healthy. |
| QA-078 | NOT_RUN | Collector capacity was 8, not the required 5. A separate restart/setup is needed. Run this after the first PR, as requested. |

Memory observation stayed on the live process from browser time 1792544556181
through 1792544641136 (84.955 s). The final assessment said RSS rose in 54 of
54 samples, about 448.1 MiB/min. Memory showed the same warning. The locks
assessment named `worker-a` and `worker-b`, reported waits over 3 minutes,
and explained that `/proc` cannot identify the lock. The descriptor assessment
said 100% of file descriptors in use, 300 of 300, and named EMFILE.

## F-01: Closing a thread drawer removes target selection from the URL

Severity: Major. Impact: a copied investigation URL can open a different
production process. The source tab still shows its prior selection, so the
change is easy to miss.

Reproduction:

1. Open `http://127.0.0.1:19471/?target=omarchy%2Fcpu`.
2. Select thread TID 265529. The URL ends in
   `?target=omarchy%2Fcpu#thread=265529`.
3. Press Escape. The drawer closes. The URL becomes `/`, while the picker
   still selects `omarchy/cpu`.
4. Repeat with `locks`, thread TID 274898, and Close thread details. The URL
   again becomes `/`, while the picker still selects `omarchy/locks`.
5. Open that resulting URL in a new tab or a clean incognito profile. The
   browser opens `?target=omarchy%2Fcontrol` and displays `bb-healthy`.

Expected: the close action removes only `#thread=...` and retains `?target=...`.
Actual: both target query and thread fragment disappear. Both close methods
failed. The second attempt confirmed the first failure. The browser showed no
application error needed to trigger this failure. Evidence stages:
`url-repro-open`, `url-repro-escape`, `url-locks-open`, `url-locks-close`,
`same-profile-reopen`, and `incognito-reopen`.

## Other observations and exclusions

Duplicate adds ask for confirmation before server validation. This matches the
known issue addressed in unmerged PR #123. Rejected requests preserve the
configuration. CLI `--remove spare` left a silent picker entry because collector
idle expiry had not elapsed. This is the documented CLI behavior. Dashboard
removal of extra cleared it from both viewers. Collector restart recovery is
already tracked by PR #122 and was not retested here.

A rapid replay click followed immediately by a row click read stale hidden
drawer text in early attempts. These attempts did not establish a failure.
Waiting for the recorded view and visible drawer produced matching snapshot
and history times. The run retains only visible, settled replay evidence.

Excluded from this first run: five-target capacity, per-target watch persistence,
collector restart, remote/multi-host control, limited access, unsupported browser
engines, old-release upgrade, long retention, and unrelated regression cases.
QA-002 and QA-003 need updated UI procedures, already proposed in PR #123.
No broad regression readiness claim is made.

At parent request, the test runtime remains for the post-PR follow-up. CPU and
memory fault processes are stopped. Healthy, descriptor, and deadlock fixtures,
one sampler, and one collector remain test-owned. The parent must stop these
owned processes after the follow-up. Current PIDs are in
[fixture-pids.json](evidence/fixture-pids.json). The package, fixture, runtime,
and retained command session are reusable. No existing installation was changed.

This run used more than the 40-call Sanity target because it added feature
scenarios, checked several tabs, restored setup preconditions, and corrected
browser locators. No case status depends on the call budget.

## Follow-up records

- [Dashboard](../20261021T010700Z-dashboard-followup/index.md)
- [Contract and merge script](../20261021T010800Z-followup/index.md)
- [Sanitizers](../20261021T011600Z-sanitizers-followup/index.md)
- [Capacity and sanitizer stop](../20261021T0700Z-capacity-sanitizer-followup/index.md)
- [Memory and API](../2026-10-21-memory-api-followup/index.md)
- [Upgrade lifecycle](../2026-10-21-upgrade-lifecycle-followup/index.md)
