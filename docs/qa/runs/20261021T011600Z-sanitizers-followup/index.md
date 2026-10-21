# Follow-up: sanitizer and normal check runs

Source: the `qa/five-prod-targets` branch on 2026-10-21 (UTC 01:08 to 01:24).
`evidence/commands.json` holds each command, start time, duration, and exit
code.

| Command | Exit | Log | Failing test |
| --- | --- | --- | --- |
| `make -j2 check-sanitizers` (683 s) | 2 | `check-sanitizers.log` | `test_cpu_budget_changes_wire_interval_without_changing_sessions`, ThreadSanitizer only |
| `make -j2 check` (251 s) | 2 | `normal-check.log` | `test_recorded_results_are_consistent` (QA summary consistency) |
| `make check SANITIZER=thread STATIC=1` | 2 | `invalid-static-thread.log` | none: the Makefile refuses `STATIC=1` with a sanitizer |

The ThreadSanitizer failure is a test timing limit. The cause and the fix (a
15 s stop limit) are in the
[capacity and sanitizer record](../20261021T0700Z-capacity-sanitizer-followup/index.md).
The failures above are the state at the time of the run. The current
`make check` result is in the pull request.
