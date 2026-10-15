# Bug lab

[bugbench.c](bugbench.c) provides controlled resource faults and a healthy
comparison. It is a separate test fixture. List scenarios with:

```sh
gcc -O2 -pthread bug-lab/bugbench.c -o /tmp/bugbench
/tmp/bugbench --list
/tmp/bugbench fd-leak 60
```

For an interactive agent session, use
[bugbench-session](../.agents/skills/bugbench-session/SKILL.md).
[run-lab.sh](run-lab.sh) defines batch setup, timing, output, and cleanup.
Use an isolated `TRIANGULATOR_HOME` and unused ports. Its capture helper uses
headless Chromium; requested agent QA uses the shared browser through
[Senior Manual QA](../docs/manual-qa.md). Local batch evidence goes to `build/bug-lab/`.
