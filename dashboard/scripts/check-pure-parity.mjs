import assert from "node:assert/strict";
import process from "node:process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { log } from "node:console";
import ts from "typescript";
import { readPinnedOracle } from "./parity-oracle.mjs";

// This fixture works in shallow clones and source archives without Git.
const dashboard = fileURLToPath(new URL("../", import.meta.url));
const { oracle, source } = readPinnedOracle();

// Load the real TypeScript modules without a second build or generated files.
const modules = new Map();
function load(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  let text = readFileSync(filename, "utf8");
  // Deliberately break the average cadence to prove that the oracle detects it.
  if (
    process.argv.includes("--negative-average-step") &&
    filename.endsWith("/series.ts")
  ) {
    assert.ok(text.includes("AVG_STEP = 10"));
    text = text.replace("AVG_STEP = 10", "AVG_STEP = 9");
  }
  if (
    process.argv.includes("--negative-pid-filter") &&
    filename.endsWith("/assess/memory.ts")
  ) {
    const boundary =
      "  if (!view.resources?.available || view.resources.stale) return null;";
    assert.ok(text.includes(boundary));
    text = text.replace(
      boundary,
      "  all = all.filter(point => point.pid === view.health.pid);\n" +
        boundary,
    );
  }
  const { outputText } = ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
    },
    fileName: filename,
  });
  const require = (name) => {
    assert.ok(name.startsWith("."), `Unexpected runtime dependency: ${name}`);
    return load(resolve(dirname(filename), name) + ".ts");
  };
  runInNewContext(outputText, { module, exports: module.exports, require });
  return module.exports;
}
const { assess, assessRecorded, fleetAssessment } = load(
  resolve(dashboard, "src/lib/assess/index.ts"),
);
const { emptySeries, ingest, restoreSeries, threadsEntry } = load(
  resolve(dashboard, "src/lib/series.ts"),
);
const { averageCpu, mapView, idleFor } = load(
  resolve(dashboard, "src/lib/threads.ts"),
);
const { asResourcePoints, rssTrend } = load(
  resolve(dashboard, "src/lib/assess/memory.ts"),
);
const canonical = (value) => JSON.parse(JSON.stringify(value));
let comparisons = 0;
// Intended change (QA-107): the stuck-futex hint reads the collector's
// last_ran, not the tab's futexSince, so it also works without tab history.
// The old page gets the same wait as its futexSince; it gave no hint in a
// recording, so that one finding is not compared there.
const STUCK_HINT = /threads have waited on a futex for over/;
const futexSeen = (input) =>
  new Map(
    input.view.threads
      .filter((thread) => typeof thread.last_ran === "number")
      .map((thread) => [
        thread.tid,
        {
          first: thread.last_ran,
          active: null,
          generation: thread.generation,
          ...input.series.seen.get(thread.tid),
          futexSince: thread.last_ran,
        },
      ]),
  );
