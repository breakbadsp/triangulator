# Manual QA

Use [Senior Manual QA](../.agents/skills/senior-manual-qa/SKILL.md) when package
or browser QA is requested. The [agent definition](../.codex/agents/senior-manual-qa.toml)
contains the execution workflow. Follow the documentation policy in
[AGENTS.md](../AGENTS.md#documentation).

Automated coverage starts at [tests/](../tests/). Keep browser checks focused on
behavior that those tests cannot establish:

- Install a published package in an isolated runtime. Check live target selection
  and invalid input. Check that an upgrade preserves configuration and history.
- Check live views, recorded views, thread details, and target changes together.
  Confirm that missing data and recording gaps remain clear.
- Use the [manual browser cases](qa/test-cases.md) for Timeline interaction,
  independent Chrome views, slow connections, and watch-rule conflict recovery.
- Check help with pointer, keyboard, Escape, and touch. Check narrow screens,
  viewport edges, zoom, and both themes. Check saved preferences after reload.
- Use [bugbench.c](../bug-lab/bugbench.c) for controlled faults and a healthy
  comparison. Confirm that observed findings match the active scenario. Allow
  enough time for growth and sustained-wait checks. Do not treat an unobserved
  fault as a passing test.

Use [bug-lab/README.md](../bug-lab/README.md) for fixture entry points. Derive
feature-specific cases from the requested behavior. Report package identity,
failures, blockers, and untested scope with the requested run.

## Multiple dashboard viewers

Use one isolated packaged collector and two browser views. Use independent
profiles and record each browser engine and version. Use two owned target
processes. Enable recording before the checks.

- Keep both views Live for at least 20 seconds. Check that both show the same
  target PID, advancing chart times, and fresh data.
- Apply a thread search and select a recording in A. Keep B Live and unfiltered.
  Change the target in B. Check that A keeps its search and historical process,
  and B shows the new live target.
- Return A to Live. Open Change target. Wait for the target read to complete
  and the input and Monitor button to become enabled. Check that the editor
  identifies the current shared target before you submit a change.
- After at least 60 seconds of recording, open a fresh view with empty browser
  storage. Check the live target and open a recording from before that view
  opened. Check that its replay does not change the first view.
- Stop only the test collector for 15 seconds. Check that both views identify
  unavailable or stale data. Restart it with the same configuration and data.
  Check that both views resume fresh data. Report any required page reload.
- Repeat live, search, replay, and shared target checks in independent Chromium
  and Firefox profiles. Use Safari when a supported Apple test device is
  available. Report unavailable engines as untested.
- If the package has saved thread watches, open the same watch list in both
  views. Prepare different edits. Save A, then save B from its earlier state.
  Reload both views. Check that B preserves A's edit or identifies the conflict
  before it replaces the saved list. Record the save order and final rules.

Two origins in one browser engine do not establish browser compatibility.
HTTP checks alone do not establish browser state, reconnect behavior, or a safe
viewer count. Keep those limits explicit in the run results.
