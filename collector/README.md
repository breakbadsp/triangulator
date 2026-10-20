# Collector

Receive sampler data. Build thread summaries. Store history and serve the dashboard.

<p align="center">
  <img src="../docs/assets/collector-flow.svg" alt="Sampler data arrives over UDP. The collector builds thread state and summaries, writes SQLite day files, and serves the dashboard over HTTP." width="100%">
</p>

## Quick start

1. Run from the repository root:

   ```sh
   scripts/start.sh
   ```

2. Open <http://127.0.0.1:9401>.

The script builds and starts both programs with local configuration files.

## Run separately

Use an existing local configuration:

```sh
make build/triangulator-collector
build/triangulator-collector ~/triangulator/config/collector.toml --check-config
scripts/start.sh collector
```

[Configuration example](../config/collector.toml) ·
[Collector reference](../docs/collector-reference.md) ·
[Sampler](../sampler/README.md) ·
[Performance](../docs/collector-comparison.md)

[Dashboard HTTP server animation](../docs/dashboard-http-animation.html) shows
the HTTP listener and workers, embedded page, live snapshots, and SQLite
history requests.
Download the HTML file and open it in a browser. It needs no build or network.

## Multiple viewers

Live views share one collector and one monitored target. Changing the target
affects all viewers. Each browser view keeps
its own filters, selected recording, and live chart buffer.

The HTTP listener runs up to 64 connection workers. A slow connection does not
hold up other workers. A complete request must arrive within 5 seconds, including
headers and body. Sending a response has a separate 5-second total deadline.
The listener backlog is 128. Additional connections receive HTTP 503 when all
worker slots are in use. These are connection limits, not a supported user count.
Sample ingestion stays in the main loop, separate from HTTP requests.

Watched-thread settings are shared. `GET /api/watches` includes an opaque
`revision`. Send that value in quotes as the `If-Match` header for every
`POST /api/watches` or `POST /api/watches/reset`. A successful response includes
the rules and revision from that change. A stale revision returns HTTP 409
without changing the rules. A missing header returns HTTP 428. A collector
restart invalidates earlier revisions. Reload old dashboard pages after an
upgrade before changing settings.

The dashboard keeps unsaved edits after a conflict. Select **Reload current
rules** to review the saved list. It asks before discarding an edited draft.
Cancel or a failed read keeps the draft. Copy any edits you need before reloading.

## Dashboard layout

**Summary** starts with Assessment, then key measurements, process load, and
memory use. Assessment shows up to eight findings, most severe first. Select
**Show … more findings** to read the rest.

The section links are **Summary**, **Threads**, **Resources**, **Sockets**,
**Memory**, **Monitor**, and **Settings**. Open **Timeline** below the Summary
charts for recordings and **Past assessments**. Settings currently edits only
[watched-thread rules](../docs/collector-reference.md#watched-threads).

Use **Theme** in the header to select **System**, **Light**, or **Dark**.
Theme and panel open/closed choices are saved in the browser. See the
[dashboard guide](../docs/setup.md#dashboard) for panel behavior and replay limits.

## Dashboard help

Pause over a metric, table cell, or chart point for 1.2 seconds to see its
explanation. Move into the card to read it, or press Escape to close it.
Select an information button for examples, measurement limits, related topics,
and a chart data table where available. Keyboard users can focus the information
button; touch users can tap it. **How to read this page** contains the page guide.

Each metric help card includes a **Source** line. The detailed guide includes a
**Source** section with its Linux file and counter, collector calculation, API,
or browser calculation. Where applicable, it gives a command to check the source.

The guide includes **Show help on hover or focus**. This preference is saved in
the browser. Turning it off keeps explicit guide access available.