function check(input) {
  const oldFindings = JSON.parse(
    runInNewContext(oracle + "\nJSON.stringify(assess(live.threads,buffer))", {
      live: input.view,
      frozen: input.mode.kind === "final" ? {} : null,
      replayAt: input.mode.kind === "recorded" ? input.now : null,
      viewNow: () => input.now,
      frozenExit: () => input.mode.exit,
      buffer: input.series.points,
      lastTick: input.series.lastTick,
      threadSeen: futexSeen(input),
      watchRules: input.watchRules,
      resourceHistory: { rows: input.resourcePoints },
      replayResources: input.resourcePoints,
      memoryLayout: input.memoryLayout,
      memoryHistory: input.memoryHistory,
      pressureScope: input.pressureScope,
    }),
  );
  // The design gives the old untyped healthy finding its monitor type.
  for (const finding of oldFindings) finding.type ??= "monitor";
  const findings = assess(input).filter(
    (item) => input.mode.kind !== "recorded" || !STUCK_HINT.test(item.title),
  );
  assert.deepEqual(
    canonical(findings),
    oldFindings,
    `Assessment parity case ${comparisons}`,
  );
  comparisons++;
}
function view(threads = [], extra = {}) {
  return {
    health: {
      session: "s",
      pid: 7,
      last_seen: 1000,
      sampler_silent: false,
      target_absent: false,
      sample_interval_ms: 200,
    },
    threads,
    ...extra,
  };
}
function input(live, extra = {}) {
  return {
    view: live,
    mode: { kind: "live" },
    now: 1000,
    series: ingest(emptySeries, live),
    watchRules: null,
    resourcePoints: [],
    memoryLayout: null,
    memoryHistory: [],
    pressureScope: "cgroup",
    ...extra,
  };
}
function thread(tid, extra = {}) {
  return {
    tid,
    name: `worker-${tid}`,
    generation: 1,
    last_sample: 1000,
    state: "futex",
    state_mix: { futex: 20 },
    cpu_pct: 0,
    switches_per_s: 0,
    ...extra,
  };
}
function resources(host = 0, cgroup = 0) {
  return {
    available: true,
    pid: 7,
    session: "s",
    updated: 999,
    pressure: {
      host: { memory: { some: { pct: host } } },
      cgroup: { memory: { some: { pct: cgroup } } },
    },
  };
}
// An unavailable RSS row still separates two runs of the same PID.
for (const boundary of [false, true]) {
  const rows = Array.from({ length: 24 }, (_, i) => ({
    ts: 880 + i * 5,
    pid: 7,
    elapsed_s: 5,
    rss_bytes: (100 + 8 * i * 5) * 2 ** 20,
  }));
  if (boundary)
    rows.splice(-1, 0, { ts: 994, pid: 8, elapsed_s: 5, rss_bytes: null });
  const points = asResourcePoints(rows);
  const live = view([], { resources: resources() });
  const expected = runInNewContext(oracle + "\nrssTrend()", {
    live,
    replayAt: 1000,
    replayResources: points,
    viewNow: () => 1000,
  });
  assert.equal(!!expected?.steady, !boundary, "Pinned RSS boundary/control");
  assert.deepEqual(
    canonical(rssTrend(live, points, 1000)),
    canonical(expected),
    "Unavailable RSS PID boundary must end the run",
  );
  check(input(live, { resourcePoints: points }));
  assert.deepEqual(
    canonical(
      assessRecorded(live, 1000, [
        ...points,
        ...asResourcePoints([{ ts: 1100, pid: 8, rss_bytes: null }]),
      ]),
    ),
    canonical(assessRecorded(live, 1000, points)),
    "Future resources cannot alter the recording",
  );
}
log(
  "PASS: RSS growth control and unavailable-row process boundary match the pinned oracle.",
);

