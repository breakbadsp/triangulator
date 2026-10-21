# Bug lab

`bugbench.c` is a deliberately buggy program: 19 resource bugs (CPU, memory,
descriptors, storage, sockets, threads) and a healthy control. Run one at a time
against Triangulator and see whether the dashboard finds the bug.
It is a test fixture, not product code, and is not built by `make`.

Run the session without an agent with `scripts/bugbench-session`. To make the
command available on PATH, run these commands from the repository root:

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/scripts/bugbench-session" "$HOME/.local/bin/bugbench-session"
export PATH="$HOME/.local/bin:$PATH"
```

Add the `export` line to your shell configuration to keep it for new shells.
Keep the source checkout: the symlink calls its existing session helper.
Python 3, GCC, and a working user systemd manager are required.

```sh
bugbench-session                         # start or resume the saved scenario
bugbench-session list
bugbench-session next
bugbench-session previous
bugbench-session run fd-leak --seconds 300
bugbench-session status
bugbench-session stop
```

The command runs one scenario at a time. The default duration is 1,800 seconds.
It installs the fixture in `~/triangular/bin/` and shares the agent's saved
session in `~/triangular/bugbench-session/`. Use `--home DIR` for a separate
session. It preserves the CPU and memory limits described in the skill below.
Select the reported PID as the dashboard target. For `mem-oom`, select it
immediately. For `thread-leak`, observe it for at least 165 seconds.

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
