// Pinned transition and thread-history boundaries, using the functions the
// old page executed. The browser proof covers request delivery and panels.
import assert from "node:assert/strict";
import { URLSearchParams } from "node:url";
import { createContext, runInContext } from "node:vm";
export async function replayParity({
  oracle,
  load,
  dashboard,
  resolve,
  seriesValue,
}) {
  const obs = load(resolve(dashboard, "src/lib/observation.ts"));
  const frame = (at, session = "live", pid = 9) => ({
    recorded_at: at,
    health: {
      session,
      pid,
      last_seen: at,
      target_absent: false,
      sampler_silent: false,
      sample_interval_ms: 1000,
    },
    threads: [
      {
        tid: pid,
        name: "worker",
        generation: 1,
        last_sample: at,
        state: "running",
        state_mix: { running: 20 },
        cpu_pct: at % 100,
        run_delay_pct: 0,
        switches_per_s: 2,
      },
    ],
  });
  const elements = new Map(),
    storage = new Map();
  const context = createContext({
    URLSearchParams,
    now: 2000,
    live: frame(2000),
    latestLive: null,
    frozen: null,
    replayAt: null,
    selected: null,
    replayRequest: 0,
    replayResources: [],
    savedLiveAnalysis: null,
    liveMapWindow: 0,
    mapWindow: 300,
    settleSince: null,
    buffer: [],
    bufferSession: null,
    lastTick: 0,
    previousThreads: null,
    loadState: null,
    threadCpu: new Map(),
    threadAvg: new Map(),
    threadSeen: new Map(),
    avgSince: 0,
    targetStorageKey: (name) => name,
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    element: (id) => {
      if (!elements.has(id)) elements.set(id, {});
      return elements.get(id);
    },
    setReplayBounds() {},
    replayControls() {},
    renderReplayView() {},
    renderResources() {},
    refreshResources() {},
    closeThread: () => {
      context.selected = null;
    },
    setMapWindow: (value) => {
      context.mapWindow = value;
    },
    LIVE_NOTE: "Live",
    apiFetch: async () => ({ ok: true, json: async () => context.reply }),
    viewNow: () => context.replayAt ?? context.now,
  });
  runInContext(oracle + "\nDate.now=()=>now*1000", context);
  // Use the same established storage normalization as the live parity run.
  // Recorded mode has no displayed load average.
  const checkSeries = (series) =>
    assert.deepEqual(
      seriesValue(series, context.replayAt === null),
      seriesValue(
        runInContext(
          "({session:bufferSession,points:buffer,lastTick,ids:previousThreads,seen:threadSeen,load:loadState,cpu:threadCpu,avg:threadAvg,since:avgSince})",
          context,
        ),
        context.replayAt === null,
      ),
    );
  let state = obs.initialObservations("x"),
    comparisons = 0;
  for (let at = 2000; at < 2100; ++at) {
    const view = frame(at);
    context.live = view;
    context.latestLive = view;
    context.now = at;
    runInContext("ingest()", context);
    state = obs.receiveLive(state, view, at);
  }
  checkSeries(state.live.series);
  comparisons++;
  for (let at = 1000; at > 900; at -= 10) {
    const view = frame(at, "old");
    context.reply = { first: 900, last: 1000, snapshot: view };
    await runInContext(`inspectTime(${at})`, context);
    state = obs.selectRecording(state, view, []);
    assert.doesNotMatch(elements.get("replay-note").textContent, /not defined/);
    checkSeries(obs.displayed(state).series);
    assert.equal(context.mapWindow, 0);
    comparisons++;
  }
  context.latestLive = frame(2100);
  state = obs.receiveLive(state, context.latestLive, 2100);
  await runInContext("returnLive()", context);
  state = obs.returnToLive(state);
  checkSeries(obs.displayed(state).series);
  assert.equal(context.mapWindow, 300);
  comparisons++;
  for (const absent of [false, true])
    for (const hasThreads of [false, true])
      for (const changed of [false, true]) {
        const view = frame(2101, changed ? "new" : "live");
        view.health.target_absent = absent;
        if (!hasThreads) view.threads = [];
        context.next = view;
        context.settleSince = null;
        const exits = runInContext("targetExited(next)", context);
        const waiting = runInContext("settling(next)", context);
        const next = obs.receiveLive(state, view, 2101);
        assert.equal(!!next.final, !!exits);
        if (waiting)
          assert.equal(obs.displayed(next).view.health.session, "live");
        comparisons++;
      }
  // A new live session on return loses the old CPU samples in both pages.
  context.reply = { first: 900, last: 1000, snapshot: frame(1000, "old") };
  await runInContext("inspectTime(1000)", context);
  state = obs.selectRecording(state, frame(1000, "old"), []);
  context.latestLive = frame(2200, "new", 10);
  state = obs.receiveLive(state, context.latestLive, 2200);
  await runInContext("returnLive()", context);
  state = obs.returnToLive(state);
  checkSeries(obs.displayed(state).series);
  comparisons++;
  return { comparisons, liveSteps: 100, recordings: 11 };
}
