// Called by prove_dashboard.mjs. The embedded page and replay/resource reads
// use the real collector. CDP controls live replies and delayed deliveries.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

export async function proveReplay({
  root,
  profile,
  send,
  evaluate,
  until,
  stop,
  setPaused,
}) {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((done) => probe.close(done));
  const base = `http://127.0.0.1:${port}`;
  const directory = join(profile, "replay-fixture");
  await mkdir(directory);
  const now = Math.floor(Date.now() / 1000),
    first = now - 600,
    last = now - 500;
  function frame(at, session = "200", pid = 42) {
    return {
      recorded_at: at,
      recording_interval_s: 1,
      process: {
        session,
        pid,
        started_at: at - 500,
        command: `process-${session}`,
        executable: "/usr/bin/proof",
      },
      health: {
        session,
        pid,
        last_seen: at,
        target_absent: false,
        sampler_silent: false,
        sample_interval_ms: 1000,
        packet_loss_pct: 0,
        raw_samples: 12,
        bad_packets: 0,
        duplicates: 0,
        late_packets: 0,
      },
      threads: [
        {
          tid: pid,
          generation: 1,
          name: `worker-${session}`,
          group: "workers",
          state: "running",
          state_mix: { running: 20 },
          last_sample: at,
          cpu_pct: session === "200" ? 80 : 25,
          run_delay_pct: 0,
          switches_per_s: 2,
          cpu: 3,
          wake_ms: 500,
        },
      ],
      groups: { workers: 1 },
      resources: {
        available: true,
        session,
        pid,
        updated: at,
        memory: { rss: 8388608, anon: 4194304 },
        fds: { open: 12, soft_limit: 1024 },
        io: { read_bps: 50, write_bps: 10 },
      },
      memory: {
        available: true,
        pid,
        layout_id: `${session}:1`,
        updated: at,
        interval_s: 30,
        values: {
          vm_size_bytes: 16777216,
          vm_data_bytes: 4194304,
          major_faults: 5,
          vma_count: 1,
          max_map_count: 65530,
        },
      },
    };
  }
  const snapshots = [frame(first, "100"), frame(last, "100")];
  const rows = [first - 180, first - 60, first, last, last + 200, now].map(
    (ts, sequence) => ({
      ts,
      session: ts <= last ? "100" : "200",
      sequence,
      pid: 42,
      elapsed_s: 10,
      rss_bytes: ts <= last ? 8388608 : 33554432,
      fd_open: ts <= last ? 12 : 99,
    }),
  );
  const seed = join(directory, "seed.json");
  await writeFile(seed, JSON.stringify({ snapshots, resources: rows }));
  const child = spawn(
    "python3",
    [
      "tests/replay_fixture.py",
      "--http-port",
      String(port),
      "--directory",
      directory,
      "--seed",
      seed,
    ],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics += chunk;
  });
  const cancelledDeliveries = [];
  const log = [],
    overrides = new Map(),
    holds = new Map();
  let current = frame(now),
    lastTarget = null;
  const liveLayout = {
    available: true,
    id: "200:1",
    pid: 42,
    updated: now,
    regions: [
      {
        start: "0x1000",
        end: "0x2000",
        size: 4096,
        vmas: 1,
        kind: "heap",
        permissions: "rw-p",
        name: "[heap]",
      },
    ],
  };
  const values = {
    total: "10000",
    current: 11,
    average: 10,
    minimum: 1,
    maximum: 20,
  };
  const metrics = { input: values, output: values, messages: values };
  const sockets = {
    available: true,
    observer: "proof",
    pid: 42,
    process_start: "77",
    messages_enabled: false,
    stale: false,
    stopped: false,
    losses: "0",
    lower_bound: false,
    duration: 60,
    updated: now,
    gaps: 0,
    truncated: false,
    rate_windows: 6,
    coverage: "full",
    totals: metrics,
    rows: [
      {
        tid: 42,
        name: "worker-200",
        thread_start: "1",
        kind: "tcp",
        kind_id: 1,
        metrics,
      },
    ],
    history: [],
  };
  let watchRevision = "r1",
    watchRules = [{ prefix: "worker-200", wake_ms: 500 }];
  const watchInfo = () => ({
    rules: watchRules,
    source: "config",
    revision: watchRevision,
    saved_error: null,
    limits: {
      prefix_max_bytes: 15,
      wake_ms_min: 1,
      wake_ms_max: 60000,
      max_rules: 64,
    },
  });
  const fulfill = async (requestId, body, responseCode = 200) => {
    try {
      await send("Fetch.fulfillRequest", {
        requestId,
        responseCode,
        responseHeaders: [{ name: "Content-Type", value: "application/json" }],
        body: Buffer.from(JSON.stringify(body)).toString("base64"),
      });
    } catch (cause) {
      if (
        !(cause instanceof Error) ||
        !cause.message.includes("Invalid InterceptionId.")
      )
        throw cause;
      cancelledDeliveries.push({
        requestId,
        responseCode,
        error: cause.message,
      });
    }
  };
  const click = (selector) =>
    evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const text = (id) =>
    evaluate(`document.getElementById(${JSON.stringify(id)})?.textContent`);
  const mode = (expected) =>
    until(
      async () => (await text("target-meta"))?.includes(expected),
      `replay mode ${expected}`,
    );
  const change = (selector, value, event = "change") =>
    evaluate(
      `(() => { const element = document.querySelector(${JSON.stringify(selector)}); const descriptor = Object.getOwnPropertyDescriptor(element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype, 'value'); descriptor.set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event(${JSON.stringify(event)}, {bubbles:true})); })()`,
    );
  const storage = () =>
    evaluate(
      "Object.fromEntries(Object.keys(sessionStorage).sort().map(key=>[key,sessionStorage.getItem(key)]))",
    );
  const facts = () =>
    evaluate(
      `({ name: document.querySelector('#target-name').textContent, meta: document.querySelector('#target-meta').textContent, cpu: document.querySelector('#hero-cpu').textContent, load: document.querySelector('#hero-load').textContent, rss: document.querySelector('#overview-rss').textContent, process: document.querySelector('#process-facts').textContent, health: JSON.parse(document.querySelector('#diagnostics').textContent), assessment: document.querySelector('#findings').textContent, threads: document.querySelector('#threads-live').textContent, resources: document.querySelector('#resources').textContent, memory: document.querySelector('#memory-map').textContent, socketHidden: document.querySelector('#socket-panel').hidden, socket: document.querySelector('#socket-cards')?.textContent, settings: document.querySelector('#collector-settings').textContent, recordedSettings: !!document.querySelector('#watch-recorded-readonly'), mapWindow: document.querySelector('[data-map-window][aria-pressed=true]')?.dataset.mapWindow, drawer: document.querySelector('#drawer').getAttribute('aria-hidden') })`,
    );
  try {
    await until(async () => {
      if (child.exitCode !== null) throw Error(diagnostics);
      try {
        return (await fetch(`${base}/api/replay`)).ok;
      } catch {
        return false;
      }
    }, "seeded replay collector");
    assert.deepEqual(
      Buffer.from(await (await fetch(`${base}/`)).arrayBuffer()),
      await readFile(join(root, "dashboard/dist/index.html")),
    );
    const bounds = await (await fetch(`${base}/api/replay`)).json();
    assert.equal(bounds.first, first);
    assert.equal(bounds.last, last);
    assert.deepEqual(
      (await (await fetch(`${base}/api/replay?at=${last}`)).json()).snapshot,
      snapshots[1],
    );
    const resourceRows = await (
      await fetch(`${base}/api/resources?start=${first - 180}&end=${last}`)
    ).json();
    assert.ok(resourceRows.rows.length >= 4);
    assert.equal(resourceRows.read_error, false);
    setPaused(async ({ requestId, request }) => {
      const url = new URL(request.url);
      log.push({
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        method: request.method,
      });
      const hold = holds.get(url.pathname);
      if (
        hold &&
        (url.pathname !== "/api/watches" || request.method === "POST")
      ) {
        hold.push({ requestId, url, request });
        return;
      }
      if (overrides.has(url.pathname)) {
        const reply = overrides.get(url.pathname);
        await fulfill(requestId, reply.body, reply.status ?? 200);
        return;
      }
      if (url.pathname === "/api/live") return fulfill(requestId, current);
      if (url.pathname === "/api/last-target")
        return fulfill(requestId, lastTarget ?? { available: false });
      if (url.pathname === "/api/memory-map")
        return fulfill(requestId, liveLayout);
      if (url.pathname === "/api/socket-io") return fulfill(requestId, sockets);
      if (url.pathname === "/api/watches") {
        if (request.method === "POST") watchRevision = "r2";
        return fulfill(requestId, watchInfo());
      }
      if (url.pathname === "/api/history")
        return fulfill(requestId, { rows: [], limit: 2000, truncated: false });
      if (url.pathname === "/api/targets")
        return fulfill(requestId, { targets: [] });
      return send("Fetch.continueRequest", { requestId });
    });
    await send("Fetch.enable", {
      patterns: [{ urlPattern: `${base}/api/*`, requestStage: "Request" }],
    });
    const newDocument = await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.proofNow=${now};Date.now=()=>window.proofNow*1000;window.cspViolations=[];addEventListener('securitypolicyviolation',event=>window.cspViolations.push(event.violatedDirective));`,
    });
    await send("Page.navigate", { url: `${base}/?target=` });
    await mode("Live");
    await until(
      async () => (await text("socket-cards"))?.includes("11"),
      "live observer report",
    );
    await until(
      () =>
        evaluate(
          "!!document.querySelector('#memory-amap .amap-row') || document.querySelector('#memory-amap')?.textContent.includes('heap')",
        ),
      "live cached layout",
    );
    await click('[data-map-window="300"]');
    await change("#search", "worker", "input");
    await evaluate("dispatchEvent(new Event('pagehide'))");
    const before = await storage(),
      liveFacts = await facts();
    const lateLive = [];
    holds.set("/api/live", lateLive);
    await until(
      () => lateLive.length > 0,
      "live response pending before replay",
    );
    await click("#replay-previous");
    await mode("Historical");
    const recordedFacts = await facts();
    assert.equal(recordedFacts.name, "worker-100");
    assert.equal(recordedFacts.cpu, "0.25 cores");
    assert.equal(recordedFacts.load, "—");
    assert.equal(recordedFacts.socketHidden, true);
    assert.equal(recordedFacts.mapWindow, "0");
    assert.equal(recordedFacts.recordedSettings, true);
    assert.equal(recordedFacts.health.session, "100");
    assert.match(recordedFacts.process, /up 8 min/);
    assert.match(recordedFacts.memory, /latest layout/);
    assert.equal(
      await evaluate(
        "document.querySelector('#chart-load').closest('[hidden]')!==null && document.querySelector('#chart-states').closest('[hidden]')!==null",
      ),
      true,
    );
    const recordedRequests = log.length;
    current = frame(now + 1);
    holds.delete("/api/live");
    for (const item of lateLive) await fulfill(item.requestId, current);
    await delay(2200);
    for (const path of ["/api/socket-io", "/api/memory-map", "/api/watches"])
      assert.equal(
        log.slice(recordedRequests).some((r) => r.path === path),
        false,
        path,
      );
    await evaluate("dispatchEvent(new Event('pagehide'))");
    const recordedStorage = await storage();
    assert.deepEqual(recordedStorage, before);
    await click("#threads tr[data-tid]");
    await until(
      () =>
        evaluate(
          "document.querySelector('#drawer').getAttribute('aria-hidden')==='false'",
        ),
      "recorded drawer",
    );
    const historyRequest = log.filter((r) => r.path === "/api/history").at(-1);
    assert.equal(historyRequest.query.session, "100");
    assert.equal(Number(historyRequest.query.end), last);
    assert.equal(
      await evaluate(
        "document.querySelector('#drawer-live').closest('[hidden]')!==null",
      ),
      true,
    );
    const localInput = (seconds) => {
      const d = new Date(seconds * 1000);
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 19);
    };
    await change("#from", localInput(last - 100), "input");
    await change("#to", localInput(now + 50), "input");
    await click("#load-history");
    await until(
      () => log.filter((r) => r.path === "/api/history").length >= 2,
      "custom recorded history",
    );
    assert.equal(
      Number(log.filter((r) => r.path === "/api/history").at(-1).query.end),
      last,
    );
    assert.equal(
      await evaluate("document.querySelector('#to').value"),
      localInput(now + 50),
    );
    await click('[data-range="900"]');
    // A recorded readout names the selected time. Keyboard focus stays safe.
    await click("#drawer-close");
    await evaluate(
      "document.querySelector('#mosaic').scrollIntoView({block:'center'})",
    );
    const cell = await evaluate(
      "(() => {const b=document.querySelector('#mosaic .cell').getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2}})()",
    );
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...cell });
    await delay(1350);
    assert.match(
      await evaluate("document.querySelector('.help-card')?.textContent || ''"),
      /Recorded at/,
    );
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
    });
    assert.equal(
      await evaluate(
        "document.querySelector('#drawer').getAttribute('aria-hidden')",
      ),
      "true",
    );
    await click("#replay-live");
    await mode("Live");
    const returnedFacts = await facts();
    assert.equal(returnedFacts.name, "worker-200");
    assert.equal(returnedFacts.mapWindow, "300");
    assert.equal(returnedFacts.drawer, "true");
    assert.equal(
      await evaluate("document.querySelector('#search').value"),
      "worker",
    );
    // The open drawer keeps its selected identity when a PID/TID is reused.
    await click("#threads tr[data-tid]");
    current = frame(now + 1.2, "600", 42);
    current.threads[0].generation = 2;
    await until(
      () =>
        evaluate(
          "JSON.parse(document.querySelector('#diagnostics').textContent).session==='600'",
        ),
      "reused TID session",
    );
    current = frame(now + 1.4, "600", 42);
    current.threads[0].generation = 2;
    await until(
      () =>
        evaluate(
          `JSON.parse(document.querySelector('#diagnostics').textContent).last_seen===${now + 1.4}`,
        ),
      "second reused TID sample",
    );
    assert.match(await text("drawer-state"), /no longer reported/);
    assert.equal(
      await evaluate("document.querySelector('#drawer-live svg')===null"),
      true,
    );
    await click("#drawer-close");
    await click("#threads tr[data-tid]");
    assert.equal(
      await evaluate("document.querySelector('#drawer-live svg')!==null"),
      true,
    );
    await click("#drawer-close");
    current = frame(now + 1.6);
    await until(
      () =>
        evaluate(
          "JSON.parse(document.querySelector('#diagnostics').textContent).session==='200'",
        ),
      "live identity restored after drawer check",
    );
    // Recorded Settings preserves a draft. A sent write can settle only
    // current configuration and cannot change the recorded assessment.
    const prefixSelector =
      '#watch-editor input[aria-label="Thread name prefix, rule 1"]';
    await change(prefixSelector, "changed-", "input");
    await click("#replay-previous");
    await mode("Historical");
    assert.match(
      await text("watch-recorded-readonly"),
      /unsaved edits are kept/,
    );
    await click("#replay-live");
    await mode("Live");
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(prefixSelector)}).value`,
      ),
      "changed-",
    );
    const writes = [];
    holds.set("/api/watches", writes);
    await click("#watch-save");
    await until(() => writes.length > 0, "sent watch write");
    await click("#replay-previous");
    await mode("Historical");
    const historicalAssessment = await text("findings"),
      watchReads = log.filter(
        (r) => r.path === "/api/watches" && r.method === "GET",
      ).length;
    const sentWrite = writes.shift();
    assert.equal(
      JSON.parse(sentWrite.request.postData).rules[0].prefix,
      "changed-",
    );
    watchRevision = "r2";
    watchRules = [{ prefix: "changed-", wake_ms: 500 }];
    holds.delete("/api/watches");
    await fulfill(sentWrite.requestId, watchInfo());
    await delay(200);
    assert.equal(await text("findings"), historicalAssessment);
    assert.equal(
      log.filter((r) => r.path === "/api/watches" && r.method === "GET").length,
      watchReads,
    );
    await click("#replay-live");
    await mode("Live");
    assert.equal(
      await evaluate(
        `document.querySelector(${JSON.stringify(prefixSelector)}).value`,
      ),
      "changed-",
    );
    watchRevision = "r3";
    watchRules = [{ prefix: "worker-200", wake_ms: 500 }];
    await click('a[href="#collector-settings"]');
    await until(
      () =>
        evaluate(
          `document.querySelector(${JSON.stringify(prefixSelector)}).value==='worker-200'`,
        ),
      "restored current watch rules",
    );
    // Preview does not select. A native change selects the first recording.
    const beforePreview = log.filter(
      (r) => r.path === "/api/replay" && r.query.at,
    ).length;
    await change("#timeline-range", String(first), "input");
    assert.match(await text("timeline-cursor"), /Release to view/);
    assert.equal(
      log.filter((r) => r.path === "/api/replay" && r.query.at).length,
      beforePreview,
    );
    await change("#timeline-range", String(first));
    await mode("Historical");
    assert.equal(
      await evaluate("document.querySelector('#replay-previous').disabled"),
      true,
    );
    await click("#replay-next");
    await until(
      async () =>
        (await text("timeline-cursor"))?.includes(
          new Date(last * 1000).getFullYear(),
        ),
      "next recording",
    );
    await click("#replay-live");
    await mode("Live");
    const ahead = now + 60;
    overrides.set("/api/replay", {
      body: {
        first: ahead,
        last: ahead,
        interval_s: 1,
        snapshot: frame(ahead, "700"),
      },
    });
    await click("#replay-previous");
    await mode("Historical");
    assert.equal(await text("target-name"), "worker-700");
    await click("#replay-live");
    await mode("Live");
    overrides.delete("/api/replay");
    // Missing and invalid snapshots keep the selected successful observation.
    await click("#replay-previous");
    await mode("Historical");
    overrides.set("/api/replay", { body: { first, last, snapshot: null } });
    await click("#replay-previous");
    await until(
      async () => (await text("replay-note"))?.includes("No more"),
      "missing recording",
    );
    assert.equal(await text("target-name"), "worker-100");
    overrides.set("/api/replay", {
      body: { first, last, snapshot: { health: {}, threads: [] } },
    });
    await click("#replay-previous");
    await until(
      async () => (await text("replay-note"))?.includes("Invalid recorded"),
      "invalid recording",
    );
    overrides.set("/api/replay", {
      body: { error: "proof read failed" },
      status: 500,
    });
    await click("#replay-previous");
    await until(
      async () => (await text("replay-note"))?.includes("proof read failed"),
      "failed recording",
    );
    overrides.delete("/api/replay");
    await change("#timeline-range", String(last + 200));
    await until(
      async () => (await text("replay-note"))?.includes("recording gap"),
      "recording gap",
    );
    // Replay success and failure after return cannot replace live or its note.
    const lateSnapshots = [];
    holds.set("/api/replay", lateSnapshots);
    await click("#replay-previous");
    await until(() => lateSnapshots.length > 0, "held snapshot");
    await click("#replay-live");
    await mode("Live");
    holds.delete("/api/replay");
    await fulfill(lateSnapshots.shift().requestId, {
      first,
      last,
      snapshot: snapshots[0],
    });
    await delay(100);
    assert.match(await text("replay-note"), /Live view/);
    assert.equal(await text("target-name"), "worker-200");
    // Pending resources/layout/history of the current view do not enter replay.
    const lateResources = [],
      lateLayouts = [],
      lateHistory = [];
    holds.set("/api/resources", lateResources);
    holds.set("/api/memory-map", lateLayouts);
    holds.set("/api/history", lateHistory);
    current = frame(now + 2);
    current.memory.layout_id = "200:2";
    await until(
      () => lateLayouts.length > 0 && lateResources.length > 0,
      "held current resources/layout",
    );
    await click("#threads tr[data-tid]");
    await until(() => lateHistory.length > 0, "held current history");
    // This snapshot has no resource summary, so selecting it does not wait on
    // the deliberately held resource read.
    overrides.set("/api/replay", {
      body: {
        first,
        last,
        snapshot: { ...snapshots[1], resources: { available: false } },
      },
    });
    await click("#replay-previous");
    await mode("Historical");
    holds.delete("/api/resources");
    holds.delete("/api/memory-map");
    holds.delete("/api/history");
    for (const item of lateResources)
      await fulfill(item.requestId, {
        rows: [{ ts: now + 100, pid: 42, rss_bytes: 999999999 }],
        bucket_s: 1,
      });
    for (const item of lateLayouts)
      await fulfill(item.requestId, { ...liveLayout, id: "200:2" });
    for (const item of lateHistory)
      await fulfill(item.requestId, { rows: [], limit: 2000 });
    await delay(150);
    assert.equal(await text("target-name"), "worker-100");
    assert.equal(
      await evaluate(
        "document.querySelector('#drawer').getAttribute('aria-hidden')",
      ),
      "true",
    );
    overrides.delete("/api/replay");
    await click("#replay-live");
    await mode("Live");
    // Empty new-session settling uses a controllable receipt clock.
    current = { ...frame(now + 3, "300", 77), threads: [] };
    await delay(1200);
    assert.equal(await text("target-name"), "worker-200");
    await click("#replay-previous");
    await mode("Historical");
    current = {
      health: {
        session: "300",
        pid: 0,
        last_seen: now + 3,
        target_absent: true,
        sampler_silent: false,
      },
      threads: [],
    };
    await until(
      () => evaluate("document.querySelector('#exited').hidden===false"),
      "exit during replay",
    );
    assert.equal(await text("target-name"), "worker-100");
    current = frame(now + 4, "400", 77);
    await delay(1200);
    await click("#replay-live");
    await mode("Stopped reporting");
    const finalFacts = await facts();
    assert.equal(finalFacts.cpu, "0.80 cores");
    const finalRequestStart = log.length;
    current = frame(now + 4, "400", 77);
    await delay(2200);
    assert.equal(await text("target-name"), "worker-200");
    assert.match(await text("exited-text"), /new process \(PID 77\)/);
    assert.equal(
      log
        .slice(finalRequestStart)
        .some((r) => ["/api/socket-io", "/api/memory-map"].includes(r.path)),
      false,
    );
    // Final settings count the replacement process; the assessment stays final.
    assert.match(await text("watch-editor"), /No live thread name starts/);
    current.exit = {
      pid: 42,
      session: "200",
      name: "worker-200",
      ended_at: now + 3,
      reason: "segfault",
      next_session: "300",
    };
    await until(
      async () => (await text("process-exit"))?.includes("Segmentation fault"),
      "matching late exit",
    );
    current.exit = { ...current.exit, pid: 77, session: "unrelated" };
    await delay(1200);
    assert.match(await text("process-exit"), /Segmentation fault/);
    const retainedStorage = await storage();
    await send("Page.reload");
    await mode("Stopped reporting");
    assert.match(await text("process-exit"), /Segmentation fault/);
    assert.ok((await storage())["triangulator:frozen"]);
    await click("#replay-previous");
    await mode("Historical");
    await click("#replay-live");
    await mode("Stopped reporting");
    // Quota failure keeps the live observation available until dismissal.
    await click("#exited-live");
    await mode("Live");
    await evaluate(
      "window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='triangulator:frozen')throw Error('QuotaExceededError');return window.originalSetItem.call(this,k,v)}",
    );
    current = {
      health: {
        session: "500",
        pid: 0,
        last_seen: now + 5,
        target_absent: true,
        sampler_silent: false,
      },
      threads: [],
    };
    await mode("Stopped reporting");
    await until(
      async () =>
        (await text("exited-text"))?.includes(
          "too large to keep across a reload",
        ),
      "quota warning",
    );
    await evaluate("Storage.prototype.setItem=window.originalSetItem");
    // Fresh tabs retry failed last-target reads, then check/dismiss a session once.
    await evaluate("sessionStorage.clear()");
    lastTarget = snapshots[1];
    current.health.last_target = { session: "100" };
    overrides.set("/api/last-target", { body: {}, status: 500 });
    await send("Page.reload");
    await mode("Target absent");
    await until(
      () => log.some((r) => r.path === "/api/last-target"),
      "last target failure",
    );
    overrides.delete("/api/last-target");
    await mode("Stopped reporting");
    await click("#exited-live");
    await mode("Target absent");
    const checkedReads = log.filter(
      (r) => r.path === "/api/last-target",
    ).length;
    await delay(2200);
    assert.equal(
      log.filter((r) => r.path === "/api/last-target").length,
      checkedReads,
    );
    current = frame(now + 6, "800", 88);
    await mode("Live");
    await until(
      async () => (await text("target-name")) === "worker-800",
      "populated process before settling",
    );
    current = { ...frame(now + 7, "900", 0), threads: [] };
    await delay(1200);
    assert.equal(await text("target-name"), "worker-800");
    await evaluate(`window.proofNow=${now + 20}`);
    await until(
      () =>
        evaluate(
          "JSON.parse(document.querySelector('#diagnostics').textContent).session==='900'",
        ),
      "settling timeout",
    );
    assert.equal(
      await evaluate("document.querySelector('#exited').hidden"),
      true,
    );
    // A real target navigation clears old caches before pagehide and aborts
    // the abandoned recording request. The new page owns different keys.
    overrides.set("/api/targets", {
      body: {
        targets: [
          {
            key: "",
            host: "proof",
            id: "default",
            pid: 0,
            status: "absent",
            process: null,
          },
          {
            key: "proof/new",
            host: "proof",
            id: "new",
            pid: 88,
            status: "live",
            process: null,
          },
        ],
      },
    });
    await until(
      () =>
        evaluate(
          "!!document.querySelector('#target-select option[value=\"proof/new\"]')",
        ),
      "navigation target option",
    );
    const navigationSnapshots = [];
    holds.set("/api/replay", navigationSnapshots);
    await click("#replay-previous");
    await until(
      () => navigationSnapshots.length > 0,
      "navigation snapshot pending",
    );
    current = frame(now + 10, "600", 88);
    await change("#target-select", "proof/new");
    await until(
      () =>
        evaluate(
          "new URLSearchParams(location.search).get('target')==='proof/new' && document.querySelector('#target-name')?.textContent==='worker-600'",
        ),
      "new target document",
    );
    holds.delete("/api/replay");
    for (const item of navigationSnapshots)
      await fulfill(item.requestId, { first, last, snapshot: snapshots[0] });
    await delay(150);
    const afterNavigation = await storage();
    for (const key of [
      "triangulator:buffer",
      "triangulator:threads",
      "triangulator:frozen",
    ])
      assert.equal(afterNavigation[key], undefined, key);
    assert.equal(await text("target-name"), "worker-600");
    await send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: newDocument.identifier,
    });
    assert.deepEqual(await evaluate("window.cspViolations"), []);
    const evidence = {
      base,
      fixture: "real collector SQLite recordings/resources",
      bounds,
      liveFacts,
      recordedFacts,
      returnedFacts,
      finalFacts,
      beforeStorage: before,
      recordedStorage,
      retainedStorage,
      requestLog: log,
      cancelledDeliveries,
      cases: [
        "all panels",
        "custom history cutoff/preset",
        "direct previous/next/bounds/collector clock ahead",
        "input/change",
        "gap/missing/invalid/error",
        "late live/snapshot/resources/layout/history",
        "drawer reused session/generation CPU isolation",
        "no replay storage writes",
        "live analysis return",
        "settings draft/sent write/recorded/final",
        "recorded readout and Escape",
        "settling/absence/restart/exit during replay",
        "matching late exit",
        "final reload/layout",
        "quota",
        "last-target retry/dismissal",
        "target navigation and pagehide",
      ],
    };
    await writeFile(
      "/tmp/pr169-browser-details.json",
      JSON.stringify(evidence, null, 2),
    );
    return {
      base,
      embeddedBytesEqual: true,
      realRecordingRows: snapshots.length,
      realResourceRows: resourceRows.rows.length,
      cases: evidence.cases,
      details: "/tmp/pr169-browser-details.json",
      requests: log.length,
    };
  } finally {
    await send("Fetch.disable");
    setPaused(() => undefined);
    await stop(child);
  }
}
