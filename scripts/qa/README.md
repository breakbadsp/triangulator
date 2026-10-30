# Shared QA tools

Use these tools in every QA run. Do not copy them into run evidence.

- `qa_setup.py start|stop`: installs verified packages in an isolated home, picks free ports, and runs owned fixtures. `stop` ends only the processes in `state.json`. Why: every run needs the same safe setup.
- `qa_browser.mjs`: sends browser steps (`read`, `click`, `fill`, `screenshot`, and others) to headless Chromium over CDP. Set `QA_ROOT` and `QA_CDP_PORT`. Why: one fixed way to act and log observations.
- `qa_record.py`: writes the run record and updates only the current-result rows in `results.json`, then runs `qa_summary.py --write-readme --check`. Why: one writer for the result rows.
- `qa_cpu_sweep.py`: runs the QA-060 sweep unattended with fixed rates, budgets, and windows. It writes one JSON file and flags phases where the minimum rate still exceeds the budget. Why: QA-060 is slow, and this removes the need for a person to wait.
- `qa_scout_mcp.py --root DIR`: records real stdio MCP replies from source-built scout with an isolated collector and scanner. It starts no sampler. This checks empty data, invalid inputs, and the scout switch when host sampler ownership blocks scenario collection.

`qa_scout_mcp.py --bugbench --root DIR` runs real fixtures only as PID 1 in a
private PID namespace. Use `unshare --user --map-root-user --pid --fork
--mount-proc`. A delegated user service is needed for the two constrained
fixtures; failed cgroup setup blocks those fixtures and continues the run.
`--scenarios NAME ...` selects fixtures. After collection, `--history-only`
queries the saved windows. Inside the same namespace command, it starts one
owned sampler to register the target key after collector restart.
