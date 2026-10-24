import type {
  LiveResponse,
  ProcessExit,
  WatchRule,
  MemoryLayout,
  Thread,
} from "../../api/types";
import type { Finding, Level, FindingType } from "../findings";
import { LEVEL_ORDER } from "../findings";
import { isNum, num, pct, ago, clock, duration } from "../format";
import {
  family,
  isIdle,
  futexShare,
  kernelShare,
  threadLabel,
} from "../threads";
import { endedTarget, exitReason } from "../exit";
import { emptySeries, ingest } from "../series";
import type { Series } from "../series";
import { assessResources } from "./resources";
import { assessMemory, memoryRegions, rssTrend } from "./memory";
import type { ResourcePoint } from "./memory";
import { watchedThreads, watchFindings } from "./watch";
export type ViewMode =
  | { kind: "live" }
  | { kind: "final"; exit: ProcessExit | null }
  | { kind: "recorded" };
export interface AssessInput {
  view: LiveResponse;
  mode: ViewMode;
  now: number;
  series: Series;
  watchRules: readonly WatchRule[] | null;
  resourcePoints: readonly ResourcePoint[];
  memoryLayout: MemoryLayout | null;
  memoryHistory: readonly { t: number; mf: number | null }[];
  pressureScope: "cgroup" | "host";
}
function idleSecs(thread: Thread, series: Series, mode: ViewMode) {
  if (mode.kind === "recorded") return null;
  const seen = series.seen.get(thread.tid);
  return isNum(seen?.futexSince)
    ? (series.lastTick || thread.last_sample || 0) - seen.futexSince
    : null;
}
// Major faults per second: the thread samples when they have it (in a
// recording, the recorded ones), else the difference of the last two live
// memory summaries. Live history says nothing about a recording.
export function memoryFaultRate({
  series,
  mode,
  memoryHistory,
}: Pick<AssessInput, "series" | "mode" | "memoryHistory">) {
  const last = series.points.at(-1);
  if (isNum(last?.mf)) return last.mf;
  if (mode.kind === "recorded") return null;
  const points = memoryHistory
      .filter((point): point is { t: number; mf: number } => isNum(point.mf))
      .slice(-2),
    [first, lastPoint] = points;
  const rate =
    first && lastPoint && lastPoint.t > first.t
      ? (lastPoint.mf - first.mf) / (lastPoint.t - first.t)
      : null;
  return rate !== null && rate >= 0 ? rate : null;
}
function memoryOverviewFindings(input: AssessInput) {
  const { view, memoryLayout, resourcePoints, now, pressureScope } = input,
    m = view.memory;
  if (!m?.available || m.stale) return null;
  const layout =
    m.layout_id &&
    memoryLayout?.id === m.layout_id &&
    memoryLayout.pid === m.pid
      ? memoryLayout
      : null;
  const regions = memoryRegions(
    layout,
    view.threads.find((thread) => thread.tid === view.health.pid)?.name,
  );
  return assessMemory(
    m,
    regions,
    view.resources?.available ? view.resources : null,
    memoryFaultRate(input),
    rssTrend(view, resourcePoints, now),
    pressureScope,
  ).filter((item) => item.level !== "info" && item.level !== "good");
}
const STUCK_FUTEX_S = 30;
export function lockHints(
  threads: readonly Thread[],
  series: Series,
  mode: ViewMode,
) {
  const found: Finding[] = [],
    current = threads.filter((thread) => !thread.stale),
    families = new Map<string, Thread[]>();
  for (const thread of current) {
    const key = family(thread.name);
    if (!families.has(key)) families.set(key, []);
    families.get(key)?.push(thread);
  }
  // Threads parked on a futex for a long time while other threads run. A
  // family with an active member is a pool with spare workers; four or more
  // stuck in one family look like an idle pool. Neither is reported.
  const parked = (thread: Thread) =>
    thread.state === "futex" &&
    isIdle(thread) &&
    futexShare(thread) === 1 &&
    (idleSecs(thread, series, mode) ?? 0) >= STUCK_FUTEX_S;
  const stuck = current.filter((thread) => {
    const kin = families.get(family(thread.name)) ?? [];
    return parked(thread) && kin.every(isIdle) && kin.filter(parked).length < 4;
  });
  if (stuck.length >= 2 && current.some((thread) => !isIdle(thread))) {
    const least = Math.min(
      ...stuck.map((thread) => idleSecs(thread, series, mode) ?? 0),
    );
    found.push({
      type: "threads",
      level: "info",
      title: `${String(stuck.length)} threads have waited on a futex for over ${duration(least)} while other threads are active`,
      detail: `Possible deadlock or lost wake-up: ${stuck.slice(0, 3).map(threadLabel).join(", ")}${stuck.length > 3 ? ", …" : ""}. Idle service threads wait the same way, and /proc cannot show which lock it is. Compare with what these threads should be doing; a stack dump names the lock.`,
      action: { state: "futex", activity: "idle" },
    });
  }
  // Many threads of one family waking constantly yet blocked on futex almost all the time with little CPU.
  for (const [name, kin] of families) {
    const waiting = kin.filter(
        (thread) =>
          futexShare(thread) >= 0.7 &&
          (thread.switches_per_s ?? 0) >= 5 &&
          isNum(thread.cpu_pct),
      ),
      cpu = kin.reduce((sum, thread) => sum + (thread.cpu_pct || 0), 0);
    if (kin.length >= 4 && waiting.length >= kin.length * 0.75 && cpu <= 10)
      found.push({
        type: "threads",
        level: "info",
        title: `${String(waiting.length)} of ${String(kin.length)} “${name}” threads mostly wait on a futex but keep waking`,
        detail: `Together they used ${pct(cpu)} of one core and switched ${num(
          kin.reduce((sum, thread) => sum + (thread.switches_per_s || 0), 0),
          0,
        )} times/s. This is how a lock held across slow work (a lock convoy) looks; a pool serving many tiny tasks looks the same. If throughput is lower than expected, find what the lock holder waits for.`,
        action: { state: "futex" },
      });
  }
  return found;
}

