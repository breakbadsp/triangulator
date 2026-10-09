# Bug lab

`bugbench.c` is a deliberately buggy program: 19 resource bugs (CPU, memory,
descriptors, storage, sockets, threads) and a healthy control. Run one at a time
against Triangulator and see whether the dashboard finds the bug.
It is a test fixture, not product code, and is not built by `make`.

For an interactive agent session, use
[`bugbench-session`](../.agents/skills/bugbench-session/SKILL.md).
Ask the agent to start the session, then ask for the next or previous program.
The skill installs the fixture in `~/triangular/bin/` and saves its position
between requests. It reports the PID for manual dashboard target selection.

```sh
gcc -O2 -pthread bug-lab/bugbench.c -o /tmp/bugbench
/tmp/bugbench --list
/tmp/bugbench fd-leak 60        # runs as process "bb-fd-leak" for 60 s
```

`run-lab.sh` runs scenarios in turn, selects each as the sampler's target and
captures the dashboard with `capture.mjs` (Node and headless Chromium, no npm
packages). Use a scratch `TRIANGULATOR_HOME` and ports so your normal instance
is untouched. `cpu-throttle` and `mem-oom` use `systemd-run --user --scope`.
The sampler must already run in that runtime directory. The default capture
delay is 70 seconds. `thread-leak` uses 165 seconds so the dashboard can observe
two minutes of growth. Set `HOLD` to override the delay for all selected
scenarios. The runner stops its scenario and capture process on failure or
interrupt. It does not stop the sampler or collector.
Each runner invocation uses a new temporary directory for the executable and
storage workloads. `BUGBENCH` and `BUG_LAB_DIR` can override these paths. The
runner removes only its own temporary directory.

Results: [docs/bug-lab-report.md](../docs/bug-lab-report.md).
