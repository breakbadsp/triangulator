import type {
  LiveResponse,
  MemoryLayout,
  MemoryRegion,
  MemorySummary,
  ResourceRow,
  Resources,
} from "../../api/types";
import type { Finding, Level } from "../findings";
import { LEVEL_ORDER } from "../findings";
import { isNum, memoryBytes, num, pct, signed, duration } from "../format";
import { hasCgroup, stall } from "./resources";
export interface ClassifiedRegion extends MemoryRegion {
  lo: bigint;
  hi: bigint;
  cat?: string;
  certain?: boolean;
}
export interface ResourcePoint extends ResourceRow {
  t: number;
  per: (key: keyof ResourceRow) => number | null;
}
export const asResourcePoints = (
  rows: readonly ResourceRow[],
): ResourcePoint[] =>
  rows.map((row) => ({
    ...row,
    t: row.ts,
    per: (key) =>
      isNum(row[key]) && isNum(row.elapsed_s) && row.elapsed_s > 0
        ? row[key] / row.elapsed_s
        : null,
  }));
const isLibrary = (name: string) =>
  /\.so(\.\d[\w.]*)?( \(deleted\))?$/.test(name || "");
export const baseName = (name: string) => (name || "").split("/").pop();
export function memoryRegions(layout: MemoryLayout | null, comm?: string) {
  const regions: ClassifiedRegion[] = (layout?.regions || []).map((region) => ({
    ...region,
    lo: BigInt(region.start),
    hi: BigInt(region.end),
  }));
  regions.sort((a, b) => (a.lo < b.lo ? 1 : a.lo > b.lo ? -1 : 0));
  // The program image is an executable file mapping, not a library. A data
  // file can be mapped below it, so execute permission is required. The one
  // named like the target's comm is the program for certain; without such a
  // match the lowest candidate is only a guess.
  const candidates = regions.filter(
    (region) =>
      region.kind === "file" &&
      region.permissions[2] === "x" &&
      !isLibrary(region.name),
  );
  const named = comm
    ? candidates.find((region) =>
        (baseName(region.name) ?? "")
          .replace(/ \(deleted\)$/, "")
          .startsWith(comm),
      )
    : undefined;
  const program = named ?? candidates.at(-1);
  for (const region of regions)
    region.cat =
      region.kind === "heap" ||
      region.kind === "stack" ||
      region.kind === "kernel"
        ? region.kind
        : region.permissions.startsWith("---")
          ? "guard"
          : region.kind === "file"
            ? isLibrary(region.name)
              ? "library"
              : region === program
                ? "code"
                : "file"
            : "anonymous";
  if (program) program.certain = program === named;
  return regions;
}

function memorySlope(
  points: readonly (ResourcePoint & { rss_bytes: number })[],
) {
  const values = points.filter(
    (point): point is ResourcePoint & { rss_bytes: number } =>
      isNum(point.rss_bytes),
  );
  if (values.length < 2) return null;
  const mean = (list: readonly number[]) =>
      list.reduce((sum, value) => sum + value, 0) / list.length,
    t0 = mean(values.map((point) => point.t)),
    v0 = mean(values.map((point) => point.rss_bytes));
  let covariance = 0,
    variance = 0;
  for (const point of values) {
    covariance += (point.t - t0) * (point.rss_bytes - v0);
    variance += (point.t - t0) ** 2;
  }
  return variance > 0 ? (60 * covariance) / variance : null;
}

const RSS_TREND_WINDOWS = [60, 120, 180],
  RSS_TREND_MIN_SPAN = 30,
  RSS_TREND_MIN_POINTS = 6;
export function rssTrend(
  view: LiveResponse,
  all: readonly ResourcePoint[],
  now: number,
) {
  if (!view.resources?.available || view.resources.stale) return null;
  if (!all.length) return null;
  const newest = all.at(-1);
  if (!newest || !isNum(newest.rss_bytes) || now - newest.t > 360) return null;
  if (!isNum(view.health.pid) || newest.pid !== view.health.pid) return null;
  let first = all.length - 1;
  while (first > 0 && all[first - 1]?.pid === newest.pid) first--;
  const run = all
    .slice(first)
    .filter((point): point is ResourcePoint & { rss_bytes: number } =>
      isNum(point.rss_bytes),
    );
  let best = null;
  for (const window of RSS_TREND_WINDOWS) {
    const points = run.filter((point) => point.t >= newest.t - window);
    const firstPoint = points[0];
    if (
      !firstPoint ||
      points.length < RSS_TREND_MIN_POINTS ||
      newest.t - firstPoint.t < RSS_TREND_MIN_SPAN
    )
      continue;
    let rises = 0;
    for (let index = 1; index < points.length; index++)
      if ((points[index]?.rss_bytes ?? 0) > (points[index - 1]?.rss_bytes ?? 0))
        rises++;
    const steps = points.length - 1,
      slope = memorySlope(points),
      span = newest.t - firstPoint.t;
    const steady =
      rises >= 0.8 * steps &&
      slope !== null &&
      slope >= 2 ** 20 &&
      (slope * span) / 60 >= 2 ** 20;
    const trend = { slope, span, rises, steps, steady };
    if (
      !best ||
      (steady && (!best.steady || best.slope === null || slope > best.slope)) ||
      (!steady && !best.steady)
    )
      best = trend;
  }
  return best;
}

