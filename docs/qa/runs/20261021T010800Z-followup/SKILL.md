# Follow-up QA contract

Use the [Senior Manual QA workflow](../../../../.codex/agents/senior-manual-qa.toml).
Test package `dev-384352f`. Identify earlier packages used for upgrade tests.

- Each agent writes only its assigned run directory. Only the dashboard agent
  can revise the QA-002 and QA-003 definitions. The parent owns the result table,
  README summary, this contract, and the result merge script.
- Test through the documented interface. HTTP checks do not prove browser
  behavior. Preserve failures, raw browser errors, and partial coverage.
- Each run writes `results.json` as an array. Each object has `case_id`,
  `status`, `revision`, `package`, `run`, and `evidence`. Paths start at the
  repository root. Status is PASSED, FAILED, BLOCKED, or NOT_RUN.
- Link every result to its run and durable evidence. Explain every blocked
  or unrun expectation. Do not change a result to pass without observing all
  expectations. The parent checks the evidence before it merges result rows.
- Preserve other test processes. Stop only the processes owned by the run.
- Do not commit or push. The parent validates, commits, and updates PR #124.
