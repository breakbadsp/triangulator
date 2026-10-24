import type { LiveResponse } from "../api/types";
import { isNum } from "./format";
import { STATES, isIdle, futexShare } from "./threads";
export interface Point {
  t: number;
  cpu: number | null;
  rd: number | null;
  sw: number | null;
  rb: number | null;
  wb: number | null;
  mf: number | null;
  n: number;
  busy: number | null;
  active: number | null;
  s: Record<string, number>;
  born: number;
  died: number;
  rss: number | null;
  vm: number | null;
  /** The 1-min load average after this point, or null when its rates are unknown. */
  l1?: number | null;
}
/** Damped 1, 5, and 15 min load averages, like /proc/loadavg. */
export interface LoadState {
  t: number;
  averages: [number, number, number];
}
export interface ThreadSeen {
  first: number;
  active: number | null;
  generation?: number;
  futexSince?: number | null;
}
/** One live CPU sample of a thread, for its sparkline and drawer chart. */
export interface CpuSample {
  t: number;
  v: number | null;
}
/** CPU samples of one thread generation, one each 10 s, for the map averages. */
export interface ThreadAverage {
  generation: number | null | undefined;
  samples: readonly (readonly [t: number, cpu: number])[];
}
export interface Series {
  session: string | null | undefined;
  points: readonly Point[];
  lastTick: number;
  ids: ReadonlySet<string> | null;
  seen: ReadonlyMap<number, ThreadSeen>;
  load: LoadState | null;
  /** The last 120 s of each thread's CPU, by TID. */
  cpu: ReadonlyMap<number, readonly CpuSample[]>;
  /** The last 900 s of each thread's CPU, one sample each 10 s, by TID. */
  avg: ReadonlyMap<number, ThreadAverage>;
  /** The first tick with averages in this tab, or 0. */
  since: number;
}
export const emptySeries: Series = {
  session: null,
  points: [],
  lastTick: 0,
  ids: null,
  seen: new Map(),
  load: null,
  cpu: new Map(),
  avg: new Map(),
  since: 0,
};
const BUFFER_SECS = 900,
  CPU_SECS = 120,
  AVG_STEP = 10;
// Load as the kernel defines it, for this process: cores of CPU used, plus
// cores of demand that waited for a CPU, plus threads in uninterruptible wait.
const loadOf = (point: Point) =>
  point.cpu === null
    ? null
    : (point.cpu + (point.rd || 0)) / 100 + (point.s.kernel || 0);
const LOAD_WINDOWS = [60, 300, 900] as const;
// Updated once per point, independently of chart retention and redraws.
function advanceLoad(load: LoadState | null, point: Point): LoadState | null {
  const value = loadOf(point);
  if (value === null) {
    point.l1 = null;
    return load;
  }
  const averages = load
    ? (LOAD_WINDOWS.map((seconds, index) => {
        const decay = Math.exp(-Math.min(point.t - load.t, 30) / seconds);
        return (load.averages[index] ?? 0) * decay + value * (1 - decay);
      }) as LoadState["averages"])
    : ([value, value, value] as LoadState["averages"]);
  point.l1 = averages[0];
  return { averages, t: point.t };
}
const isLoadState = (value: unknown, lastTick: number): value is LoadState =>
  typeof value === "object" &&
  value !== null &&
  "t" in value &&
  isNum(value.t) &&
  value.t <= lastTick &&
  "averages" in value &&
  Array.isArray(value.averages) &&
  value.averages.length === 3 &&
  value.averages.every(isNum);
const savedFor = (saved: unknown, session: Series["session"]) =>
  typeof saved === "object" &&
  saved !== null &&
  "session" in saved &&
  saved.session === session
    ? (saved as Record<string, unknown>)
    : null;
/**
 * The series that a tab saved for this session, from the parsed
 * `triangulator:buffer` and `triangulator:threads` entries. Entries of another
 * session are ignored; an old or invalid load state is seeded from the points.
 */
