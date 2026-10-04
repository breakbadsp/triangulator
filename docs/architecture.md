# Architecture at a glance

Triangulator has three parts: a **sampler** reads Linux thread data, a
**collector** turns it into metrics and alerts, and a **dashboard** displays it
in the browser. The diagrams follow the default Python collector started by
`scripts/start.sh`. Ports and timings shown below are defaults.

## End-to-end flow

```mermaid
flowchart LR
    subgraph target_host["Target host · Linux"]
        target["Target process<br/>Its threads expose /proc data"]
        sampler["Sampler · C++<br/>Read raw counters and thread state"]
        target -->|"Read-only /proc"| sampler
    end

    subgraph collector_host["Collector host"]
        collector["Collector · Python<br/>Metrics, wait types and alerts"]
        db[("Daily SQLite files<br/>History and alert events")]
        http["HTTP server · :9401<br/>Dashboard and JSON API"]
        collector -->|"Rollups and events"| db
        collector -->|"Live snapshot"| http
        db -->|"History queries"| http
    end

    sampler -->|"UDP :9400 · raw samples"| collector
    http <-->|"HTTP"| browser["Browser dashboard<br/>Live view, history and settings"]
    collector -->|"Background delivery"| notify["Webhook / email<br/>Opened, reminder, resolved"]

    classDef source fill:#eff6ff,stroke:#2563eb,color:#172554
    classDef compute fill:#ecfdf5,stroke:#059669,color:#064e3b
    classDef store fill:#fffbeb,stroke:#d97706,color:#78350f
    classDef view fill:#f5f3ff,stroke:#7c3aed,color:#3b0764
    class target,sampler source
    class collector compute
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
    sleep["Wait for the next deadline<br/>Skip missed deadlines after an overrun"]

    config -.->|"Startup / valid SIGHUP reload"| tick
    tick --> lookup
    lookup -->|"Yes"| read
    lookup -->|"No / ambiguous name"| absent
    read --> pack
    pack --> send
    absent --> send
    send --> sleep
    sleep --> tick

    classDef source fill:#eff6ff,stroke:#2563eb,color:#172554
    classDef compute fill:#ecfdf5,stroke:#059669,color:#064e3b
    classDef control fill:#fffbeb,stroke:#d97706,color:#78350f
    class config,read source
    class pack,absent,send compute
    class tick,lookup,sleep control
```

The sampler reports facts, not CPU percentages or alert decisions. A new session
starts on sampler startup, a valid config reload, or a target identity change
(PID + start time). If target lookup fails because of a resource error, the tick
is skipped. A missing target heartbeat means **sampler alive, target absent**;
no packets means **sampler silence**. Optional `status` reads replace scheduler
counters when `status_fallback` is enabled.

## Collector: raw samples to useful signals

```mermaid
flowchart TD
    udp["UDP receiver<br/>Check sender and decode packet"]
    merge["Assemble ticks by session + sequence<br/>Deduplicate and reorder chunks<br/>Process partial ticks after a bounded wait"]
    process["Update per-thread state<br/>Group by name prefix · classify wait channel<br/>Compute counter deltas using monotonic time"]
    live["Bounded in-memory samples<br/>Up to 10 minutes<br/>Latest state + 10-second metrics"]
    rollup["Per-thread rollups<br/>Default 5-second windows"]
    alerts["Alert engine<br/>Sustained CPU / starvation / kernel wait<br/>Silence / absence / loss / access health"]
    snapshot["Publish JSON snapshot<br/>Every 0.5 seconds<br/>Threads, groups, alerts and health"]
    db[("SQLite · one file per UTC day<br/>Rollups + alert events<br/>Optional raw records")]
    delivery["Bounded delivery queue<br/>Separate worker with retries"]
    channels["Configured webhook / SMTP"]

    udp --> merge --> process
    process --> live --> snapshot
    process --> rollup --> db
    process --> alerts
    udp -.->|"Last seen and packet health"| alerts
    alerts -->|"Open and recent alerts"| snapshot
    alerts -->|"Every alert event"| db
    alerts -->|"Best-effort notifications"| delivery --> channels

    classDef source fill:#eff6ff,stroke:#2563eb,color:#172554
    classDef compute fill:#ecfdf5,stroke:#059669,color:#064e3b
    classDef store fill:#fffbeb,stroke:#d97706,color:#78350f
    classDef view fill:#f5f3ff,stroke:#7c3aed,color:#3b0764
    class udp source
    class merge,process,rollup,alerts compute
    class live,db,delivery,channels store
    class snapshot view
```

The main loop owns monitor state and applies settings changes. A separate HTTP
thread serves snapshots and history; a delivery worker sends notifications so
network retries do not block sampling ingestion. New sessions or regressing
counters reset baselines. Missing chunks do not imply thread exits. Ordinary
socket, futex and poll waits are shown as wait types; they do not trigger alerts.

## Dashboard: live view, history and settings

```mermaid
flowchart LR
    subgraph browser["Browser · dashboard.html"]
        live_ui["Live view<br/>Health, groups, threads and alerts<br/>Filter and sort locally"]
        history_ui["Thread history<br/>Select thread + time range"]
        settings_ui["Alert settings<br/>Enable rules, tune thresholds, reset"]
    end

    subgraph server["Collector · HTTP :9401"]
        live_api["GET /api/live<br/>Poll about once a second"]
        history_api["GET /api/history<br/>Session + TID + start/end"]
        settings_api["GET /api/alert-settings<br/>POST /api/alert-settings"]
        snapshot["Published live snapshot<br/>No database query for live reads"]
        db[("Daily SQLite rollups")]
        main["Main loop<br/>Validate, persist and apply settings"]
        saved[("alert-settings.json<br/>Overrides collector.toml alert defaults")]
    end

    live_ui <-->|"JSON"| live_api
    snapshot --> live_api
    history_ui <-->|"JSON rollups"| history_api
    db --> history_api
    settings_ui <-->|"Read / save / reset"| settings_api
    settings_api -->|"Queue writes"| main
    main --> saved

    classDef compute fill:#ecfdf5,stroke:#059669,color:#064e3b
    classDef store fill:#fffbeb,stroke:#d97706,color:#78350f
    classDef view fill:#f5f3ff,stroke:#7c3aed,color:#3b0764
    class main compute
    class db,saved store
    class live_ui,history_ui,settings_ui,live_api,history_api,settings_api,snapshot view
```

The collector serves the page at `/`; the browser receives JSON from the same
HTTP server. History comes from stored rollups (at most 2,000 per request), not
the live sample buffer. Settings changes affect the collector's alert engine
immediately and survive restart; sampler settings stay in `sampler.toml`.

For setup, see the [README](../README.md). For protocol details, alert rules and
operational constraints, see the [full design](thread-monitor-design.md).
