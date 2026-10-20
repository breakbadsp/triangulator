# Architecture at a glance

Triangulator has three parts: a **sampler** reads Linux thread data, a
**collector** turns it into metrics and history, and a **dashboard** displays it
in the browser. Both programs are C++; `scripts/start.sh` starts them. Alerting
is a separate module (`alerting/`, not connected), shown dashed below.
Ports and timings shown below are defaults.

The current sampler and collector handle one target process at a time.
Run one ordinary sampler on each target host. Monitoring several targets from
that sampler is [proposed](multi-target-design.md).

## End-to-end flow

```mermaid
flowchart LR
    subgraph target_host["Target host · Linux"]
        target["Target process<br/>Its threads expose /proc data"]
        sampler["Sampler · C++<br/>Read raw counters and thread state"]
        target -->|"Read-only /proc"| sampler
    end

    subgraph collector_host["Collector host"]
        collector["Collector · C++<br/>Metrics, wait types and rollups"]
        db[("Daily SQLite files<br/>Per-thread rollups")]
        http["HTTP server · :9401<br/>Dashboard and JSON API"]
        collector -->|"Rollups"| db
        collector -->|"Live snapshot"| http
        db -->|"History queries"| http
    end

    sampler -->|"UDP :9400 · raw samples"| collector
    http <-->|"HTTP"| browser["Browser dashboard<br/>Live view and history"]
    db -.->|"Read-only"| alerting["Alerting module · not wired up<br/>Rules, delivery"]
    alerting -.-> notify["Webhook / email<br/>Opened, reminder, resolved"]

    classDef source fill:#eff6ff,stroke:#2563eb,color:#172554
    classDef compute fill:#ecfdf5,stroke:#059669,color:#064e3b
    classDef store fill:#fffbeb,stroke:#d97706,color:#78350f
    classDef view fill:#f5f3ff,stroke:#7c3aed,color:#3b0764
    class target,sampler source
    class collector,alerting compute
    class db,notify store
    class http,browser view
```

The two hosts can be the same machine. The sampler needs no application changes
and runs as the target's user. UDP carries samples in one direction. The
collector computes rates, stores history, and serves the dashboard. The browser
computes process load and Assessment findings from the API data.

## Sampler: one tick at a time

```mermaid
flowchart TD
    config["sampler.toml<br/>Target, rate and collector address"]
    tick["Wake on a monotonic deadline<br/>Default 5 Hz · configurable 0.2–10 Hz"]
    lookup{"Target found?<br/>PID or exact process name"}
    read["Rescan threads and read /proc<br/>stat · schedstat · io · wchan"]
    pack["Encode raw cumulative counters<br/>Session + tick + timestamps<br/>Up to 10 threads per datagram"]
    absent["Encode header-only heartbeat<br/>target_absent flag"]
    send["Non-blocking UDP send<br/>No disk buffering or retransmission"]
    resources["Every resource_interval_s (2 s)<br/>PSI · fds · io · sock_diag queues<br/>namespace drop counters"]
    sleep["Wait for the next deadline<br/>Skip missed deadlines after an overrun"]

    config -.->|"Startup / valid SIGHUP reload"| tick
    tick --> lookup
    lookup -->|"Yes"| read
    lookup -->|"No / ambiguous name"| absent
    read --> pack
    pack --> send
    read -.->|"Slower"| resources --> send
    absent --> send
    send --> sleep
    sleep --> tick

    classDef source fill:#eff6ff,stroke:#2563eb,color:#172554
    classDef compute fill:#ecfdf5,stroke:#059669,color:#064e3b
    classDef control fill:#fffbeb,stroke:#d97706,color:#78350f
    class config,read source
    class pack,absent,send,resources compute
    class tick,lookup,sleep control
```

The sampler reports facts, not CPU percentages or alert decisions. A new session
starts on sampler startup, a valid config reload, or a target identity change
(PID + start time). If target lookup fails because of a resource error, the tick
is skipped. A missing target heartbeat means **sampler alive, target absent**;
no packets means **sampler silence**. Optional `status` reads replace scheduler
counters when `status_fallback` is enabled. Every `resource_interval_s` seconds
the sampler also sends a resource sample in its own `TRES` format: pressure
stalls for the host and the target's cgroup, descriptors, storage I/O, the
target's socket queues and buffers (sock_diag) and its network namespace's
counters. See [resource-monitoring.md](resource-monitoring.md).
Memory-map samples run every `memory_interval_s` seconds (default 30 s).
Both intervals are limited by the thread sampling frequency.
Process metadata is sent when the target is first observed, and exit reports
provide the available evidence when it ends. See
[memory-map.md](memory-map.md) and [process-exit.md](process-exit.md).

