# Bug lab

`bugbench.c` is a deliberately buggy program: 19 resource bugs (CPU, memory,
descriptors, storage, sockets, threads) and a healthy control. Run one at a time
against Triangulator and see whether the dashboard finds the bug.
It is a test fixture, not product code, and is not built by `make`.

```sh
gcc -O2 -pthread bug-lab/bugbench.c -o /tmp/bugbench
/tmp/bugbench --list
/tmp/bugbench fd-leak 60        # runs as process "bb-fd-leak" for 60 s
```

`run-lab.sh` runs scenarios in turn, selects each as the sampler's target and
captures the dashboard with `capture.mjs` (Node and headless Chromium, no npm
packages). Use a scratch `TRIANGULATOR_HOME` and ports so your normal instance
is untouched. `cpu-throttle` and `mem-oom` use `systemd-run --user --scope`.

Results: [docs/bug-lab-report.md](../docs/bug-lab-report.md).
