import { memoryBytes, signed, duration, isNum } from "./format";
import { memorySlope, type ResourcePoint } from "./assess/memory";

export type MemoryTrendKind =
  "steady" | "growing" | "stepping" | "shrinking" | "unknown";
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
 * run counts: a restart drops RSS and is not a jump or a shrink.
 */
export function classifyMemory(points: readonly ResourcePoint[]): MemoryTrend {
  const restarts = restartTimes(points),
    since = restarts.at(-1) ?? -Infinity;
  const run = points.filter(
    (point): point is ResourcePoint & { rss_bytes: number } =>
      point.t >= since && isNum(point.rss_bytes),
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
  const jumps: number[] = [];
  for (let i = 1; i < run.length; i++) {
    const rise = (run[i]?.rss_bytes ?? 0) - (run[i - 1]?.rss_bytes ?? 0);
    if (rise >= MIN_JUMP) jumps.push(rise);
  }
  const jumped = jumps.reduce((sum, value) => sum + value, 0);
  const big = Math.abs(total) >= Math.max(MIN_CHANGE, 0.05 * first.rss_bytes);
  if (jumps.length && total > 0 && jumped >= 0.5 * total)
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
  const rate = (memorySlope(run) ?? 0) * 60;
  return {
    kind: "growing",
    text: `Growing steadily: ${signed(rate)}/h over ${duration(span)}${afterRestart}. A leak is likely if the load did not rise.`,
    change: `Grew ${memoryBytes(total)}${over}`,
  };
}
