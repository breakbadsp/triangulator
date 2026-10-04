# Triangulator: notes for contributors and coding agents

## Where code belongs

- **Latency- and performance-critical code goes in C++ or Rust.** This
  covers the sampler, and in the collector: receiving datagrams, the alert
  engine, storage, and the dashboard API. The C++ collector in `collector/` is
  the core; `docs/collector-comparison.md` shows why (5–11× less CPU than the
  Python collector, dashboard p95 under 2 ms where Python reached 22–79 ms
  under load).
- **Everything else can use other languages, outside the core.** Email and
  other notifications, reports and richer dashboard data are separate programs
  (Python is fine). They read the SQLite day files (read-only; WAL lets them
  read while the collector writes) or the HTTP API. They never read the UDP
  stream and never run inside the collector's main loop, so a slow helper can
  only delay itself.
- Don't add features to the core that weren't asked for. Email was left out
  of the C++ collector on purpose.

## Conventions

- C++: follow `$HOME/ai/conventions/cpp.md` and run `make format`.
- Each commit must build and pass `make check` on its own.
