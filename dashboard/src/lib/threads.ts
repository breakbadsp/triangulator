import type { Thread } from "../api/types";
import { niceMax } from "./chart";
import { duration, isNum, num, pct } from "./format";
import type { Series } from "./series";
export const STATES = [
  "running",
  "futex",
  "poll",
  "socket",
  "pipe",
  "sleep",
  "stopped",
  "kernel",
  "other",
  "no_access",
] as const;
export const stateLabels: Readonly<Record<string, string>> = {
  running: "Running",
  futex: "Futex wait",
  poll: "Poll / epoll",
  socket: "Socket wait",
  pipe: "Pipe / eventfd",
  sleep: "Sleep",
  stopped: "Stopped",
  kernel: "Kernel wait (D)",
  other: "Other",
  no_access: "No access",
};
export const family = (name: string) =>
  (name || "?").replace(/[\s#:_.-]*\d+$/, "") || name;
export const isIdle = (thread: Thread) =>
  !(
    (thread.cpu_pct ?? 0) > 0 ||
    (thread.switches_per_s ?? 0) > 0 ||
    (thread.read_bps ?? 0) > 0 ||
    (thread.write_bps ?? 0) > 0 ||
    (thread.major_faults_per_s ?? 0) > 0 ||
    thread.state === "running" ||
    (thread.state_mix || {}).running ||
    thread.state === "kernel" ||
    thread.state === "stopped"
  );
export const futexShare = (thread: Thread) => {
  const mix = Object.values(thread.state_mix || {}),
    total = mix.reduce((sum, count) => sum + count, 0);
  return total ? ((thread.state_mix || {}).futex || 0) / total : 0;
};
const KERNEL_SHARE_MIN = 0.5,
  SPIN_SWITCHES_MIN = 100;
export function kernelShare(thread: Thread) {
  if (
    !(isNum(thread.cpu_pct) && thread.cpu_pct > 0) ||
    !(isNum(thread.system_pct) && thread.system_pct >= 0)
  )
    return null;
  const share = Math.min(1, thread.system_pct / thread.cpu_pct);
  return share >= KERNEL_SHARE_MIN &&
    (thread.switches_per_s || 0) >= SPIN_SWITCHES_MIN
    ? share
    : null;
}
export const threadLabel = (thread: Thread) =>
  `${thread.name} (${String(thread.tid)})`;

// ---------- Thread panels ----------
// Pure item builders for the Threads section, ported from 777cf3a
// (renderWchans, renderFamilies, renderCores, renderMosaic, renderThreads).

export const stateColor = (state: string | null | undefined) =>
  `var(--s-${STATES.some((known) => known === state) ? String(state) : "other"})`;
const knownState = (state: string | undefined) =>
  STATES.find((known) => known === state) ?? "other";

/** A row of a help readout. */
export interface TipRow {
  color: string;
  value: string;
  label: string;
}
export interface BarItem {
  /** The filter value; null or "" for the combined "N others" row. */
  key: string | null;
  label: string;
  value: number;
  color?: string;
  sub?: string;
  tip: readonly TipRow[];
}

/** Waiting threads by wait channel; at most 10 rows. */
export function wchanItems(threads: readonly Thread[]): BarItem[] {
  const counts = new Map<string, { value: number; state: string | null }>();
  for (const thread of threads) {
    if (thread.state === "running") continue;
    const key = thread.wchan || "—",
      entry = counts.get(key) ?? { value: 0, state: thread.state ?? null };
    entry.value++;
    if (entry.state !== thread.state) entry.state = null;
    counts.set(key, entry);
  }
  let items: { key: string | null; value: number; state: string | null }[] = [
    ...counts,
  ]
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => b.value - a.value);
  if (items.length > 10) {
    const rest = items.slice(9);
    items = items.slice(0, 9);
    items.push({
      key: null,
      value: rest.reduce((sum, item) => sum + item.value, 0),
      state: null,
    });
    // The label of the combined row names how many channels it holds.
    return withTips(items, rest.length);
  }
  return withTips(items, 0);
}
function withTips(
  items: readonly { key: string | null; value: number; state: string | null }[],
  others: number,
): BarItem[] {
  return items.map((item) => {
    const color = stateColor(item.state);
    return {
      key: item.key,
      label: item.key ?? `${String(others)} others`,
      value: item.value,
      color,
      tip: [
        {
          color,
          value: String(item.value),
          label:
            (item.value === 1
              ? "thread waiting here"
              : "threads waiting here") +
            " · " +
            (item.key === null
              ? "Combined channels"
              : (item.state && stateLabels[item.state]) || "Multiple states"),
        },
      ],
    };
  });
}

export type FamilyMode = "family" | "group" | "thread";
/** Process CPU by name family, config group, or thread; at most 10 rows. */
export function familyItems(
  threads: readonly Thread[],
  mode: FamilyMode,
): BarItem[] {
  const keyOf =
    mode === "group"
      ? (thread: Thread) => thread.group ?? ""
      : mode === "thread"
        ? threadLabel
        : (thread: Thread) => family(thread.name);
  const totals = new Map<string, { cpu: number; count: number }>();
  for (const thread of threads) {
    const key = keyOf(thread),
      entry = totals.get(key) ?? { cpu: 0, count: 0 };
    entry.cpu += thread.cpu_pct || 0;
    entry.count++;
    totals.set(key, entry);
  }
  const all = threads.reduce((sum, thread) => sum + (thread.cpu_pct || 0), 0);
  let items = [...totals]
    .map(([key, entry]) => ({
      key,
      label: key,
      value: entry.cpu,
      count: entry.count,
    }))
    .sort((a, b) => b.value - a.value || b.count - a.count);
  if (items.length > 10) {
    const rest = items.slice(9);
    items = items.slice(0, 9);
    items.push({
      key: "",
      label: `${String(rest.length)} others`,
      value: rest.reduce((sum, item) => sum + item.value, 0),
      count: rest.reduce((sum, item) => sum + item.count, 0),
    });
  }
  return items.map((item) => ({
    key: item.key,
    label: item.label,
    value: item.value,
    sub: mode === "thread" ? "" : `×${String(item.count)}`,
    tip: [
      { color: "", value: pct(item.value), label: "of one core" },
      {
        color: "",
        value: all ? pct((100 * item.value) / all) : "—",
        label: "of process CPU",
      },
      {
        color: "",
        value: String(item.count),
        label: item.count === 1 ? "thread" : "threads",
      },
    ],
  }));
}

export interface CoreColumn {
  core: number;
  cpu: number;
  /** The bar height as a CSS length. */
  height: string;
  cap: string;
  tip: readonly TipRow[];
}
/** Process CPU by the core each thread last ran on, scaled to the busiest. */
export function coreColumns(threads: readonly Thread[]) {
  const cores = new Map<
    number,
    { cpu: number; count: number; top: Thread | null }
  >();
  let maxCore = 0;
  for (const thread of threads) {
    if (!isNum(thread.cpu)) continue;
    maxCore = Math.max(maxCore, thread.cpu);
    const entry = cores.get(thread.cpu) ?? { cpu: 0, count: 0, top: null };
    entry.cpu += thread.cpu_pct || 0;
    entry.count++;
    if (!entry.top || (thread.cpu_pct || 0) > (entry.top.cpu_pct || 0))
      entry.top = thread;
    cores.set(thread.cpu, entry);
  }
  // At least 5% of a core, so light load stays visible.
  const top = niceMax(
    Math.max(5, ...[...cores.values()].map((entry) => entry.cpu)),
  );
  const columns: CoreColumn[] = [];
  for (let core = 0; core <= maxCore; core++) {
    const entry = cores.get(core) ?? { cpu: 0, count: 0, top: null };
    columns.push({
      core,
      cpu: entry.cpu,
      height: `calc(${String((100 * entry.cpu) / top)}% - 34px)`,
      cap: entry.cpu >= 0.05 ? pct(entry.cpu) : "",
      tip: [
        { color: "", value: pct(entry.cpu), label: "CPU from this process" },
        {
          color: "",
          value: String(entry.count),
          label: "threads last ran here",
        },
        ...(entry.top?.cpu_pct
          ? [
              {
                color: "",
                value: pct(entry.top.cpu_pct),
                label: "top: " + entry.top.name,
              },
            ]
          : []),
      ],
    });
  }
  return {
    columns,
    scale: `Bar height: 0 – ${pct(top)} of one core. Cores with none of this process's threads show no bar.`,
  };
}

/** How long an idle thread has been idle in this tab, or "". */
export function idleFor(thread: Thread, series: Series) {
  const seen = series.seen.get(thread.tid);
  if (!seen) return "";
  const tick = series.lastTick || thread.last_sample || 0;
  return seen.active !== null
    ? "idle for " + duration(tick - seen.active)
    : "idle for over " + duration(tick - seen.first);
}

export type MapWindow = 0 | 60 | 300 | 900;
export const windowNames: Readonly<Record<number, string>> = {
  60: "1 min",
  300: "5 min",
  900: "15 min",
};
/** Average CPU of one thread over the last `window` seconds, or null. */
export function averageCpu(series: Series, tid: number, window: number) {
  const average = series.avg.get(tid);
  if (!average) return null;
  let sum = 0,
    count = 0;
  for (const [t, cpu] of average.samples)
    if (t > series.lastTick - window) {
      sum += cpu;
      count++;
    }
  return count ? sum / count : null;
}
// How the map sees a thread in the window: its CPU, and whether it was idle
// for all of it. Blocked threads (D, stopped) are never idle.
export function mapView(thread: Thread, series: Series, window: MapWindow) {
  if (!window) return { cpu: thread.cpu_pct, idle: isIdle(thread) };
  const seen = series.seen.get(thread.tid),
    blocked = thread.state === "kernel" || thread.state === "stopped";
  const active =
    !!seen && seen.active !== null && series.lastTick - seen.active < window;
  return {
    cpu: averageCpu(series, thread.tid, window),
    idle: !blocked && !active && isIdle(thread),
  };
}
export const MOSAIC_DENSE = 300;
const cpuLabel = (value: number) =>
  value >= 9.95
    ? value.toFixed(0) + "%"
    : value >= 0.05
      ? value.toFixed(1) + "%"
      : "<0.1%";
export interface MapCell {
  thread: Thread;
  state: (typeof STATES)[number];
  idle: boolean;
  text: string;
  label: string;
  tip: readonly TipRow[];
}
/** One tile per thread, grouped by state, busiest first. */
export function mapCells(
  threads: readonly Thread[],
  series: Series,
  window: MapWindow,
) {
  const dense = threads.length > MOSAIC_DENSE;
  const views = new Map(
    threads.map((thread) => [thread.tid, mapView(thread, series, window)]),
  );
  const cpuOf = (thread: Thread) => views.get(thread.tid)?.cpu || 0;
  const sorted = [...threads].sort(
    (a, b) =>
      STATES.indexOf(a.state as (typeof STATES)[number]) -
        STATES.indexOf(b.state as (typeof STATES)[number]) ||
      cpuOf(b) - cpuOf(a) ||
      a.tid - b.tid,
  );
  const cells: MapCell[] = sorted.map((thread) => {
    const view = views.get(thread.tid) ?? { cpu: null, idle: false },
      state = knownState(thread.state);
    const tip: TipRow[] = [
      {
        color: stateColor(thread.state),
        value: stateLabels[thread.state ?? ""] ?? thread.state ?? "",
        label: thread.wchan || "",
      },
    ];
    if (isIdle(thread))
      tip.push({ color: "", value: "idle", label: idleFor(thread, series) });
    else
      tip.push(
        { color: "", value: pct(thread.cpu_pct), label: "CPU now" },
        {
          color: "",
          value: pct(thread.run_delay_pct),
          label: "waiting for CPU",
        },
        { color: "", value: num(thread.switches_per_s), label: "switches/s" },
      );
    for (const seconds of [60, 300, 900]) {
      const average = averageCpu(series, thread.tid, seconds);
      if (isNum(average))
        tip.push({
          color: "",
          value: pct(average),
          label: `average, ${String(windowNames[seconds])}`,
        });
    }
    return {
      thread,
      state,
      idle: view.idle,
      text: !view.idle && !dense && isNum(view.cpu) ? cpuLabel(view.cpu) : "",
      label: `${thread.name}: ${String(stateLabels[state])}, ${view.idle ? "idle" : isNum(view.cpu) ? pct(view.cpu) + " CPU" : "no data yet"}`,
      tip,
    };
  });
  const span =
    series.lastTick && series.since ? series.lastTick - series.since : 0;
  return {
    cells,
    dense,
    legend: STATES.map((state) => ({
      state,
      count: threads.filter((thread) => thread.state === state).length,
    })).filter((entry) => entry.count),
    note: dense
      ? "Hover a square for its CPU · faded = idle"
      : !window
        ? "Number = CPU % of one core, last ~10 s · faded = idle"
        : `Number = average CPU % of one core, last ${String(windowNames[window])} · faded = idle all that time · color = state now`,
    shortData:
      window && span < window - 10
        ? `Only ${duration(span)} of data in this tab so far.`
        : "",
    sub: `One tile per thread (${String(threads.length)}), grouped by current state, busiest ${window ? "over " + String(windowNames[window]) : "now"} first. Click a tile for details.`,
  };
}