export function assessMemory(
  m: MemorySummary,
  regions: readonly ClassifiedRegion[],
  r: Resources | null = null,
  faults: number | null = null,
  trend: ReturnType<typeof rssTrend> = null,
  pressureScope: "cgroup" | "host" = "cgroup",
) {
  const findings: Finding[] = [],
    v = m.values || {},
    flags = m.flags || {};
  const add = (level: Level, title: string, detail: string, topic?: string) =>
    findings.push({ type: "memory", level, title, detail, topic });
  if (flags.maps_hidden)
    add(
      "warning",
      "The memory map is not readable",
      "The sampler cannot read /proc/PID/maps. Run it as the target’s user; the target may also be non-dumpable.",
    );
  if (isNum(v.vma_count) && isNum(v.max_map_count) && v.max_map_count > 0) {
    const share = (100 * v.vma_count) / v.max_map_count;
    if (share >= 75) {
      const anonymous = regions
          .filter((region) => region.cat === "anonymous")
          .reduce((sum, region) => sum + region.vmas, 0),
        guards = regions
          .filter((region) => region.cat === "guard")
          .reduce((sum, region) => sum + region.vmas, 0);
      add(
        share >= 90 ? "critical" : "warning",
        "Mapping count is close to the limit",
        `${String(v.vma_count)} of ${String(v.max_map_count)} (vm.max_map_count). At the limit, mmap and thread creation fail with ENOMEM. ${String(anonymous)} mappings are anonymous and ${String(guards)} are guard pages.`,
      );
    }
  }
  if (
    isNum(v.vm_size_bytes) &&
    isNum(v.address_space_limit_bytes) &&
    v.address_space_limit_bytes > 0
  ) {
    const share = (100 * v.vm_size_bytes) / v.address_space_limit_bytes;
    if (share >= 75)
      add(
        share >= 90 ? "critical" : "warning",
        "Address space is close to RLIMIT_AS",
        `${memoryBytes(v.vm_size_bytes)} of ${memoryBytes(v.address_space_limit_bytes)} mapped. Past the limit, mmap and malloc fail even with free RAM.`,
      );
  }
  const psi = stall(
    r?.pressure?.[
      pressureScope === "cgroup" && hasCgroup(r) ? "cgroup" : "host"
    ]?.memory?.some,
  );
  if (isNum(faults) && faults >= 10 && isNum(psi) && psi >= 5)
    add(
      "serious",
      "Major page faults and memory pressure rise together",
      `${num(faults)} major faults/s and memory pressure ${pct(psi)} (some). The working set does not fit in memory${r?.memory?.swap ? `; ${memoryBytes(r.memory.swap)} is swapped out` : ""}.`,
      "faults",
    );
  else if (isNum(faults) && faults >= 50)
    add(
      "warning",
      "Frequent major page faults",
      `${num(faults)} major faults/s: threads wait for pages read back from disk or swap.`,
      "faults",
    );
  const heap = regions.find((region) => region.cat === "heap");
  if (trend?.steady)
    add(
      "warning",
      "Resident memory grows without a plateau",
      `RSS rose in ${String(trend.rises)} of the last ${String(trend.steps)} samples (${signed(trend.slope ?? 0)}/min over ${duration(trend.span)}). Anonymous: ${memoryBytes(r?.memory?.anon)}${heap ? `; heap: ${memoryBytes(heap.size)}` : ""}.`,
    );
  if (
    r?.memory &&
    isNum(r.memory.swap) &&
    r.memory.swap > 0 &&
    isNum(r.memory.rss) &&
    r.memory.rss > 0 &&
    r.memory.swap >= 0.1 * r.memory.rss
  )
    add(
      "warning",
      "Part of the process is swapped out",
      `${memoryBytes(r.memory.swap)} in swap next to ${memoryBytes(r.memory.rss)} resident. Touching it costs a major fault.`,
    );
  // Only code matters: deleted data files (shared memory, temporary files)
  // are normal, and the sampler may cut the start of long names.
  // A guessed program image is reported as an executable file, not as the program.
  const deleted = regions.filter(
    (region) =>
      (region.cat === "library" || region.cat === "code") &&
      / \(deleted\)$/.test(region.name),
  );
  if (deleted.length)
    add(
      "info",
      deleted.some((region) => region.cat === "code" && region.certain)
        ? "Program replaced on disk"
        : deleted.some((region) => region.cat === "code")
          ? "Executable file replaced on disk"
          : "Library replaced on disk",
      `${deleted
        .slice(0, 2)
        .map((region) => region.name)
        .join(
          ", ",
        )}${deleted.length > 2 ? ` and ${String(deleted.length - 2)} more` : ""} ${deleted.length === 1 ? "is" : "are"} still mapped. The process runs the old code until it restarts.`,
    );
  const stack = regions.find((region) => region.cat === "stack");
  if (stack && isNum(v.stack_limit_bytes) && v.stack_limit_bytes > 0) {
    const share = (100 * stack.size) / v.stack_limit_bytes;
    add(
      share >= 75 ? "warning" : "info",
      `Main stack is at ${pct(share)} of its limit`,
      `[stack] is ${memoryBytes(stack.size)}; RLIMIT_STACK is ${memoryBytes(v.stack_limit_bytes)}. Going deeper than the limit ends in SIGSEGV. Common pthread stacks reserve a fixed range and are not counted here.`,
    );
  }
  if (!findings.some((item) => item.level !== "info"))
    add(
      "good",
      "Nothing unusual in the memory map",
      "Mappings, address space and stack are well within their limits.",
    );
  return findings.sort(
    (a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level),
  );
}
