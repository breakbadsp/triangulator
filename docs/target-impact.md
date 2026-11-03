# Sampler impact: measured limits

- Measured on 2026-10-13: Intel Core i5-9500, six cores, Linux 7.2.5, desktop load, 500 target threads. Each scenario ran three 30-second trials.
- Thread sampling took about 4.4 ms per tick on a separate core. At 10 Hz it used 4.43% of one core; at 1 Hz, 0.45%.
- On a separate core, target effects could not be distinguished from host noise at 1 or 10 Hz.
- Sharing a busy core at 10 Hz increased target time lost from 1.7% to 6.7%, and stalls of at least 1 ms from 41 to about 1,900 per minute.
- Sharing a sleeping, latency-sensitive thread's core roughly doubled late timer wakeups. Lower priority did not remove this effect.
- Signal-lock and address-space-lock effects did not repeat reliably. This does not establish safety on other kernels.
- Keep the sampler away from latency-critical target cores when possible. Priority is not a substitute for CPU placement.
- These measurements predate automatic CPU throttling. They are evidence about placement, not the current default CPU budget.
- Reproduce with `make benchmark-target-impact`. Method and exact probes: [driver](../tests/benchmark_target_impact.py), [victim](../tests/benchmark_victim.cpp).
- Measure production Xeon and RHEL hosts separately. Desktop results provide no production tail-latency guarantee.
