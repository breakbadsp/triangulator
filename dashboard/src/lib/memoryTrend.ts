import { memoryBytes, signed, duration, isNum } from "./format";
import { memorySlope, type ResourcePoint } from "./assess/memory";

export type MemoryTrendKind =
  "steady" | "growing" | "stepping" | "shrinking" | "mixed" | "unknown";
export interface MemoryTrend {
  kind: MemoryTrendKind;
  /** One plain sentence for a support user. */
  text: string;
  /** "Grew X in Y", or null when the change is not a growth. */
  change: string | null;
}

export const MIN_POINTS = 6,
  MIN_SPAN = 300,
  MIN_CHANGE = 8 * 2 ** 20,
  MIN_JUMP = 32 * 2 ** 20;

/** Times at which the process id changed between two stored points. */
export function restartTimes(points: readonly ResourcePoint[]): number[] {
  const times: number[] = [];
  for (let i = 1; i < points.length; i++)
    if (points[i]?.pid !== points[i - 1]?.pid) times.push(points[i]?.t ?? 0);
  return times;
}

/**
 * Judge the stored RSS points of the shown window. Only the newest process
 * run counts: a restart drops RSS and is not a jump or a shrink. The stored
 * bucket that spans a restart holds the new pid but the old peak RSS, so the
 * run starts after it.
 */
export function classifyMemory(points: readonly ResourcePoint[]): MemoryTrend {
  const restarts = restartTimes(points),
    since = restarts.at(-1) ?? -Infinity;
  const run = points.filter(
    (point): point is ResourcePoint & { rss_bytes: number } =>
      point.t > since && isNum(point.rss_bytes),
  );
  const first = run[0],
    last = run.at(-1);
  const span = first && last ? last.t - first.t : 0;
  if (!first || !last || run.length < MIN_POINTS || span < MIN_SPAN)
    return {
      kind: "unknown",
      text: "Not enough data yet to judge memory. Wait a few minutes.",
      change: null,
    };
  const total = last.rss_bytes - first.rss_bytes,
    over = ` in ${duration(span)}`,
    afterRestart = restarts.length ? " since the last restart" : "";
  const big = Math.abs(total) >= Math.max(MIN_CHANGE, 0.05 * first.rss_bytes);
  // A jump is a rise well above the average rise for that point interval, so
  // a smooth ramp over wide buckets is not stepping.
  const jumps: number[] = [];
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1],
      b = run[i];
    if (!a || !b) continue;
    const rise = b.rss_bytes - a.rss_bytes,
      typical = (total / span) * (b.t - a.t);
    if (rise >= Math.max(MIN_JUMP, 4 * typical)) jumps.push(rise);
  }
  const slope = memorySlope(run) ?? 0;
  // The end-to-end change and the fitted trend can disagree after a rise
  // followed by a longer fall. Do not call that growth or shrinkage.
  if (big && total * slope < 0)
    return {
      kind: "mixed",
      text: `Memory went up and down (peak ${memoryBytes(Math.max(...run.map((point) => point.rss_bytes)))}, now ${memoryBytes(last.rss_bytes)})${over}${afterRestart}.`,
      change: null,
    };
  const jumped = jumps.reduce((sum, value) => sum + value, 0);
  if (big && jumps.length && total > 0 && jumped >= 0.5 * total)
    return {
      kind: "stepping",
      text: `Memory rose in ${String(jumps.length)} sudden ${jumps.length === 1 ? "jump" : "jumps"} (${signed(jumped)} in total)${afterRestart}. Check what the process did at those times, such as loading data or starting a job.`,
      change: `Grew ${memoryBytes(total)}${over}`,
    };
  if (!big)
    return {
      kind: "steady",
      text: `Steady: memory stayed within ${memoryBytes(Math.abs(total))}${over}${afterRestart}. No growth to act on.`,
      change: null,
    };
  if (total < 0)
    return {
      kind: "shrinking",
      text: `Shrinking: memory fell ${memoryBytes(-total)}${over}${afterRestart}. This is normal after a busy period.`,
      change: null,
    };
  const rate = slope * 60;
  return {
    kind: "growing",
    text: `Growing steadily: ${signed(rate)}/h over ${duration(span)}${afterRestart}. A leak is likely if the load did not rise.`,
    change: `Grew ${memoryBytes(total)}${over}`,
  };
}

/** The chip windows, in seconds. They match the history ranges. */
export const CHANGE_WINDOWS = [900, 3600, 21600, 86400] as const;
/** A change below this share of the window-start value is flat. */
export const DEAD_ZONE = 0.01;
/** A window whose first stored value is later than this share of it is "–". */
export const COVERAGE = 0.1;
/** The smallest span of an auto-scaled byte axis. */
export const MIN_AXIS_SPAN = 2 ** 20;

