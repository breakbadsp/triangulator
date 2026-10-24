import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { log } from "node:console";
import ts from "typescript";

// Run from any directory. The pinned page is the oracle for this migration.
const dashboard = fileURLToPath(new URL("../", import.meta.url));
const html = execFileSync("git", ["show", "777cf3a:collector/dashboard.html"], {
  cwd: dashboard,
  encoding: "utf8",
});
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "The pinned page must have its inline script");
const source = ts.createSourceFile(
  "old.js",
  script,
  ts.ScriptTarget.Latest,
  true,
);
const names = new Set(
  `
  BUFFER_SECS AVG_STEP loadBuffer saveBuffer ingest loadOf updateLoadAverage
  STATES labels isNum pct compact number bytes perSec clock date duration ago family
  isIdle idleSecs futexShare STUCK_FUTEX_S lockHints SATURATED_PCT watchOverdueS
  sampleIntervalMs isWatched quietFor quietText isOverdue isBusyWatched watchedThreads
  watchRuleFor watchRulesOutdated andMore stuckFinding busyFinding unmatchedRules watchFindings
  threadLabel threadGrowth KERNEL_SHARE_MIN SPIN_SWITCHES_MIN kernelShare LEVEL_ORDER
  LEVEL_ICONS VERDICTS ofType assess PRESSURE_SERIES hasCgroup scopeOf stall socketName
  MOVES_DATA movesData peerWindowZero assessResources asResourcePoints resourcePoints
  memoryBytes memoryLayoutFor memoryComm isLibrary baseName memoryRegions MEMORY_GAP
  MEMORY_ROWS memoryRows memorySlope RSS_TREND_WINDOWS RSS_TREND_MIN_SPAN
  RSS_TREND_MIN_POINTS rssTrend signed assessMemory memoryOverviewFindings memoryFaultRate
  memoryPressure endedTarget EXIT_REASONS CRASH_SIGNALS KILL_SIGNALS signalLabel
  exitReason exitStatusText viewTargetName fleetName
`
    .trim()
    .split(/\s+/),
);
const declarations = [];
for (const statement of source.statements) {
  if (
    ts.isFunctionDeclaration(statement) &&
    names.delete(statement.name?.text)
  ) {
    declarations.push(statement.getText(source));
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        names.delete(declaration.name.text)
      ) {
        declarations.push(`const ${declaration.getText(source)};`);
      }
    }
  }
}
assert.deepEqual([...names], [], "Every oracle declaration must exist");
const oracle = declarations.join("\n");

// Load the real TypeScript modules without a second build or generated files.
const modules = new Map();
function load(filename) {
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const { outputText } = ts.transpileModule(readFileSync(filename, "utf8"), {
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
const { emptySeries, ingest, restoreSeries } = load(
  resolve(dashboard, "src/lib/series.ts"),
);
const { asResourcePoints } = load(
  resolve(dashboard, "src/lib/assess/memory.ts"),
);
const canonical = (value) => JSON.parse(JSON.stringify(value));
let comparisons = 0;
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
      threadSeen: input.series.seen,
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
  assert.deepEqual(
    canonical(assess(input)),
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
                { first: 900, active: null, futexSince: 900, generation: 1 },
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
    seen: [...series.seen],
    ...(withLoad ? { load: series.load } : {}),
  });
const oldValue =
  "({session:bufferSession,points:buffer,lastTick,ids:previousThreads,seen:threadSeen,load:loadState})";
function seriesView(i) {
  const live = view(
    Array.from({ length: 1 + (i % 7) }, (_, index) =>
      thread(index + 1, {
        // Every 50 steps a 45 s pause tests the 30 s cap of the load step.
        last_sample: 1000 + i * 5 + Math.floor(i / 50) * 40,
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
    runInContext("saveBuffer(); loadBuffer(bufferSession)", oldLive);
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
}
// Repeated calls must not retain the prior target, mode, rules, or series.
const busy = view([thread(7, { cpu_pct: 99 })]);
const before = canonical(assessRecorded(busy, 1000, []));
assess(input(view([], { memory }), { memoryLayout: layout }));
assert.deepEqual(canonical(assessRecorded(busy, 1000, [])), before);
assert.equal(fleetAssessment(busy, 1000).level, "serious");
log(
  `PASS: ${comparisons} old/new assessment comparisons, including D1; 400 series steps in replay mode; 400 live steps with the load average and ${restores} restores; repeated calls are isolated.`,
);