const memory = {
  available: true,
  pid: 7,
  layout_id: "s:1",
  values: { vma_count: 950, max_map_count: 1000, stack_limit_bytes: 8 << 20 },
};
const layout = {
  available: true,
  id: "s:1",
  pid: 7,
  regions: [
    {
      start: "0x100000",
      end: "0x400000",
      size: 3 << 20,
      vmas: 1,
      kind: "heap",
      permissions: "rw-p",
      name: "",
    },
    {
      start: "0x700000",
      end: "0xe00000",
      size: 7 << 20,
      vmas: 1,
      kind: "stack",
      permissions: "rw-p",
      name: "",
    },
  ],
};
const exit = {
  pid: 7,
  name: "app",
  next_session: "s",
  ended_at: 990,
  reason: "crashed",
  signal: 6,
  signal_name: "SIGABRT",
};
for (const mode of [
  { kind: "live" },
  { kind: "recorded" },
  { kind: "final", exit },
]) {
  for (const pressureScope of ["host", "cgroup"]) {
    for (let i = 0; i < 120; i++) {
      const threads = Array.from({ length: i % 9 }, (_, index) =>
        thread(index + 1, {
          state: [
            "futex",
            "running",
            "kernel",
            "stopped",
            "no_access",
            "sleep",
          ][i % 6],
          cpu_pct: [0, 99, 1, null][i % 4],
          system_pct: i % 2 ? 80 : null,
          switches_per_s: i % 3 ? 250 : 0,
          major_faults_per_s: i % 5 ? 0 : 80,
          wake_ms: i % 2 ? 500 : null,
          last_ran: i % 3 ? 999.9 : 990,
          run_delay_pct: i % 5 ? 0 : 50,
          stale: i % 13 === 0,
        }),
      );
      const live = view(threads, {
        memory: i % 2 ? memory : undefined,
        resources: {
          ...resources(20, i % 3 ? 0 : 20),
          fds: { open: i * 10, soft_limit: 1024 },
          cgroup_limits: {
            cpu: {
              quota_us: 50000,
              period_us: 100000,
              throttled_pct: i % 7 ? 0 : 30,
            },
          },
        },
      });
      live.health.sampler_silent = i % 17 === 0;
      live.health.target_absent = i % 19 === 0;
      live.health.packet_loss_pct = i % 11 ? 0 : 5;
      live.exit = exit;
      const series = ingest(emptySeries, live);
      const resourcePoints = asResourcePoints(
        Array.from({ length: 13 }, (_, index) => ({
          ts: 880 + index * 10,
          pid: 7,
          elapsed_s: 10,
          rss_bytes: (100 + 8 * index) * 2 ** 20,
        })),
      );
      check(
        input(live, {
          mode,
          pressureScope,
          series: {
            ...series,
            seen: new Map(
              threads.map((thread) => [
                thread.tid,
                { first: 900, active: null, generation: 1 },
              ]),
            ),
          },
          memoryLayout: i % 3 ? layout : null,
          watchRules: [
            { prefix: "worker-", wake_ms: 500 },
            { prefix: "gone-", wake_ms: 200 },
          ],
          resourcePoints,
          memoryHistory: [
            { t: 998, mf: 0 },
            { t: 999, mf: 80 },
          ],
        }),
      );
    }
  }
}
for (const pressureScope of ["host", "cgroup"]) {
  check(
    input(
      view([thread(7, { state: "running", major_faults_per_s: 80 })], {
        resources: resources(20, 0),
        memory: { available: true, pid: 7, values: {} },
      }),
      { pressureScope },
    ),
  );
}
// Replay mode disables old storage and load averages. Compare only the
// reducer state retained by this phase, including generation and pause rules.
const oldState = (extra) => {
  const context = createContext({
    live: view(),
    bufferSession: null,
    buffer: [],
    lastTick: 0,
    previousThreads: null,
    loadState: null,
    threadCpu: new Map(),
    threadSeen: new Map(),
    threadAvg: new Map(),
    avgSince: 0,
    ...extra,
  });
  runInContext(oracle, context);
  return context;
};
const oldSeries = oldState({ replayAt: 1000 });
const seriesValue = (series, withLoad = false) =>
  canonical({
    session: series.session,
    points: withLoad
      ? series.points
      : series.points.map((point) => {
          const copy = { ...point };
          delete copy.l1;
          return copy;
        }),
    lastTick: series.lastTick,
    ids: series.ids ? [...series.ids].sort() : null,
    // futexSince left the series (QA-107); the old page still keeps it.
    seen: [...series.seen].map(([tid, seen]) => {
      const copy = { ...seen };
      delete copy.futexSince;
      return [tid, copy];
    }),
    ...(withLoad ? { load: series.load } : {}),
    cpu: [...series.cpu].map(([tid, samples]) => [
      tid,
      samples.map(({ t, v }) => [t, v ?? null]),
    ]),
    // The old page keeps [generation, t, v, t, v, ...] for each thread.
    avg: [...series.avg].map(([tid, average]) =>
      Array.isArray(average)
        ? [tid, average]
        : [tid, [average.generation, ...average.samples.flat()]],
    ),
    since: series.since,
  });
const oldValue =
  "({session:bufferSession,points:buffer,lastTick,ids:previousThreads,seen:threadSeen,load:loadState,cpu:threadCpu,avg:threadAvg,since:avgSince})";
