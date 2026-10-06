# Triangulator: notes for contributors and coding agents

## Where code belongs

- **Latency- and performance-critical code goes in C++ or Rust.** This
  covers the sampler and the core collector in `collector/`: receiving
  datagrams, building per-thread state and rollups, storage, and the
  dashboard API. `docs/collector-comparison.md` shows why (several times less
  CPU and memory than the Python collector, dashboard p95 under 2 ms where
  Python reached 22–79 ms under load).
- **Alerting is a separate module, not part of the core collector.** That
  covers alert rules, dashboard alert settings and delivery (webhook,
  dead-man, email). It reads the rollups from the SQLite day files
  (read-only; WAL lets it read while the collector writes) or the HTTP API.
  The same goes for reports and richer dashboard data.
- **Separate programs never read the UDP stream and never run inside the
  collector's main loop**, so a slow helper can only delay itself. Any
  language is fine for them, unless one needs per-sample data at high
  rates; then it is performance-critical too and must be C++ or Rust.
- Don't add features to the core that weren't asked for.

## Conventions

- C++: follow `docs/cpp-coding-standards.md` (naming matches
  `$HOME/ai/conventions/cpp.md`) and run `make format`. Fallible functions
  return `std::expected` / `std::optional`; exceptions only where that doc
  allows them.
- Each commit must build and pass `make check` on its own.

## Git workflow

- Make every new change, including documentation changes, on a separate
  branch. Never make new changes directly on `master`.
- Use a descriptive branch name that explains the change, for example
  `feat/process-memory-monitoring`, `fix/resource-session-ordering`, or
  `docs/require-descriptive-branches-and-prs`.
- As soon as a change is complete and the required checks pass, commit it,
  push the branch, and open a pull request targeting `master`. Do not wait
  for a separate request to raise the PR.