export function threadGrowth(
  points: readonly { t: number; n?: number | null }[],
) {
  const STEP = 15,
    counts = points.filter((point): point is { t: number; n: number } =>
      isNum(point.n),
    );
  if (counts.length < 2) return null;
  const newest = counts.at(-1);
  if (!newest) return null;
  const end = newest.t;
  let best = null;
  for (const span of [120, 300]) {
    const bins: ({ n: number; t: number } | undefined)[] = [];
    for (const point of counts) {
      if (point.t < end - span) continue;
      const index = Math.floor((end - point.t) / STEP);
      if (!bins[index] || point.n < bins[index].n)
        bins[index] = { n: point.n, t: point.t };
    }
    let series: { n: number; t: number }[] = [];
    for (let index = bins.length - 1; index >= 0; index--) {
      const bin = bins[index];
      if (bin !== undefined) series.push(bin);
      else series = [];
    }
    for (let i = series.length - 1; i > 0; i--)
      if (
        (series[i - 1]?.n ?? 0) - (series[i]?.n ?? 0) >= 5 &&
        (series[i]?.n ?? 0) < 0.75 * (series[i - 1]?.n ?? 0)
      ) {
        series = series.slice(i);
        break;
      }
    const oldest = series[0],
      latest = series.at(-1);
    if (!oldest || !latest || series.length < 8 || latest.t - oldest.t < 120)
      continue;
    const steps = series.length - 1,
      deltas = series.slice(1).map((value, i) => value.n - (series[i]?.n ?? 0)),
      rises = deltas.filter((delta) => delta > 0).length,
      recent = deltas.slice(-3).filter((delta) => delta > 0).length,
      falls = deltas.filter((delta) => delta < 0).length;
    const first = oldest.n,
      last = latest.n,
      total = last - first,
      middle = Math.floor(steps / 2),
      early = (series[middle]?.n ?? 0) - first,
      late = last - (series[middle]?.n ?? 0);
    if (
      total < 20 ||
      total < 0.1 * first ||
      rises < 0.6 * steps ||
      recent < 2 ||
      falls > 0.2 * steps ||
      early < 0.25 * total ||
      late < 0.25 * total
    )
      continue;
    const minutes = (latest.t - oldest.t) / 60,
      found = { from: first, to: last, minutes, rate: total / minutes };
    if (!best || found.rate > best.rate) best = found;
  }
  return best;
}