// The map's averages and idle text read the per-thread history.
const WINDOWS = [0, 60, 300, 900];
function threadReadings(series, live) {
  return canonical(
    live.threads.map((thread) => [
      WINDOWS.map((window) => averageCpu(series, thread.tid, window)),
      WINDOWS.map((window) => mapView(thread, series, window)),
      idleFor(thread, series),
    ]),
  );
}
const oldReadings = (context, live) => {
  context.readingThreads = live.threads;
  context.readingWindows = WINDOWS;
  return canonical(
    runInContext(
      `readingThreads.map(thread=>[readingWindows.map(window=>averageCpu(thread.tid,window)),readingWindows.map(window=>{mapWindow=window;return mapView(thread)}),idleFor(thread)])`,
      context,
    ),
  );
};
let readings = 0;
function seriesView(i) {
  const live = view(
    Array.from({ length: 1 + (i % 7) }, (_, index) =>
      thread(index + 1, {
        // Every 50 steps a 45 s pause tests the 30 s cap of the load step.
        // Odd steps add 4 s, so some samples are exactly 9 s apart.
        last_sample: 1000 + i * 5 + (i % 2) * 4 + Math.floor(i / 50) * 40,
        generation: Math.floor(i / 13),
        state: i % 3 ? "futex" : "sleep",
        cpu_pct: i % 11 ? (index % 2 ? 5 : 0) : null,
      }),
    ),
    {
      resources: {
        ...resources(),
        stale: i % 17 === 0,
        session: i % 19 ? "s" : "old",
        memory: { rss: i * 1024 },
      },
      memory: {
        available: true,
        pid: i % 23 ? 7 : 8,
        values: { vm_size_bytes: i * 2048 },
      },
    },
  );
  live.health.session = i < 220 ? "s" : "next";
  return live;
}
let series = emptySeries;
for (let i = 0; i < 400; i++) {
  const live = seriesView(i);
  const before = seriesValue(series);
  const next = ingest(series, live);
  assert.deepEqual(
    seriesValue(series),
    before,
    `Reducer mutated its input at step ${i}`,
  );
  oldSeries.live = live;
  const previous = runInContext(`ingest(); ${oldValue}`, oldSeries);
  assert.deepEqual(
    seriesValue(next),
    seriesValue(previous),
    `Series parity step ${i}`,
  );
  series = next;
}
// Live mode also runs the load average and the tab storage. Every 40 steps the
// old page reloads from what it saved, and the port restores the same entries.
const stored = new Map();
const oldLive = oldState({
  replayAt: null,
  sessionStorage: {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
  },
  targetStorageKey: (key) => `${key}:h/t`,
});
let restores = 0;
series = emptySeries;
for (let i = 0; i < 400; i++) {
  const live = seriesView(i);
  if (i % 40 === 39) {
    runInContext("saveBuffer()", oldLive);
    // futexSince left the series (QA-107); compare the rest of the entry.
    const entry = (text) =>
      JSON.stringify(text, (key, value) =>
        key === "futexSince" ? undefined : value,
      );
    assert.equal(
      entry(threadsEntry(series)),
      entry(JSON.parse(stored.get("triangulator:threads:h/t") ?? "null")),
      `Saved threads entry parity step ${i}`,
    );
    runInContext("loadBuffer(bufferSession)", oldLive);
    const parse = (key) => JSON.parse(stored.get(`${key}:h/t`) ?? "null");
    series = restoreSeries(
      parse("triangulator:buffer"),
      parse("triangulator:threads"),
      series.session,
    );
    assert.deepEqual(
      seriesValue(series, true),
      seriesValue(runInContext(oldValue, oldLive), true),
      `Restore parity step ${i}`,
    );
    restores++;
  }
  oldLive.live = live;
  series = ingest(series, live);
  assert.deepEqual(
    seriesValue(series, true),
    seriesValue(runInContext(`ingest(); ${oldValue}`, oldLive), true),
    `Live series parity step ${i}`,
  );
  assert.deepEqual(
    threadReadings(series, live),
    oldReadings(oldLive, live),
    `Thread readings parity step ${i}`,
  );
  readings++;
}
// Repeated calls must not retain the prior target, mode, rules, or series.
const busy = view([thread(7, { cpu_pct: 99 })]);
const before = canonical(assessRecorded(busy, 1000, []));
assess(input(view([], { memory }), { memoryLayout: layout }));
assert.deepEqual(canonical(assessRecorded(busy, 1000, [])), before);
assert.equal(fleetAssessment(busy, 1000).level, "serious");
// Exercise the pinned renderers through a small DOM sink. Read their displayed
// values, rather than copying their calculation into a second oracle.
const {
  resourceTiles,
  socketNotes,
  fullestSockets,
  socketCells,
  networkRows,
  resourceCoverage,
} = load(resolve(dashboard, "src/lib/resourceView.ts"));
function sink(text = "") {
  return {
    textContent: text,
    children: [],
    value: "",
    dataset: {},
    style: {},
    hidden: false,
    classList: { add() {}, toggle() {} },
    append(...nodes) {
      this.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    setAttribute() {},
    get firstChild() {
      return this.children[0];
    },
  };
}
let viewComparisons = 0;
for (let index = 0; index < 80; index++) {
  const resource = {
    available: true,
    pressure: { host: { cpu: { some: { pct: index } } } },
    sockets: {
      tcp: { rx_queue: index, tx_queue: 0 },
      udp: { rx_queue: 0, tx_queue: index % 3 ? 0 : null },
      unix: { rx_queue: 0, tx_queue: 0 },
    },
    network: { listen_drops: { per_s: index / 3 } },
    memory: { rss: index * 1024 },
  };
  const sockets = [
    {
      kind: "tcp4",
      state: index % 2 ? "ESTAB" : "SYN-SENT",
      listener: false,
      rx_queue: index,
      tx_queue: index,
      tcp: { peer_window: 0, rwnd_limited_pct: 30, probes: index % 3 },
    },
  ];
  const points = asResourcePoints([
    {
      ts: 1,
      pid: 2,
      elapsed_s: 2,
      rss_bytes: 3,
      rx_queue_bytes: index,
      tx_queue_bytes: null,
      listen_drops_delta: index,
    },
  ]);
  const elements = new Map();
  const context = {
    pressureScope: "cgroup",
    socketMetric: "input",
    element: (id) => {
      if (!elements.has(id)) elements.set(id, sink());
      return elements.get(id);
    },
    node: (tag, text) => sink(text),
    helpButtonLabel: (text) => sink(text),
    sparkline: (values) => ({ values }),
    topicForText: () => "pressure",
    helpOwns: () => false,
    observeHelp() {},
  };
  runInNewContext(oracle + "\nrenderResourceTiles(r,points)", {
    ...context,
    r: resource,
    points,
  });
  const expected = elements
    .get("resource-tiles")
    .children.map((tile) => [
      ...tile.children.slice(0, 3).map((c) => c.textContent),
      tile.children[3].values,
    ]);
  assert.deepEqual(
    canonical(resourceTiles(resource, points, "cgroup")),
    canonical(expected),
  );
  for (const item of sockets)
    assert.deepEqual(
      canonical(socketNotes(item)),
      canonical(runInNewContext(oracle + "\nsocketNotes(item)", { item })),
    );
  viewComparisons += 2;
}
// The text a sink shows, including its children, as a browser would.
const text = (item) =>
  (item.textContent ?? "") + (item.children ?? []).map(text).join("");
const socketSamples = [
  { fd: 3, kind: "tcp4", state: "LISTEN", listener: true, local: "0.0.0.0:80" },
  { fd: 4, kind: "unix_stream", state: "ESTAB", listener: false, path: "" },
  {
    fd: 5,
    kind: "tcp6",
    state: "CLOSE-WAIT",
    listener: false,
    remote: "[::1]:9",
  },
  {
    fd: 6,
    kind: "udp4",
    state: "UNCONN",
    listener: false,
    local: "0.0.0.0:53",
  },
];
for (let index = 0; index < 60; index++) {
  const top = socketSamples.map((base, at) => ({
    ...base,
    inode: 100 + at,
    local: base.local ?? "127.0.0.1:" + String(at),
    rx_queue: (index + at) % 3 ? 0 : index * 10,
    tx_queue: (index + at) % 4 ? 0 : index,
    rx_fill_pct: index % 5 ? null : index,
    tx_fill_pct: index % 7 ? 0 : 95,
    accept_fill_pct: index % 2 ? 125 : null,
    rcvbuf: index % 3 ? 65536 : undefined,
    rmem_alloc: 4096,
    sndbuf: 32768,
    wmem_queued: index,
    wmem_alloc: 7,
    drops: index % 6 ? undefined : index,
    drops_delta: index % 4 ? 0 : 2,
    tcp: base.kind.startsWith("tcp")
      ? { retrans: index, retrans_delta: index % 3, rtt_ms: index / 7 }
      : undefined,
  }));
  const resource = {
    available: true,
    sequence: index,
    interval_s: 1 + index * 97,
    cgroup: index % 2 ? "/system.slice/app.service" : null,
    sockets: {
      top,
      matched: index % 5 ? index : null,
      unmatched: index % 3,
      complete: index % 4 !== 0,
    },
    flags: {
      other_network_namespace: index % 5 === 1,
      descriptors_hidden: index % 7 === 2,
      socket_diag_failed: index % 3 === 0,
      descriptor_scan_truncated: index % 4 === 3,
      sockets_truncated: index % 2 === 0,
    },
    network: {
      listen_drops: { delta: index % 3, per_s: index / 9, total: index * 3 },
      listen_overflows: { delta: 0, per_s: 0, total: 0 },
      tcp_req_q_full_drop: { delta: 0, per_s: null, total: index % 2 },
      if_rx_dropped: { delta: index % 2, per_s: 12.5, total: 99 },
      tcp_timeouts: { delta: 0, per_s: 0, total: 0 },
    },
  };
  const points = asResourcePoints(
    index % 3
      ? [
          { ts: 1, pid: 2, elapsed_s: 1, tcp_timeouts_delta: index % 2 },
          { ts: 2, pid: 2, elapsed_s: 1, listen_drops_delta: null },
        ]
      : [],
  );
  for (const busyOnly of [true, false]) {
    const elements = new Map();
    const element = (id) => {
      if (!elements.has(id)) elements.set(id, sink());
      return elements.get(id);
    };
    element("sockets-busy-only").checked = busyOnly;
    const context = {
      element,
      node: (tag, value) => sink(value),
      addHelp() {},
      topicForText: () => "netdrops",
      helpOwns: () => false,
      observeHelp() {},
    };
    runInNewContext(oracle + "\nrenderResourceSockets(r)", {
      ...context,
      r: resource,
    });
    const view = fullestSockets(resource, busyOnly);
    assert.equal(view.count, element("resource-socket-count").textContent);
    // The label and notes cells hold one element per part; others are text.
    const rendered = element("resource-sockets").children.map((row) =>
      view.rows.length
        ? row.children.map((cell, column) =>
            column === 0 || column === 9 ? cell.children.map(text) : text(cell),
          )
        : row.children.map(text),
    );
    const shown = (cell) =>
      cell === null ? "—" : typeof cell === "string" ? cell : cell.text;
    assert.deepEqual(
      canonical(
        view.rows.length
          ? view.rows.map((item) => {
              const c = socketCells(item);
              return [
                [c.label, ...(item.listener ? ["listener"] : [])],
                c.peer,
                c.recvQ,
                shown(c.receiveBuffer),
                c.sendQ,
                shown(c.sendBuffer),
                c.drops,
                c.rtt,
                c.retrans,
                c.notes.map((note) => note[0]),
              ];
            })
          : [[view.empty]],
      ),
      canonical(rendered),
    );
    assert.equal(
      resourceCoverage(resource),
      element("resource-coverage").textContent,
    );
    viewComparisons += 3;
  }
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, sink());
    return elements.get(id);
  };
  runInNewContext(oracle + "\nrenderNetstack(r,points)", {
    element,
    node: (tag, value) => sink(value),
    addHelp() {},
    topicForText: () => "netdrops",
    helpOwns: () => false,
    observeHelp() {},
    r: resource,
    points,
  });
  const network = networkRows(resource, points);
  assert.deepEqual(
    canonical([
      ...network.rows.map((row) => [
        row.label + row.meaning,
        row.now,
        row.inRange,
        row.total,
      ]),
      ...(network.zero ? [[network.zero]] : []),
    ]),
    canonical(
      element("netstack").children.map((row) => row.children.map(text)),
    ),
  );
  viewComparisons++;
}
const { memoryParity } = await import("./memory-parity.mjs");
const memoryRun = await memoryParity({ oracle, load, dashboard, resolve });
log(
  `PASS: ${memoryRun.steps} old/new memory map steps with ${memoryRun.layoutsFetched} layout fetches; ${memoryRun.values} displayed-value comparisons; ${memoryRun.historicalChecks} compatible historical layout checks.`,
);
log(
  `PASS: ${viewComparisons} old/new resource displayed-value and note comparisons.`,
);
log(
  `PASS: ${comparisons} old/new assessment comparisons, including D1; 400 series steps in replay mode; 400 live steps with the load average, per-thread CPU, ${readings} thread map readings, and ${restores} restores; repeated calls are isolated.`,
);

