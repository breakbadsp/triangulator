# Architecture at a glance

Triangulator has three parts: a **sampler** reads Linux thread data, a
**collector** turns it into metrics and history, and a **dashboard** displays it
in the browser. Both programs are C++; `scripts/start.sh` starts them. Alerting
will be a separate module (`alerting/`, not wired up yet), shown dashed below.
Ports and timings shown below are defaults.

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
and runs as the target's user. UDP carries samples in one direction; all
interpretation, persistence and dashboard requests happen on the collector host.

## Sampler: one tick at a time

```mermaid
flowchart TD
    config["sampler.toml<br/>Target, rate and collector address"]
    tick["Wake on a monotonic deadline<br/>Default 1 Hz · configurable 0.2–10 Hz"]
    lookup{"Target found?<br/>PID or exact process name"}
    read["Rescan threads and read /proc<br/>stat · schedstat · io · wchan"]
    pack["Encode raw cumulative counters<br/>Session + tick + timestamps<br/>Up to 10 threads per datagram"]
    absent["Encode header-only heartbeat<br/>target_absent flag"]
    send["Non-blocking UDP send<br/>No disk buffering or retransmission"]
    resources["Every resource_interval_s (5 s)<br/>PSI · fds · io · sock_diag queues<br/>namespace drop counters"]
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

The main loop owns monitor state. A separate HTTP thread serves snapshots and
history, so dashboard requests never delay receiving datagrams. New sessions or
regressing counters reset baselines. Missing chunks do not imply thread exits.
Socket, futex and poll waits are shown as wait types. The collector evaluates no
alert rules.

## Dashboard: live view and history

```mermaid
flowchart LR
    subgraph browser["Browser · dashboard.html"]
        live_ui["Live view<br/>Health, groups and threads<br/>Filter and sort locally"]
        history_ui["Thread history<br/>Select thread + time range"]
    end

    subgraph server["Collector · HTTP :9401"]
        live_api["GET /api/live<br/>Poll about once a second"]
        history_api["GET /api/history<br/>Session + TID + start/end"]
        snapshot["Published live snapshot<br/>No database query for live reads"]
        db[("Daily SQLite rollups")]
    end

    live_ui <-->|"JSON"| live_api
    snapshot --> live_api
    history_ui <-->|"JSON rollups"| history_api
    db --> history_api

    classDef store fill:#fffbeb,stroke:#d97706,color:#78350f
    classDef view fill:#f5f3ff,stroke:#7c3aed,color:#3b0764
    class db store
    class live_ui,history_ui,live_api,history_api,snapshot view
```

The collector serves the page at `/`; the browser receives JSON from the same
HTTP server. History comes from stored rollups (at most 2,000 per request), not
the live sample buffer. The page also contains alert sections and an alert
settings form; it hides them because `/api/live` has no alert fields.

For setup, see the [README](../README.md); for the future alerting module, see
[alerting/README.md](../alerting/README.md). For protocol details, alert rules and
operational constraints, see the [full design](thread-monitor-design.md).
