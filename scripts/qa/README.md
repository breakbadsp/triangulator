# Shared QA tools

Use these tools in every QA run. Do not copy them into run evidence.

- `qa_setup.py start|stop`: installs verified packages in an isolated home, picks free ports, and runs owned fixtures. `stop` ends only the processes in `state.json`. Why: every run needs the same safe setup.
- `qa_browser.mjs`: sends browser steps (`read`, `click`, `fill`, `screenshot`, and others) to headless Chromium over CDP. Set `QA_ROOT` and `QA_CDP_PORT`. Why: one fixed way to act and log observations.
- `qa_record.py`: writes the run record and updates only the current-result rows in `results.json`, then runs `qa_summary.py --write-readme --check`. Why: one writer for the result rows.
- `qa_cpu_sweep.py`: runs the QA-060 sweep unattended with fixed rates, budgets, and windows. It writes one JSON file and flags phases where the minimum rate still exceeds the budget. Why: QA-060 is slow, and this removes the need for a person to wait.