const { replayParity } = await import("./replay-parity.mjs");
const replayRun = await replayParity({
  oracle,
  load,
  dashboard,
  resolve,
  seriesValue,
});
log(
  `PASS: ${replayRun.comparisons} old/new replay and final transitions, ${replayRun.liveSteps} live steps and ${replayRun.recordings} recording selections.`,
);

// Past assessments: episodes and checked times over seeded random samples.
const past = load(resolve(dashboard, "src/lib/pastAssessments.ts"));
let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = (values) => values[Math.floor(random() * values.length)];
let pastComparisons = 0;
for (let run = 0; run < 300; run++) {
  const samples = [];
  for (let at = 1000; at < 1000 + 40 * 7.5; at += 7.5) {
    if (random() < 0.1) {
      samples.push(null);
      continue;
    }
    const findings = [];
    for (let i = Math.floor(random() * 5); i > 0; i--) {
      const tid = random() < 0.6 ? pick([1, 2, 3]) : undefined;
      findings.push({
        type: pick(["threads", "memory", "monitor", "watched", "resources"]),
        level: pick(["critical", "serious", "warning", "info", "good"]),
        title: pick([
          "%d threads in kernel wait",
          "w-%d is saturating a core",
          "Packet loss %d.%d%",
        ]).replace(/%d/g, () => String(Math.floor(random() * 30))),
        detail: "",
        action:
          tid === undefined
            ? undefined
            : { tid, session: pick(["a", "b"]), generation: pick([1, 2]) },
      });
    }
    samples.push({ at, findings });
  }
  const oldEpisodes = JSON.parse(
    runInNewContext(
      oracle + `\nJSON.stringify(historyEpisodes(${JSON.stringify(samples)}))`,
      {},
    ),
  );
  const newEpisodes = canonical(past.episodes(samples));
  for (const episode of newEpisodes) {
    assert.equal(episode.id, `${episode.key}@${String(episode.first)}`);
    delete episode.id;
  }
  assert.deepEqual(newEpisodes, oldEpisodes, `Past episode parity case ${run}`);
  const start = Math.floor(random() * 1000),
    step = 0.5 + random() * 20,
    count = Math.floor(random() * 121);
  const end = start + random() * 3000;
  assert.deepEqual(
    canonical(past.slotTimes(start, end, step, count)),
    JSON.parse(
      runInNewContext(
        oracle +
          `\nJSON.stringify(slotTimes(${start},${end},${step},${count}))`,
        {},
      ),
    ),
  );
  pastComparisons += 2;
}
log(
  `PASS: ${pastComparisons} old/new past-assessment episode and slot comparisons.`,
);

