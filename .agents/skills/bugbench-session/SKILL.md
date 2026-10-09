---
name: bugbench-session
description: Run an interactive Triangulator bugbench test session. Install the fixture, start one scenario, and handle next, previous, named scenarios, status, and stop requests.
---

# Bugbench session

Use this skill when the user wants to run bugbench and select its process in
the dashboard. This is an interactive workload session, not package or browser QA.

Run the helper from the repository root:

```sh
python3 .agents/skills/bugbench-session/scripts/session.py start
```

`start` copies `bug-lab/bugbench.c` to `~/triangular/bin/bugbench.c`, compiles
`~/triangular/bin/bugbench`, and starts the first scenario. If a session already
has a running process, report it. If its process has ended, restart that scenario.
The requested directory is `triangular`, not `triangulator`.

Translate subsequent requests into helper commands:

- Next program: `next`.
- Previous program: `previous`.
- Named scenario: `run SCENARIO`.
- Current process: `status`.
- Stop the session: `stop`.
- Available scenarios: `list`.

The helper saves its position in `~/triangular/bugbench-session/state.json`.
Read that state through `status`; do not infer the position from conversation
history. Navigation follows the fixture's list, with `healthy` last. It stops
at each end of the list. `next` without saved state starts the first scenario.
The default duration is 1,800 seconds. Add `--seconds N` for a requested duration.

The helper stops only the service it saved before it starts another scenario.
It uses user systemd services, a 50% CPU quota for `cpu-throttle`, and a 256 MiB
memory limit with no swap for `mem-oom`. Other scenarios have a 2 GiB memory
limit with no swap. Storage files use a unique directory under `/var/tmp`.
Python 3, GCC, and a working user systemd manager are required. If these are
unavailable, report the error. Do not run a constrained scenario without its limit.

After each start, report the scenario, verified PID, duration, and launch command
from the helper output. Tell the user to select that PID as the dashboard target.
For `mem-oom`, tell the user to select it immediately: the kernel can kill it in
about 30 seconds. For `thread-leak`, allow at least 165 seconds of observation.
If the process has ended, report that fact instead of a live PID.

Leave dashboard target selection to the user unless they ask you to change it.
Do not start the next scenario until requested. Explain observations from the
fixture and dashboard rules when asked. Never treat a zero sampled churn count
as proof that no threads started or ended.