## Collector: raw samples to useful signals

```mermaid
flowchart TD
    udp["UDP receiver<br/>Check sender and decode packet"]
    merge["Assemble ticks by session + sequence<br/>Deduplicate and reorder chunks<br/>Process partial ticks after a bounded wait"]
    process["Update per-thread state<br/>Group by name prefix · classify wait channel<br/>Compute counter deltas using monotonic time"]
    live["Bounded in-memory samples<br/>Up to 10 minutes<br/>Latest state + 10-second metrics"]
    rollup["Per-thread rollups<br/>Default 5-second windows"]
    health["Monitor health<br/>Sampler silence, target absence<br/>Packet loss over the last minute"]
    snapshot["Publish JSON snapshot<br/>Every 0.5 seconds<br/>Threads, groups and health"]
    db[("SQLite · one file per UTC day<br/>Rollups<br/>Optional raw records")]

    udp --> merge --> process
    process --> live --> snapshot
    process --> rollup --> db
    udp -.->|"TRES resource samples"| resource["Resource samples<br/>Reassemble parts · rates per interval"]
    resource --> snapshot
    resource --> db
    udp -.->|"Last seen and packet counts"| health --> snapshot

    classDef source fill:#eff6ff,stroke:#2563eb,color:#172554
    classDef compute fill:#ecfdf5,stroke:#059669,color:#064e3b
    classDef store fill:#fffbeb,stroke:#d97706,color:#78350f
    classDef view fill:#f5f3ff,stroke:#7c3aed,color:#3b0764
    class udp source
    class merge,process,rollup,health,resource compute
    class live,db store
    class snapshot view
```

The main loop owns monitor state. A separate HTTP listener starts bounded
connection workers for snapshots and history. Slow clients have total read and
write deadlines and do not delay other workers or receiving datagrams.
Watch-rule changes check the editor's revision under the update lock so one
operator cannot silently replace another's changes. New sessions or regressing
counters reset baselines. Missing chunks do not imply thread exits.
Socket, futex and poll waits are shown as wait types. The collector evaluates no
alert rules.

## Dashboard: live view and history

```mermaid
flowchart LR
    subgraph browser["Browser · dashboard.html"]
        live_ui["Live view<br/>Summary, resources and threads<br/>Filter and sort locally"]
        history_ui["Thread history<br/>Select thread + time range"]
        replay_ui["Timeline + past assessments<br/>Inspect recorded views<br/>Assess selected recordings in browser"]
    end

    subgraph server["Collector · HTTP :9401"]
        live_api["GET /api/live<br/>Poll about once a second"]
        history_api["GET /api/history<br/>Session + TID + start/end"]
        replay_api["GET /api/replay<br/>Bounds, timestamp or previous/next"]
        snapshot["Published live snapshot<br/>No database query for live reads"]
        db[("Daily SQLite rollups")]
        replay_db[("Separate daily replay files<br/>Recorded API views")]
    end

    live_ui <-->|"JSON"| live_api
    snapshot --> live_api
    history_ui <-->|"JSON rollups"| history_api
    db --> history_api
    replay_ui <-->|"Recorded JSON"| replay_api
    replay_db --> replay_api

    classDef store fill:#fffbeb,stroke:#d97706,color:#78350f
    classDef view fill:#f5f3ff,stroke:#7c3aed,color:#3b0764
    class db,replay_db store
    class live_ui,history_ui,replay_ui,live_api,history_api,replay_api,snapshot view
```

The collector serves the page at `/`; the browser receives JSON from the same
HTTP server. History comes from stored rollups (at most 2,000 per request), not
the live sample buffer. The page also contains alert sections and an alert
settings form; it hides them because `/api/live` has no alert fields.

Summary starts with Assessment, then key measurements, process load, and memory
use. The browser computes load and Assessment from API data. Assessment is
separate from alert delivery. Timeline sits below the summary charts; it opens
recordings of the whole dashboard. Past assessments applies the same rules to
selected recordings in the browser. It does not store findings and can miss
problems between checked recordings.

The collector records its published API view on a separate thread every second
by default. Replay uses those recordings; thread history uses rollups.
The Settings section edits shared watched-thread rules through `/api/watches`.
Other collector settings stay in `collector.toml`. See
[the collector reference](collector-reference.md) for storage, API, and settings
details.

For setup, see the [README](../README.md); for the future alerting module, see
[alerting/README.md](../alerting/README.md). For protocol details, alert rules and
operational constraints, see the [full design](thread-monitor-design.md).
