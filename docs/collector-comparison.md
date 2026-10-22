# Collector choice: historical evidence

- Measured on 2026-10-04: Intel Core i5-9500, 16 GB RAM, Linux 7.2, GCC 16.2 `-O2`, Python 3.14, SQLite 3.53.
- A UDP tee sent the same input to both collectors. CPU is a percentage of one core; memory is peak PSS.
- At 1,000 threads and 10 Hz: Python used 32.2% CPU and 557.5 MB; C++ used 4.08% and 244.0 MB. API p95 was 78.8 ms versus 0.89 ms.
- At 2,500 threads and 10 Hz: Python used 71.7% CPU and 582.6 MB; C++ used 12.3% and 264.6 MB. API p95 was 22.0 ms versus 1.69 ms.
- These comparisons included alerting in both collectors. Neither lost packets. One live-view mismatch occurred when a thread changed between reads.
- Removing C++ alerting reduced its CPU at 1,000 threads from 4.08% to 2.18%. That later comparison measures different work and must not be called a language-only gain.
- These are host-specific historical results. They support the C++ decision but do not establish current capacity or tail-latency guarantees.
- The Python collector and comparison script were removed. Reproduction requires the historical source: `git log --diff-filter=D -- triangulator/engine.py`; full-port revision: `7a1d83b`.