export type Direction = "up" | "down" | "flat";
/** The change over one window, or null when the window cannot be judged. */
export type WindowChange = {
  direction: Direction;
  /** Latest value minus the value at the window start. */
  delta: number;
  start: { t: number; v: number };
  end: { t: number; v: number };
} | null;

// No change is flat, also from a start value of 0, where the dead zone is 0.
const direction = (delta: number, start: number): Direction =>
  delta === 0 || Math.abs(delta) < DEAD_ZONE * Math.abs(start)
    ? "flat"
    : delta > 0
      ? "up"
      : "down";

/**
 * The stored values of the newest process run, as classifyMemory takes them.
 * Rows without the value, such as rows stored before VmSize and host memory
 * were kept, are left out.
 */
export function newestRun(
  points: readonly ResourcePoint[],
  get: (point: ResourcePoint) => number | null | undefined,
) {
  const since = restartTimes(points).at(-1) ?? -Infinity;
  const run: { t: number; v: number }[] = [];
  for (const point of points) {
    const v = get(point);
    if (point.t > since && isNum(v)) run.push({ t: point.t, v });
  }
  return { since, run };
}

/** One change for each of CHANGE_WINDOWS, ending at the newest value. */
export function windowChanges(
  points: readonly ResourcePoint[],
  get: (point: ResourcePoint) => number | null | undefined,
): WindowChange[] {
  const { since, run } = newestRun(points, get);
  const end = run.at(-1);
  return CHANGE_WINDOWS.map((window) => {
    if (!end) return null;
    const from = end.t - window;
    // A restart inside the window: the old run is not this process.
    if (since >= from) return null;
    const start = run.find((point) => point.t >= from);
    if (!start || start === end || start.t - from > COVERAGE * window)
      return null;
    const delta = end.v - start.v;
    return { direction: direction(delta, start.v), delta, start, end };
  });
}

/** The change per hour, or null when it has no time span. */
export function perHour(change: WindowChange) {
  if (!change || change.end.t <= change.start.t) return null;
  return (
    ((change.end.v - change.start.v) / (change.end.t - change.start.t)) * 3600
  );
}

/** Seconds since the value last moved beyond the dead zone of the newest. */
export function flatFor(run: readonly { t: number; v: number }[]) {
  const end = run.at(-1);
  if (!end) return null;
  let since = run[0]?.t ?? end.t;
  for (let i = run.length - 2; i >= 0; i--) {
    const point = run[i];
    if (
      point &&
      point.v !== end.v &&
      Math.abs(point.v - end.v) >= DEAD_ZONE * Math.abs(end.v)
    ) {
      since = run[i + 1]?.t ?? end.t;
      break;
    }
  }
  return end.t - since;
}

/**
 * A y-axis range around the values, not from 0, so a small change shows.
 * The span is at least max(1 MiB, 5% of the newest value).
 */
export function autoSpan(values: readonly number[]) {
  const last = values.at(-1);
  if (last === undefined) return null;
  let min = last,
    max = last;
  for (const value of values) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  const span = Math.max(MIN_AXIS_SPAN, 0.05 * Math.abs(last));
  if (max - min < span) {
    const middle = (max + min) / 2;
    min = middle - span / 2;
    max = middle + span / 2;
  }
  if (min < 0) {
    max -= min;
    min = 0;
  }
  return { min, max };
}

/** Host memory available as a share of the total, from a stored row. */
export const hostAvailablePct = (point: ResourcePoint) =>
  isNum(point.host_mem_available_bytes) &&
  isNum(point.host_mem_total_bytes) &&
  point.host_mem_total_bytes > 0
    ? (100 * point.host_mem_available_bytes) / point.host_mem_total_bytes
    : null;

/** Arrow text, so the direction does not depend on color. */
export const ARROWS = { up: "▲", down: "▼", flat: "►" } as const;

/** True when every window rose: the "Rising in every window" pill. */
export const risingInEveryWindow = (changes: readonly WindowChange[]) =>
  changes.length > 0 && changes.every((change) => change?.direction === "up");

/**
 * "▲ +0.35 MiB/h" for the selected range. A rate over less than 1 h is mostly
 * noise, so shorter ranges show none.
 */
export function rateText(
  change: WindowChange,
  range: number,
  format: (perHour: number) => string,
) {
  const rate = range >= 3600 ? perHour(change) : null;
  return change && rate !== null
    ? `${ARROWS[change.direction]} ${format(rate)}/h`
    : null;
}
