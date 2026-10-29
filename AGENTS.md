# Triangulator agent instructions

## Architecture

- Use C++ or Rust for performance-critical code: the sampler, core collector
  (`collector/`), storage, dashboard API, and helpers that process samples at
  high rates.
- Keep alerts, alert settings and delivery, reports, and extended dashboard
  data in separate programs. Read rollups through read-only SQLite day files
  or the HTTP API. Never read the UDP stream or run in the collector main loop.
  Other languages are permitted for these programs unless performance-critical.
- Add core features only when requested.

## Sampler constraints

The sampler runs on the target host, so its overhead must stay negligible.
Every sampler change must keep these rules. A change that cannot keep them
needs the owner's explicit approval first.

- Run exactly one sampler process on each host. It monitors every target on
  that host. Never add a sampler per target. The optional eBPF
  `socket_sampler/` is the one existing second process: it is opt-in, and
  whether it stays is an open owner decision (REQ-0013 in `docs/requirements.md`).
- Keep the sampler single-threaded: one loop on a monotonic deadline. Add no
  threads, thread pools, or async runtimes.
- Keep it lean: after startup or reload, the steady-state tick path does no
  allocation and no disk or network I/O that can block. Use only
  rate-limited warnings, non-blocking UDP, and no disk writes. Ship a static
  binary with no runtime dependencies. New code must follow this. The
  existing exceptions, pending owner review, are the `/dev/kmsg` read for exit
  reports (at most 50 ms) and the netlink `sock_diag` socket dump, which waits
  up to 1 s per `recv` and has no total time budget (only a cap of 1,000,000
  sockets).
- Need no privileges: read only the `/proc` files the sampler's user can
  read. No sudo, capabilities, or ptrace. The existing `/dev/kmsg` read is
  best effort and may need `CAP_SYSLOG` when `dmesg_restrict=1`. A target of
  another user is covered only at limited fidelity (no `io` or wait
  channels), as the design describes.
- Do the interpretation on the collector. The sampler reads raw counters and
  sends them. It computes no rates, rules, or alerts. The approved
  exception is the overhead throttle on the sampler's own CPU use. Its
  default budget is 1% of one CPU core.
- Bound the cost of each tick. Share work across targets, such as one `/proc`
  scan per tick, and spread heavy scans (resources, memory maps) so that one
  tick runs at most one of them.
- Measure sampler overhead for each change that can affect it, and report
  the result in the pull request.

See [Multi-target design](docs/multi-target-design.md).

## C++ and validation

- Before C++ changes or review, read `$HOME/ai/skills/cpp-principles/SKILL.md`
  and `docs/cpp-coding-standards.md`. Then read the `cpp-*` topic skills for
  the current step, using the C++ topic router in `$HOME/ai/AGENTS.md`. Read
  `cpp-checklist` before completion and before C++ review.
- The `cpp-*` skills come from the
  [ai-assets](https://github.com/breakbadsp/ai-assets) repository. It must be
  cloned to `~/ai` and installed with its `install.sh`. If
  `~/ai/skills/cpp-principles/SKILL.md` is missing, stop and tell the user
  before you make C++ changes. Do not skip the C++ rules without saying so.
- For C++ changes, run `make format` and `make format-check`. Keep the default
  warning flags and `-Werror` enabled.
- Each commit must build and pass `make check`.

## Frontend skills

Read these project-local skills when the requested work needs them:

- `.agents/skills/typescript-best-practices/SKILL.md`: reading or editing TypeScript and TSX.
- `.agents/skills/architect/SKILL.md`: substantial frontend design or redesign.
- `.agents/skills/visual-parity/SKILL.md`: preserving the interface during migration.

These skills are manual-only. Repository rules govern checks and delivery.

## Dashboard help

- Every user-visible dashboard section, card, chart, label, column, legend, and
  disclosure needs a contextual help topic in the same change. Follow
  [Help for new dashboard features](docs/contextual-help-design.md#help-for-new-dashboard-features).

## Documentation

- Do not write docs for what the code shows. Write them only for what code
  cannot show: why x was chosen over y, constraints, and how to operate or
  verify the system. Prefer a clear name or a short code comment to a doc
  page. Keep docs short, and remove a doc when the code makes it redundant.
- Dashboard help topics and manual QA cases are product and test material.
  They stay required.

## Manual QA

- When adding a user-visible feature, add or update its cases in
  `docs/qa/test-cases.md`. Leave unexecuted cases as `NOT_RUN`.
- For requested package or browser QA, use
  [Senior Manual QA](docs/manual-qa.md).

## Git workflow

1. Create a new worktree and a descriptive branch for each change, including
   documentation. Never edit in the primary checkout or on `master`.
2. When the change is complete and checks pass, commit, push, and open a pull
   request against `master` without a separate request. In Claude Code, start
   a change with `/loomflow <task>`, or run `/loomflow <PR>` on an open PR
   (`.claude/commands/loomflow.md`; tool-neutral definition in
   [LoomFlow](docs/loomflow.md)). For a task, it sizes and builds the change
   first. It reviews the PR, merges only when no `blocker` or `major` issue is
   open, and reports anything still open for manual handling. A run never
   starts itself again, and agents that `/loomflow` starts never run it. Other
   agents, such as Codex, stop after they open the PR and report its URL.
3. After confirmed merge, preserve uncommitted and untracked work. Remove the
   worktree with `git worktree remove` from another checkout. Never force removal
   or remove the primary checkout.

## Review triage

- Check command for the merge gate: `make check`. Formatter: `make format`.
- Sensitive paths, which always get the full review: `sampler/`,
  `socket_sampler/`, `collector/`, `common/`, `Makefile`, `deploy/`,
  `.github/`, `.claude/`, `AGENTS.md`, and `docs/loomflow.md`.
