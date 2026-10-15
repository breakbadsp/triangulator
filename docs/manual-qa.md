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
- Check help with pointer, keyboard, Escape, and touch. Check narrow screens,
  viewport edges, zoom, and both themes. Check saved preferences after reload.
- Use [bugbench.c](../bug-lab/bugbench.c) for controlled faults and a healthy
  comparison. Confirm that observed findings match the active scenario. Allow
  enough time for growth and sustained-wait checks. Do not treat an unobserved
  fault as a passing test.

Use [bug-lab/README.md](../bug-lab/README.md) for fixture entry points. Derive
feature-specific cases from the requested behavior. Report package identity,
failures, blockers, and untested scope with the requested run.
