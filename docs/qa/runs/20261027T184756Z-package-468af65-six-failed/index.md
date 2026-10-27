# Six failed cases rerun: dev-468af65

- UTC: 2026-10-27 17:45–18:48.
- Package: GitHub Actions run 40553628948, artifact `almalinux-8-new-user-test`, source head `468af65`, CI merge `ddba0af1b43a3e503584f7d8f98d336151412b8f` ([commit](evidence/ci-commit.txt)). Binaries `triangulator-collector`, `-sampler`, `-socket-report` (EL8 build, [SHA-256](evidence/binary-sha256.txt) computed locally). The artifact has no published checksum file, so the download could not be verified against a publisher checksum.
- Environment: EL8 x86_64 binaries on Arch Linux, Linux `7.2.8-9-omarchy`; not a native AlmaLinux host. Isolated `TRIANGULATOR_HOME=/tmp/qa-pkg/home`, HTTP 51353, UDP 48717. Repository scripts (`start.sh`, `set-target.sh`) came from the worktree at 468af65 because the artifact holds only binaries. Fixtures: own C programs `qa-a`..`qa-f` with named busy and idle threads. Sampler `memory_interval_s = 5` (template 30); `/dev/kmsg` unreadable.
- Browser: T3 `preview_open` worked, but `preview_snapshot` and locator/selector clicks timed out; only coordinate clicks worked, with no multi-tab or second-profile support. Used local headless Chromium 155.0.8059.84 over CDP (viewport 1280 × 713, [driver](evidence/browser-driver.mjs), [actions](evidence/browser-actions.ndjson)). Native confirm dialogs were accepted through CDP. Console and network errors: only navigation aborts and the expected HTTP 409 of the capacity rejection ([errors](evidence/browser-errors.ndjson)).
- Scope: six cases, revisions unchanged. Result: 5 PASSED, 1 FAILED (QA-060). Evidence: [observations](evidence/observations.json), [QA-060 samples](evidence/qa060-samples.ndjson), [measure script](evidence/qa060-measure.py).

| Case | Status | Observation |
| --- | --- | --- |
| QA-005 | PASSED | Previous from Live opened the newest stored recording (selected 23:35:20 = `/api/replay` last read just before the click, after the page had been live 25 s; second run 23:33:45 likewise). Stepping, recorded thread values, 1 h history ending at the recording time, disabled Settings and return to Live all matched. |
| QA-060 | FAILED | Throttle and badge match the measured CPU, sessions stable, but the rate does not recover to a configured rate that fits the budget (see below). |
| QA-061 | PASSED | Each tab kept its target through switch and reload; links opened their target; a tab without `?target=` opened the Targets overview. |
| QA-071 | PASSED | Local removal gives 404 at once, not 200. Other targets and the observing tab were stable; re-added target had its own data. No case/design mismatch: `collector/README.md` says a removed target does not hold its slot. |
| QA-075 | PASSED | Escape and Close thread details removed only `#thread=`; a fresh Chromium profile opened the same process. |
| QA-078 | PASSED | Sixth target rejected clearly, config and five sessions unchanged; after a slot was freed, the new target went live without mixed data. |

## QA-060 failure

Steps: five targets (three with a busy thread) on one sampler; `rate_hz = 5`, `cpu_budget_pct = 2.2`; `qa-e` creates 400 idle threads at about 45 s and releases them at about 105 s; read `/api/targets` and `/proc/<sampler>/stat` every 10 s.

Expected: after the burst the effective rate recovers to the configured 5 Hz, because 5 Hz costs 1.9–2.0% (measured before the burst) and the budget is 2.2%.

Actual: 5.0 Hz before; 2.552 Hz during the burst; 3.19 then 3.988 Hz after it, and 3.988 Hz for more than 100 s at 1.5–1.8% CPU (about 0.73 of the budget). Badge: `Sampler throttled · 3.99 Hz · CPU 1.66% of one core; budget 2.20%`, equal to the API. Cause (`sampler/budget.hpp`, unchanged): the rate rises only while CPU is below 0.6 × budget, so rates between 0.6 and 1.0 of the budget never recover. This is the earlier ISS-15 behavior, now seen at a sensible budget. No console errors.

Other measurements ([samples](evidence/qa060-samples.ndjson)); five targets, 20 threads:

- 5 Hz, budget 1%: 2.365 Hz at 0.8–0.9%.
- 1 Hz, budget 1%: not throttled, 0.4%.
- 10 Hz, budget 3%: 8.885 Hz at 2.6–3.0%.
- 5 Hz, budget 0.3%: 0.59–0.80 Hz at 0.2–0.35%.
- 5 Hz, budget 0.1%: 0.2–0.34 Hz at 0.06–0.14%. The minimum rate 0.2 Hz costs about the budget, so the budget is exceeded at times.
- Reload (SIGHUP) resets the effective rate, and every target starts a new session. Stopping the busy fixtures did not lower sampler CPU, so those phases do not test recovery.

Overhead: about 0.08% of a core for each target at 1 Hz in this setup.
