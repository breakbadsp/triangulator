# Triangulator

## Architecture

- Use C++ or Rust for performance-critical code: the sampler, core collector,
  storage, and dashboard API. See `docs/collector-comparison.md` for evidence.
- Keep alerting, reports, and richer dashboard data in separate programs.
  Read SQLite day files in read-only mode or use the HTTP API. Helpers must
  not read the UDP stream or run in the collector's main loop.
- A helper that processes samples at high rates must also use C++ or Rust.
- Add only requested features to the core.

## C++ and validation

- Follow `docs/cpp-coding-standards.md` and the global C++ conventions.
  Run `make format` after C++ changes.
- Each commit must build and pass `make check`.

## Git workflow

- Create a new worktree and a descriptive branch for every change, including
  documentation. Do not edit `master` or the primary checkout directly.
- After required checks pass, commit, push, and open a PR to `master`.
- After the PR is confirmed merged, remove its worktree from another checkout
  with `git worktree remove`. Preserve uncommitted and untracked work first.
  Never force removal or remove the primary checkout.