export function assess(input: AssessInput) {
  const { view: live, mode, now, series, watchRules } = input,
    threads = live.threads,
    points = series.points;
  const health = live.health,
    findings: Finding[] = [];
  let type: FindingType = "monitor";
  const add = (
    level: Level,
    title: string,
    detail: string,
    action?: Finding["action"],
  ) => findings.push({ type, level, title, detail, action });
  if (health.sampler_silent)
    add(
      "critical",
      "Sampler is silent",
      `No data ${ago(now - (health.last_seen || 0))}. Everything below may be stale.`,
    );
  const ended =
    mode.kind === "final"
      ? mode.exit
      : health.target_absent
        ? endedTarget(live)
        : null;
  if (ended)
    add(
      "critical",
      `Target process ended · ${exitReason(ended)[0]}`,
      `${ended.name || "PID " + String(ended.pid)} ended ${mode.kind === "final" ? "at " + clock(ended.ended_at) : ago(now - ended.ended_at)}. See Last process exit.`,
    );
  else if (health.target_absent)
    add(
      "critical",
      "Target process is absent",
      "The sampler cannot find the configured process. Check it is running, or select another target.",
    );
  if ((health.packet_loss_pct || 0) > 1)
    add(
      "warning",
      `Packet loss ${pct(health.packet_loss_pct)}`,
      "Some samples were lost between sampler and collector over the last minute; rates may be noisy.",
    );
  type = "threads";
  const kernel = threads.filter((thread) => thread.state === "kernel");
  if (kernel.length) {
    const stuck = kernel.filter((thread) =>
      Object.keys(thread.state_mix || {}).every((state) => state === "kernel"),
    );
    add(
      stuck.length ? "serious" : "warning",
      `${String(kernel.length)} thread${kernel.length > 1 ? "s" : ""} in uninterruptible kernel wait`,
      (stuck.length
        ? `${String(stuck.length)} stayed there for the whole last 10 s. `
        : "") +
        "Usually disk, NFS or driver I/O: " +
        kernel.slice(0, 3).map(threadLabel).join(", "),
      { state: "kernel" },
    );
  }
  const hot = threads
    .filter((thread) => (thread.cpu_pct || 0) >= 90)
    .sort((a, b) => (b.cpu_pct ?? 0) - (a.cpu_pct ?? 0));
  // A busy watched thread gets its own, more specific finding below.
  const watched = watchedThreads(threads, health),
    watchBusy = new Set<Thread>(watched);
  for (const thread of hot
    .filter((thread) => !watchBusy.has(thread))
    .slice(0, 2)) {
    const share = kernelShare(thread);
    if (share === null)
      add(
        "serious",
        `${thread.name} is saturating a core`,
        `TID ${String(thread.tid)} uses ${pct(thread.cpu_pct)} of one core. Work that needs this thread will queue behind it.`,
        { tid: thread.tid },
      );
    else
      add(
        "serious",
        `${thread.name} is saturating a core in the kernel`,
        `TID ${String(thread.tid)} uses ${pct(thread.cpu_pct)} of one core, ${pct(100 * share)} of it in the kernel, with ${num(thread.switches_per_s, 0)} context switches/s: it looks like a polling or yield loop (sched_yield, a zero-timeout poll, a spinning retry), not computation. Work that needs this thread will queue behind it.`,
        { tid: thread.tid },
      );
  }
  findings.push(
    ...watchFindings(threads, watched, { view: live, mode, watchRules }),
  );
  const cpu = threads.reduce((sum, thread) => sum + (thread.cpu_pct || 0), 0),
    delay = threads.reduce(
      (sum, thread) => sum + (thread.run_delay_pct || 0),
      0,
    );
  if (cpu >= 10 && delay > cpu * 0.25)
    add(
      "warning",
      "Threads are waiting for CPU",
      `Run delay is ${pct((100 * delay) / cpu)} of CPU time: for every second on a core, threads spent ${(delay / cpu).toFixed(2)} s waiting for one. The host may be oversubscribed.`,
    );
  else {
    const delayed = threads
      .filter((thread) => (thread.run_delay_pct || 0) >= 20)
      .sort((a, b) => (b.run_delay_pct ?? 0) - (a.run_delay_pct ?? 0));
    if (delayed[0])
      add(
        "warning",
        `${delayed[0].name} waits for CPU`,
        `Runnable but not running ${pct(delayed[0].run_delay_pct)} of the time.`,
        { tid: delayed[0].tid },
      );
  }
  const faults = threads.reduce(
    (sum, thread) => sum + (thread.major_faults_per_s || 0),
    0,
  );
  if (faults > 0) {
    const worst = threads.reduce<Thread | null>(
      (best, thread) =>
        (thread.major_faults_per_s || 0) > (best?.major_faults_per_s || 0)
          ? thread
          : best,
      null,
    );
    add(
      "warning",
      `${num(faults)} major page faults/s`,
      `Memory is being read back from disk, which stalls the faulting thread. Most: ${worst ? threadLabel(worst) : ""}.`,
      { tid: worst?.tid },
    );
    const added = findings.at(-1);
    if (added) added.topic = "faults";
  }
  const stopped = threads.filter((thread) => thread.state === "stopped");
  if (stopped.length)
    add(
      "warning",
      `${String(stopped.length)} stopped thread${stopped.length > 1 ? "s" : ""}`,
      "Stopped by a signal or a debugger.",
      { state: "stopped" },
    );
  const recent = points.filter(
      (point) => point.t >= (points.at(-1)?.t || 0) - 60,
    ),
    born = recent.reduce((sum, point) => sum + point.born, 0),
    died = recent.reduce((sum, point) => sum + point.died, 0);
  if (born + died >= 10)
    add(
      "info",
      "High thread churn",
      `At least ${String(born)} threads started and ${String(died)} ended in the last minute (threads that start and exit between samples are not counted). Short-lived threads cost creation time; consider a pool.`,
    );
  const growth = threadGrowth(points);
  if (growth) {
    const pids = live.resources?.available
        ? live.resources.cgroup_limits?.pids
        : null,
      room =
        isNum(pids?.current) && isNum(pids.max) && pids.max > 0
          ? pids.max - pids.current
          : null;
    const eta = room !== null && growth.rate > 0 ? room / growth.rate : null,
      close =
        room !== null &&
        ((pids?.current ?? 0) >= 0.75 * (pids?.max ?? 0) ||
          (eta ?? Infinity) <= 10);
    add(
      close ? "serious" : "warning",
      "Thread count keeps growing",
      `${String(growth.from)} to ${String(growth.to)} threads in ${num(growth.minutes, 1)} min, +${num(growth.rate, 0)} threads/min, and still rising. Each thread holds a stack; if none ever exit, this is a leak (for example workers or requests that wait forever).` +
        (room !== null
          ? ` The cgroup allows ${String(pids?.max)} processes and threads (${String(pids?.current)} in use)` +
            (room > 0
              ? `; at this rate it is full in about ${num(eta, 0)} min.`
              : ".")
          : " No cgroup pids.max is known; RLIMIT_NPROC and kernel.threads-max also cap this."),
    );
  }
  const stale = threads.filter((thread) => thread.stale);
  if (stale.length)
    add(
      "info",
      `${String(stale.length)} stale thread${stale.length > 1 ? "s" : ""}`,
      "Not reported recently; they may have exited.",
    );
  const hidden = threads.filter((thread) => thread.state === "no_access");
  if (hidden.length)
    add(
      "info",
      `${String(hidden.length)} thread${hidden.length > 1 ? "s" : ""} unreadable`,
      "The sampler could not read their state; run it as the target user.",
      { state: "no_access" },
    );
  if (cpu >= 1 && threads.length > 1) {
    const top = threads.reduce((best, thread) =>
      (thread.cpu_pct || 0) > (best.cpu_pct || 0) ? thread : best,
    );
    const share = (top.cpu_pct || 0) / cpu;
    if (share >= 0.6 && !hot.length)
      add(
        "info",
        `${top.name} does most of the work`,
        `${pct(100 * share)} of the process's CPU is on one thread. If load grows, it will be the first bottleneck.`,
        { tid: top.tid },
      );
  }
  findings.push(...lockHints(threads, series, mode));
  findings.push(...assessResources(live.resources, now));
  // Memory-map findings join too. One about the same topic as a finding above
  // (major faults) is not repeated: the more severe wording stays, with the
  // thread link of the one it replaces.
  const memory = memoryOverviewFindings(input),
    rank = (item: Finding) => LEVEL_ORDER.indexOf(item.level);
  for (const item of memory || []) {
    const twin =
      item.topic && findings.find((other) => other.topic === item.topic);
    if (!twin) findings.push(item);
    else if (rank(item) < rank(twin))
      findings[findings.indexOf(twin)] = { ...item, action: twin.action };
  }
  if (!findings.some((item) => item.level !== "info"))
    findings.unshift({
      type: "monitor",
      level: "good",
      title: "No problems detected",
      detail:
        (live.resources?.available
          ? "No saturated threads, CPU waiting, kernel stalls, paging, resource pressure, exhausted limits or full socket buffers right now."
          : "No saturated threads, CPU waiting, kernel stalls or paging right now.") +
        (memory
          ? " No memory-map warnings detected in the available samples."
          : ""),
    });
  return findings;
}

export function assessRecorded(
  view: LiveResponse,
  at: number,
  resourcePoints: readonly ResourcePoint[],
): Finding[] {
  const findings = assess({
    view,
    mode: { kind: "recorded" },
    now: at,
    series: ingest(emptySeries, view),
    watchRules: null,
    resourcePoints: resourcePoints.filter((point) => point.t <= at),
    memoryLayout: null,
    memoryHistory: [],
    pressureScope: "cgroup",
  });
  return findings.map((item) =>
    item.action?.tid !== undefined
      ? {
          ...item,
          action: {
            ...item.action,
            session: view.health.session,
            generation: view.threads.find(
              (thread) => thread.tid === item.action?.tid,
            )?.generation,
          },
        }
      : item,
  );
}
export function fleetAssessment(
  view: LiveResponse | null | undefined,
  now: number,
) {
  if (!view?.health) return null;
  const findings = assessRecorded(view, now, [])
    .filter((item) => item.level !== "good")
    .sort(
      (a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level),
    );
  return {
    level: findings.find((item) => item.level !== "info")?.level ?? "good",
    findings,
  };
}