export function restoreSeries(
  buffer: unknown,
  threads: unknown,
  session: Series["session"],
): Series {
  const savedThreads = savedFor(threads, session),
    savedBuffer = savedFor(buffer, session);
  const seen = new Map<number, ThreadSeen>(
    Array.isArray(savedThreads?.seen)
      ? (savedThreads.seen as [number, ThreadSeen][])
      : [],
  );
  const points = Array.isArray(savedBuffer?.points)
    ? (savedBuffer.points as Point[]).map((point) => ({ ...point }))
    : [];
  const lastTick = points.at(-1)?.t || 0;
  const avg = new Map<number, ThreadAverage>();
  if (Array.isArray(savedThreads?.avg))
    for (const [tid, saved] of savedThreads.avg as [number, unknown[]][]) {
      const samples: (readonly [number, number])[] = [];
      for (let index = 1; index + 1 < saved.length; index += 2)
        samples.push([Number(saved[index]), Number(saved[index + 1])]);
      avg.set(tid, {
        generation: saved[0] as ThreadAverage["generation"],
        samples,
      });
    }
  const since = isNum(savedThreads?.since) ? savedThreads.since : 0;
  let load: LoadState | null = null;
  if (isLoadState(savedBuffer?.loadState, lastTick))
    load = savedBuffer.loadState;
  // Older tabs saved only chart points; seed their averages once on restore.
  else for (const point of points) load = advanceLoad(load, point);
  return {
    session,
    points,
    lastTick,
    ids: null,
    seen,
    load,
    cpu: new Map(),
    avg,
    since,
  };
}
/** The `triangulator:threads` entry of the old page: averages are flat arrays. */
export const threadsEntry = (series: Series) => ({
  session: series.session,
  since: series.since,
  avg: [...series.avg].map(([tid, average]) => [
    tid,
    [average.generation, ...average.samples.flat()],
  ]),
  seen: [...series.seen],
});
export function ingest(series: Series, view: LiveResponse): Series {
  const { health, threads } = view;
  if (health.session !== series.session)
    series = { ...emptySeries, session: health.session };
  let tick = 0;
  for (const thread of threads) tick = Math.max(tick, thread.last_sample || 0);
  if (!threads.length || tick <= series.lastTick) return series;
  const point: Point = {
    t: tick,
    cpu: 0,
    rd: null,
    sw: 0,
    rb: 0,
    wb: 0,
    mf: 0,
    n: threads.length,
    busy: 0,
    active: 0,
    s: {},
    born: 0,
    died: 0,
    rss: null,
    vm: null,
  };
  const ids = new Set<string>(),
    seen = new Map(series.seen),
    cpu = new Map(series.cpu),
    avg = new Map(series.avg);
  for (const thread of threads) {
    if (isNum(thread.cpu_pct)) {
      point.cpu = (point.cpu ?? 0) + thread.cpu_pct;
      if (thread.cpu_pct >= 1) point.busy = (point.busy ?? 0) + 1;
    }
    if (isNum(thread.run_delay_pct))
      point.rd = (point.rd || 0) + thread.run_delay_pct;
    point.sw = (point.sw ?? 0) + (thread.switches_per_s || 0);
    point.rb = (point.rb ?? 0) + (thread.read_bps || 0);
    point.wb = (point.wb ?? 0) + (thread.write_bps || 0);
    point.mf = (point.mf ?? 0) + (thread.major_faults_per_s || 0);
    const state = STATES.find((state) => state === thread.state) ?? "other";
    point.s[state] = (point.s[state] || 0) + 1;
    ids.add(`${String(thread.tid)}:${String(thread.generation)}`);
    const previous = seen.get(thread.tid);
    const observation: ThreadSeen =
      previous && previous.generation === thread.generation
        ? { ...previous }
        : { first: tick, active: null, generation: thread.generation };
    if (
      !thread.stale &&
      thread.state === "futex" &&
      isIdle(thread) &&
      futexShare(thread) === 1
    )
      observation.futexSince ??= tick;
    else observation.futexSince = null;
    if (!isIdle(thread)) {
      point.active = (point.active ?? 0) + 1;
      observation.active = tick;
    }
    seen.set(thread.tid, observation);
    const average = avg.get(thread.tid);
    let samples =
      average && average.generation === thread.generation
        ? average.samples
        : [];
    const last = samples.at(-1);
    if (isNum(thread.cpu_pct) && (!last || tick - last[0] >= AVG_STEP - 0.5)) {
      samples = [...samples, [tick, +thread.cpu_pct.toFixed(2)] as const];
      while (
        samples.length > 1 &&
        (samples[0]?.[0] ?? tick) < tick - BUFFER_SECS
      )
        samples = samples.slice(1);
    }
    avg.set(thread.tid, { generation: thread.generation, samples });
    cpu.set(
      thread.tid,
      [
        ...(cpu.get(thread.tid) ?? []),
        { t: tick, v: thread.cpu_pct ?? null },
      ].filter((sample) => sample.t >= tick - CPU_SECS),
    );
  }
  // Memory samples must belong to the process in this view after a restart.
  const { resources, memory } = view;
  point.rss =
    resources?.available &&
    !resources.stale &&
    resources.session === health.session &&
    resources.pid === health.pid
      ? (resources.memory?.rss ?? null)
      : null;
  point.vm =
    memory?.available && !memory.stale && memory.pid === health.pid
      ? (memory.values?.vm_size_bytes ?? null)
      : null;
  // Missing rates after a sampler pause must leave a gap, not an idle point.
  if (!threads.some((thread) => isNum(thread.cpu_pct)))
    Object.assign(point, {
      cpu: null,
      rd: null,
      sw: null,
      rb: null,
      wb: null,
      mf: null,
      busy: null,
      active: null,
    });
  if (series.ids) {
    for (const id of ids) if (!series.ids.has(id)) point.born++;
    for (const id of series.ids) if (!ids.has(id)) point.died++;
  }
  const present = new Set(threads.map((thread) => thread.tid));
  for (const tid of seen.keys()) if (!present.has(tid)) seen.delete(tid);
  for (const tid of avg.keys()) if (!present.has(tid)) avg.delete(tid);
  // An exited thread keeps its live CPU for 120 s, for its drawer chart.
  for (const [tid, samples] of cpu)
    if (!present.has(tid) && (samples.at(-1)?.t ?? 0) < tick - CPU_SECS)
      cpu.delete(tid);
  const load = advanceLoad(series.load, point);
  return {
    session: health.session,
    points: [...series.points, point].filter(
      (point) => point.t >= tick - BUFFER_SECS,
    ),
    lastTick: tick,
    ids,
    seen,
    load,
    cpu,
    avg,
    since: series.since || tick,
  };
}
/** The points in the chart window, and where the window starts. */
export function windowPoints(series: Series, windowSecs: number) {
  const end = series.points.at(-1)?.t || 0,
    points = series.points.filter((point) => point.t >= end - windowSecs);
  const first = points[0],
    last = points.at(-1);
  return {
    points,
    from: first && last ? Math.max(first.t, last.t - windowSecs) : undefined,
  };
}
