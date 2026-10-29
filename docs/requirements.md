# Requirements and pending work

This file is the one list of requirements and unresolved work. The
[TODO](../TODO.md) file is an index of the open IDs. Measurement
constraints: [limits](measurement-limits.md).

Each item has a permanent ID, `REQ-NNNN`. Give a new item the next free
number, and add it to the TODO index. When an item is done or no longer
needed, remove it from this file and from the TODO index. Never reuse or
renumber an ID; gaps are expected.

Status values: `Open` (ready for work), `Owner decision` (decide first,
then give the item to one agent), `Accepted` (design agreed, not built).

## Incident analysis

### REQ-0001: Agent access to incident history

Status: Accepted (design agreed, implementation pending). Priority: Highest.

#### Need

A production incident support team uses AI agents to find incidents, find
their root cause, find workarounds, and explain incidents. The agents must
answer these questions from the collected data:

- Was there an issue on a given day? What was it?
- Is something wrong now? What is the possible cause?
- When did it start? Is it still active? Is it getting worse?
- Which target, process, or thread is affected? Which other targets are affected?
- Is the cause in the application or in the host (for example, a noisy
  neighbour or pressure on the whole host)?
- Which resource is involved: CPU, scheduler, memory, I/O, or network?
- Did a process crash, restart, or get killed by OOM?
- What changed compared with the last good period?
- Did this happen before?
- Is the data complete enough for the answer?

#### Decisions

- Agents read history and a short summary of current state. They do not
  read the live stream: an agent step takes seconds, and raw ticks cost
  many tokens for little information.
- Incidents are found once, by a program, and stored as episodes. Agents do
  not find incidents again from raw metrics on each question. That would be
  slow, would cost many tokens, and could give different answers each time.
- The collector and its SQLite day files do not change. All new parts are
  separate programs that read the day files or the HTTP API, as
  `AGENTS.md` requires.
- No columnar database now. The questions need episodes, not faster scans.
  The collector appends small rows with autocommit, and columnar formats are
  slow for that. DuckDB also adds a dependency and allows only one writer.
  If analysis over many days becomes slow, use DuckDB to read the SQLite day
  files directly, or a nightly Parquet export by a separate program.
- Deploys, configuration changes, and application logs stay outside
  Triangulator. The agent combines the Triangulator tools with other tools
  for that data.

#### Scope

1. **Episode detector.** A separate program reads the day files and writes
   episodes: start, end, target, kind, severity, top contributing threads,
   comparison with a baseline, and references to the raw rows. Kinds include
   CPU saturation, run-queue delay, memory pressure or major faults, I/O
   stall, PSI pressure, process exit or OOM, thread stall, and socket
   backlog. Decide whether the alerting program is this detector, so that
   one rule set serves both alerts and agents.
2. **Agent tools.** One read-only program, for example an MCP server, with:
   - `list_targets`, `list_sessions`
   - `episodes(window)`, `episode_detail(id)`
   - `current_status()`: open episodes, and recent minutes compared with a
     baseline
   - `correlate(episode)`: first signal to move, contributing threads,
     exits, PSI, and changes compared with the last good period
   - `compare(window_a, window_b)`, `top_threads(metric, window, n)`
   - `timeseries(target, thread, metric, window, step)`, downsampled in the
     tool
   - read-only SQL with a row limit, and a schema glossary
3. **Runbook.** For each episode kind: likely causes and workarounds.
4. **Long-term tier.** Episodes and 1-minute rollups kept longer than the
   7-day raw retention, for recurrence and trend questions.

#### Acceptance criteria

- An agent answers "was there an issue on day X, and what was it?" with
  one episode query, without reading raw rows.
- Tools hide day-file sharding, rows with `valid = 0`, `generation`, and
  TID reuse. A thread identity is never mixed across sessions.
- Every tool result has a size limit.
- Every answer states data completeness: gaps, invalid samples, and sampler
  throttling in the window.
- The collector receive path and the sampler have no new work.

#### Design (PR #202)

- **Questions come from the user's LLM client.** The user asks Claude Code
  or Codex. The client calls read-only MCP tools. Triangulator holds no API
  key, calls no LLM, and has no chat in the dashboard.
- **One optional program, `tri-scout`.** `tri` is short for triage or
  triangulation. It is TypeScript on the newest Node LTS (24 or later), in
  `dashboard/src/scout/`. It imports the dashboard incident rules in
  `dashboard/src/lib/assess`, so the dashboard and the agent give the same
  verdicts. `make scout` builds one file, `build/tri-scout.mjs`, with no
  runtime `node_modules`. It has two modes:
  - `tri-scout scan`: a long-running process on the collector host. It reads
    every recording in the day files in read-only mode, applies the rules,
    and stores incidents in `data/scout/incidents.sqlite3`. It checks every
    recording, not the Timeline sample of at most 120 recordings per period,
    so it does not miss a short incident.
  - `tri-scout serve`: the MCP server, on stdio. The client starts it, on the
    collector host or through `ssh`. Register it as `tri`, for example
    `claude mcp add tri -- node /opt/triangulator/tri-scout.mjs serve`.
- **Tools:** `list_targets`, `status_now`, `list_incidents`, `get_incident`,
  `timeseries`, `top_threads`, and `compare`. Each result has a size limit
  and states data completeness.
- **Optional deploy.** `make all`, `make release`, and the sampler and
  collector packages do not contain `tri-scout`. It is a separate release
  file. `scripts/start.sh` starts `tri-scout scan` only when the file is
  present and the switch is on, and says nothing when the file is absent.
- **Switch.** `[scout] enabled` in `collector.toml`, `false` by default. When
  it is off, both modes exit with status 2 at start. `serve` reads it again
  on each tool call and `scan` on each pass. The collector ignores the table.
- **Safety.** No collector, sampler, `common/`, or day-file format changes.
  `serve` sends only GET requests that the dashboard already sends. The
  day files use WAL, so a reader does not block the collector writer.
- **Delivery:** (1) switch, `list_targets`, `status_now`; (2) `scan` and the
  incident store; (3) `list_incidents`, `get_incident`; (4) `timeseries`,
  `top_threads`, `compare`, and the release file.
- **Not in this series:** `list_sessions`, `correlate`, read-only SQL, the
  runbook, and the long-term tier.

## Target configuration

### REQ-0024: Local target configuration and discovery

Status: Implemented. Source identifier: REQ-TARGET-001 in PR194.

The requirement and acceptance criteria are in
[Local configuration and discovery](multi-target-design.md#req-0024-local-configuration-and-discovery).
