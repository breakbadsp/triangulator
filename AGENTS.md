# Triangulator agent instructions

## Communication

Use [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/)
for all written communication. Preserve exact technical identifiers and quotations.

## Architecture

- Use C++ or Rust for performance-critical code: the sampler, core collector
  (`collector/`), storage, dashboard API, and helpers that process samples at
  high rates.
- Keep alerts, alert settings and delivery, reports, and extended dashboard
  data in separate programs. Read rollups through read-only SQLite day files
  or the HTTP API. Never read the UDP stream or run in the collector main loop.
  Other languages are permitted for these programs unless performance-critical.
- Add core features only when requested.

## C++ and validation

- Before C++ changes or review, read `docs/cpp-coding-standards.md` and
  `$HOME/ai/conventions/cpp.md`. Run `make format` after C++ changes.
- Each commit must build and pass `make check`.

## Git workflow

1. Create a new worktree and a descriptive branch for each change, including
   documentation. Never edit in the primary checkout or on `master`.
2. When the change is complete and checks pass, commit, push, and open a pull
   request against `master` without a separate request.
3. After confirmed merge, preserve uncommitted and untracked work. Remove the
   worktree with `git worktree remove` from another checkout. Never force removal
   or remove the primary checkout.