// Intended change (QA-107): long futex waits now run on recordings.
const STUCK_HELP = [
  "(thread growth, thread churn, long futex waits) and the watch rule with no thread do not run.",
  "(thread growth, thread churn) and the watch rule with no thread do not run. Long futex waits use the collector's last-ran time in each recording.",
];
// The history explanations retain the pinned text. Automatic label aliases
// are retired; internal callers use type-checked topic IDs.
const topics = load(resolve(dashboard, "src/help/topics.ts")).helpTopics;
for (const id of ["assesshistory", "historyfilters"]) {
  const call = source.statements.find(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      statement.expression.expression.getText(source) === "helpTopic" &&
      statement.expression.arguments[0]?.text === id,
  );
  assert.ok(call, `Pinned help topic ${id}`);
  const fields = [
    "id",
    "title",
    "scope",
    "meaning",
    "example",
    "reading",
    "limits",
    "related",
  ];
  const values = runInNewContext(
    `let values; function helpTopic(...args) { values = args; } ${call.getText(source)}; values`,
  );
  for (let i = 1; i < fields.length; i++)
    assert.deepEqual(
      canonical(topics[id][fields[i]]),
      canonical(
        fields[i] === "related"
          ? values[i].map((value) => (value === "replay" ? "timeline" : value))
          : fields[i] === "limits"
            ? values[i].replace(STUCK_HELP[0], STUCK_HELP[1])
            : values[i],
      ),
      `Help ${id}.${fields[i]}`,
    );
}
log(
  "PASS: assesshistory and historyfilters text matches the pinned page word for word, except the stated QA-107 change.",
);
