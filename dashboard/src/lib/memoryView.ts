// The Memory map section's pure logic, ported from the pinned page
// (777cf3a:collector/dashboard.html, "Memory map"). All state of one
// process lives in one `MemoryState`; a sample with another key starts
// again from `initialMemory`, as the old resetMemoryTarget did.
import type {
  MemoryLayout,
  MemorySummary,
  PressureScope,
  Resources,
} from "../api/types";
import {
  baseName,
  memoryRegions,
  type ClassifiedRegion,
  type rssTrend,
} from "./assess/memory";
import { stall } from "./assess/resources";
import { ago, duration, isNum, memoryBytes, num, pct, signed } from "./format";
import { scopeOf } from "./resourceView";

// Bar colors, and whether the bar's text is white. Program code and
// libraries share a color.
export const MEMORY_KINDS: Readonly<
  Record<string, readonly [string, boolean]>
> = {
  code: ["var(--k-code)", true],
  library: ["var(--k-code)", true],
  heap: ["var(--k-heap)", true],
  stack: ["var(--k-stack)", true],
  anonymous: ["var(--k-anon)", false],
  file: ["var(--k-file)", false],
  guard: ["var(--k-guard)", false],
  kernel: ["var(--k-kernel)", false],
};
export const MEMORY_KIND_LABELS: Readonly<Record<string, string>> = {
  code: "program / library code",
  library: "program / library code",
  heap: "heap (brk)",
  stack: "stack",
  anonymous: "anonymous (arenas, mmap)",
  file: "file mapping",
  guard: "guard (no access)",
  kernel: "kernel",
};
export const kindColor = (cat: string) =>
  (MEMORY_KINDS[cat] ?? MEMORY_KINDS.anonymous)?.[0] ?? "var(--k-anon)";
const kindLabel = (cat: string) => MEMORY_KIND_LABELS[cat] ?? cat;

const MEMORY_GAP = 2 ** 30; // an unmapped space this large gets its own row
const MEMORY_ROWS = 18; // bars at most, not counting gaps
const GRID_SQUARES = 512;
export const GRID_COLUMNS = 64;
const HEAP_MARGIN_LIMIT = 1048576n;
const BUFFER_SECS = 900;

/** One bar of the address map: neighbouring regions of a kind. */
export interface MemoryBar {
  key: string;
  cat: string;
  members: ClassifiedRegion[];
  lo: bigint;
  hi: bigint;
  size: number;
  vmas: number;
  mixed?: boolean;
}
export interface MemoryGap {
  gap: number;
}
export type MemoryRow = MemoryBar | MemoryGap;
export const isBar = (row: MemoryRow): row is MemoryBar => !("gap" in row);
type Draft = Omit<MemoryBar, "key">;
const isDraft = (item: Draft | MemoryGap | undefined): item is Draft =>
  !!item && !("gap" in item);

const catOf = (region: ClassifiedRegion) => region.cat ?? "anonymous";

// One row per run of neighbouring regions of a kind, high addresses first.
// Libraries take in the small anonymous and guard regions between them;
// anonymous runs take in their guards.
export function memoryRows(regions: readonly ClassifiedRegion[]): MemoryRow[] {
  const rows: (Draft | MemoryGap)[] = [];
  let row: Draft | null = null;
  for (const region of regions) {
    const cat = catOf(region);
    if (row && Number(row.lo - region.hi) >= MEMORY_GAP) {
      rows.push({ gap: Number(row.lo - region.hi) });
      row = null;
    }
    const joins =
      row &&
      ((row.cat === cat && !["code", "heap", "stack"].includes(row.cat)) ||
        (row.cat === "library" &&
          ["anonymous", "guard"].includes(cat) &&
          region.size <= 2 ** 20) ||
        (row.cat === "anonymous" && cat === "guard"));
    if (row && joins) {
      row.members.push(region);
      row.lo = region.lo;
      row.size += region.size;
      row.vmas += region.vmas;
    } else {
      row = {
        cat,
        members: [region],
        lo: region.lo,
        hi: region.hi,
        size: region.size,
        vmas: region.vmas,
      };
      rows.push(row);
    }
  }
  // A busy process has hundreds of runs. Merge the cheapest neighbouring
  // pair until the map fits: the one with the least mapped and unmapped
  // bytes, so big gaps stay. Heap, stack, program and kernel stay apart.
  const mergeable = (item: Draft | MemoryGap | undefined): item is Draft =>
    isDraft(item) && !["code", "heap", "stack", "kernel"].includes(item.cat);
  while (rows.filter(isDraft).length > MEMORY_ROWS) {
    let best: { index: number; next: number; cost: number } | null = null;
    for (let index = 0; index < rows.length; index++) {
      const upper = rows[index],
        after = rows[index + 1];
      if (!mergeable(upper)) continue;
      const gap = after && "gap" in after ? after.gap : 0;
      const next = after && "gap" in after ? index + 2 : index + 1;
      const lower = rows[next];
      if (!mergeable(lower)) continue;
      const cost = upper.size + lower.size + gap;
      if (!best || cost < best.cost) best = { index, next, cost };
    }
    if (!best) break;
    const upper = rows[best.index],
      lower = rows[best.next];
    if (!isDraft(upper) || !isDraft(lower)) break;
    const members = [...upper.members, ...lower.members];
    const totals = new Map<string, number>();
    for (const region of members)
      totals.set(catOf(region), (totals.get(catOf(region)) ?? 0) + region.size);
    const merged: Draft = {
      members,
      lo: lower.lo,
      hi: upper.hi,
      size: upper.size + lower.size,
      vmas: upper.vmas + lower.vmas,
      cat: [...totals].sort((a, b) => b[1] - a[1])[0]?.[0] ?? upper.cat,
      mixed:
        totals.size > 1 ||
        !!upper.mixed ||
        !!lower.mixed ||
        best.next > best.index + 1,
    };
    rows.splice(best.index, best.next - best.index + 1, merged);
  }
  // Heap, stack and program keep their key while they grow, so the zoom
  // stays on them.
  return rows.map((item) =>
    "gap" in item
      ? item
      : {
          ...item,
          key: ["heap", "stack", "code"].includes(item.cat)
            ? item.cat
            : `${item.cat}:${String(item.lo)}`,
        },
  );
}

export function memoryRegionName(region: ClassifiedRegion) {
  return (
    region.name ||
    ({ anonymous: "[anonymous]", heap: "[heap]", stack: "[stack]" }[
      region.kind
    ] ??
      "")
  );
}
const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;
export function memoryRowName(row: MemoryBar) {
  const members = row.members,
    count = (cat: string) =>
      members.filter((region) => catOf(region) === cat).length;
  const first = members[0];
  const names = new Set(members.map((region) => region.name));
  if (members.length > 1 && names.size === 1 && first?.name)
    return `${String(members.length)} × ${baseName(first.name) ?? ""}`;
  if (row.mixed) {
    const parts = (
      [
        ["anonymous", "anonymous", "anonymous"],
        ["library", "library", "libraries"],
        ["file", "file", "files"],
        ["guard", "guard", "guards"],
      ] as const
    )
      .map(([cat, one, many]) => {
        const n = count(cat);
        return n ? plural(n, one, many) : "";
      })
      .filter(Boolean);
    return (
      parts.join(", ") +
      (parts.length === 1 && count("anonymous") > 1 ? " regions" : "")
    );
  }
  switch (row.cat) {
    case "library": {
      const libraries = members.filter((region) => catOf(region) === "library");
      const names = [
        ...new Set(
          libraries
            .map((region) =>
              (baseName(region.name) ?? "").replace(/\.so(\.\d[\w.]*)?/, ""),
            )
            .reverse(),
        ),
      ];
      return names.length === 1
        ? (baseName(libraries[0]?.name ?? "") ?? "")
        : `${names.slice(0, 4).join(", ")}${names.length > 4 ? " …" : ""} (${String(names.length)} libraries)`;
    }
    case "code":
      return (
        (baseName(first?.name ?? "") ?? "") +
        (first?.certain ? " (program image)" : " (probably the program)")
      );
    case "kernel":
      return members.map(memoryRegionName).reverse().join(" ");
    case "anonymous": {
      const anonymous = count("anonymous"),
        guards = count("guard");
      return anonymous === 1 && !guards && first
        ? memoryRegionName(first)
        : `${plural(anonymous, "anonymous region", "anonymous regions")}${guards ? ` + ${plural(guards, "guard", "guards")}` : ""}`;
    }
    case "file":
      return members.length === 1
        ? (baseName(first?.name ?? "") ?? "")
        : `${String(members.length)} mapped files`;
    case "guard":
      return members.length === 1
        ? "guard (no access)"
        : `${String(members.length)} guard regions`;
    default:
      return first ? memoryRegionName(first) : "";
  }
}
export const memoryPerms = (row: MemoryBar) =>
  [...new Set(row.members.map((region) => region.permissions))]
    .slice(0, 3)
    .join(" ");
export const memoryGrows = (cat: string) =>
  cat === "heap" ? " · grows ↑" : cat === "stack" ? " · grows ↓" : "";
export const hex = (value: bigint) => `0x${value.toString(16)}`;
export const microseconds = (value: unknown) =>
  isNum(value)
    ? value >= 1000
      ? num(value / 1000, 1) + " ms"
      : String(value) + " µs"
    : "—";

// ---------- Layout identity ----------
// A layout id is "<sampler session>:<sequence>" (collector/memory.hpp).
const sessionOf = (id: string | null | undefined) => id?.split(":")[0];
export const layoutComplete = <T extends Pick<MemoryLayout, "flags">>(
  layout: T | null | undefined,
): layout is T =>
  !!layout &&
  !layout.flags?.maps_hidden &&
  !layout.flags?.maps_partial &&
  !layout.flags?.regions_truncated;
// The held layout when it belongs to the summary's session and process: a
// newer layout of the same session is still being fetched, so the older
// one stays on screen until then.
export function layoutFor(m: MemorySummary, layout: MemoryLayout | null) {
  return layout?.id &&
    m.layout_id &&
    sessionOf(layout.id) === sessionOf(m.layout_id) &&
    layout.pid === m.pid
    ? layout
    : null;
}
// The layout the summary names, complete and of the sampler's session.
function currentLayout(
  m: MemorySummary,
  layout: MemoryLayout | null,
  session: string | null | undefined,
) {
  return m.available &&
    !m.stale &&
    layoutComplete(m) &&
    layoutComplete(layout) &&
    layout.id === m.layout_id &&
    layout.pid === m.pid &&
    sessionOf(layout.id) === session
    ? layout
    : null;
}

// ---------- State ----------
/** One live memory sample: mapping boundaries, fault count and residency. */
export interface MemoryPoint {
  t: number;
  heap: number | null;
  stack: number | null;
  heapEnd: bigint | null;
  stackStart: bigint | null;
  mf: number | null;
  rss: number | null;
  anon: number | null;
}
/** What the state reads from one live view. */
export interface MemoryLive {
  summary: MemorySummary | undefined;
  session: string | null | undefined;
  comm: string | undefined;
  /** The resource sample of the same process and session, else null. */
  resources: Resources | null;
}
export interface HeapSpan {
  key: string;
  lo: bigint;
  hi: bigint;
}
export interface MemoryState {
  /** `target|session|pid`. */
  key: string | null;
  live: MemoryLive | null;
  layout: MemoryLayout | null;
  /** The layout before `layout`, for the zoom's "mapped since" squares. */
  previous: MemoryLayout | null;
  history: readonly MemoryPoint[];
  /** A host constant: kept for the state once a resource sample gives it. */
  page: number | null;
  selected: string | null;
  heapSpan: HeapSpan | null;
}
export const initialMemory: MemoryState = {
  key: null,
  live: null,
  layout: null,
  previous: null,
  history: [],
  page: null,
  selected: null,
  heapSpan: null,
};
export type MemoryAction =
  | { type: "sample"; key: string; live: MemoryLive }
  | { type: "layout"; key: string; layout: MemoryLayout }
  | { type: "select"; row: string };

/** The resource sample that describes the summary's process. */
export function memoryResources(
  m: MemorySummary | undefined,
  r: Resources | undefined,
  session: string | null | undefined,
) {
  return r?.available && !r.stale && r.pid === m?.pid && r.session === session
    ? r
    : null;
}

/** Everything the section draws, derived from the state. */
export function memoryModel(state: MemoryState) {
  const m = state.live?.summary;
  const layout = m ? layoutFor(m, state.layout) : null;
  const current = m
    ? currentLayout(m, state.layout, state.live?.session)
    : null;
  const regions = memoryRegions(layout, state.live?.comm);
  const rows = memoryRows(regions);
  const bars = rows.filter(isBar);
  const selected = bars.find((row) => row.key === state.selected) ?? null;
  return { m, layout, complete: !!current, regions, rows, bars, selected };
}

// Live history for the zoom charts and growth facts. fresh: the regions
// are the layout the summary names. While a newer layout is still loading,
// the heap is left unknown and filled in when it arrives, so the heap chart
// is not one layout behind.
function recordMemory(
  history: readonly MemoryPoint[],
  m: MemorySummary,
  regions: readonly ClassifiedRegion[],
  fresh: boolean,
  resources: Resources | null,
): readonly MemoryPoint[] {
  if (!isNum(m.updated)) return history;
  fresh = fresh && !m.stale;
  const heap = fresh ? regions.find((region) => region.cat === "heap") : null,
    stack = fresh ? regions.find((region) => region.cat === "stack") : null;
  const mapping = {
    heap: heap?.size ?? null,
    stack: stack?.size ?? null,
    heapEnd: heap?.hi ?? null,
    stackStart: stack?.lo ?? null,
  };
  const r = m.stale ? null : resources,
    last = history.at(-1);
  if (last?.t === m.updated) {
    // The resource sample may arrive after the first memory sample.
    const next = {
      ...last,
      ...(fresh ? mapping : {}),
      rss: isNum(last.rss) ? last.rss : (r?.memory?.rss ?? null),
      anon: isNum(last.anon) ? last.anon : (r?.memory?.anon ?? null),
    };
    const same = (Object.keys(next) as (keyof MemoryPoint)[]).every(
      (key) => next[key] === last[key],
    );
    return same ? history : [...history.slice(0, -1), next];
  }
  const t = m.updated;
  return [
    ...history,
    {
      t,
      ...mapping,
      mf: m.stale ? null : (m.values?.major_faults ?? null),
      rss: r?.memory?.rss ?? null,
      anon: r?.memory?.anon ?? null,
    },
  ].filter((point) => point.t >= t - BUFFER_SECS);
}

// Keep the heap grid stable until the selection leaves its bounded span.
// While coverage is unavailable the margin is hidden, but its bounds stay
// for the same heap when the next complete layout arrives.
function nextHeapSpan(
  span: HeapSpan | null,
  row: MemoryBar | null,
  page: number | null,
  complete: boolean,
): HeapSpan | null {
  if (row?.cat !== "heap") return null;
  if (!complete) return span;
  if (
    span?.key === row.key &&
    row.lo >= span.lo &&
    row.hi <= span.hi &&
    span.hi - row.hi <= HEAP_MARGIN_LIMIT
  )
    return span;
  const unit = page || 1,
    margin = BigInt(
      Math.min(
        Number(HEAP_MARGIN_LIMIT),
        Math.max(65536, Math.ceil(row.size / 4 / unit) * unit),
      ),
    );
  return { key: row.key, lo: row.lo, hi: row.hi + margin };
}
/** The address range the zoom grid covers. */
export const displaySpan = (
  row: MemoryBar,
  span: HeapSpan | null,
  complete: boolean,
) =>
  row.cat === "heap" && complete && span?.key === row.key
    ? span
    : { lo: row.lo, hi: row.hi };

const defaultBar = (bars: readonly MemoryBar[]) =>
  (
    bars.find((row) => row.cat === "heap") ??
    bars.reduce<MemoryBar | null>(
      (best, row) => (row.size > (best?.size ?? 0) ? row : best),
      null,
    )
  )?.key ?? null;

// Brings the derived parts of the state up to date with its inputs.
function settle(state: MemoryState): MemoryState {
  const live = state.live,
    m = live?.summary;
  if (!live || !m?.available) return state;
  const model = memoryModel(state);
  const page = live.resources?.limits?.page_size;
  const learned =
    Number.isSafeInteger(page) && isNum(page) && page > 0 ? page : state.page;
  // With no bars the selection goes, so the next layout opens on the default.
  const selected = !model.bars.length
    ? null
    : model.selected
      ? state.selected
      : defaultBar(model.bars);
  const row = model.bars.find((item) => item.key === selected) ?? null;
  return {
    ...state,
    page: learned,
    selected,
    history: recordMemory(
      state.history,
      m,
      model.regions,
      model.complete,
      live.resources,
    ),
    heapSpan: nextHeapSpan(state.heapSpan, row, learned, model.complete),
  };
}

export function memoryReducer(
  state: MemoryState,
  action: MemoryAction,
): MemoryState {
  switch (action.type) {
    case "sample": {
      const base =
        action.key === state.key
          ? state
          : { ...initialMemory, key: action.key };
      return settle({ ...base, live: action.live });
    }
    case "layout": {
      const m = state.live?.summary,
        layout = action.layout,
        old = state.layout;
      if (
        action.key !== state.key ||
        !m ||
        !layout.available ||
        layout.id === old?.id ||
        !layoutFor(m, layout)
      )
        return state;
      const previous =
        old &&
        old.pid === layout.pid &&
        sessionOf(old.id) === sessionOf(layout.id)
          ? old
          : null;
      return settle({ ...state, layout, previous });
    }
    case "select":
      return settle({ ...state, selected: action.row });
  }
}

// ---------- Zoom ----------
export function memoryLargestGap(
  row: Pick<MemoryBar, "lo" | "hi" | "members">,
) {
  let cursor = row.lo,
    largest = 0n;
  for (const region of [...row.members].sort((a, b) =>
    a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0,
  )) {
    const lo = region.lo > row.lo ? region.lo : row.lo,
      hi = region.hi < row.hi ? region.hi : row.hi;
    if (hi <= lo) continue;
    if (lo > cursor && lo - cursor > largest) largest = lo - cursor;
    if (hi > cursor) cursor = hi;
  }
  return row.hi - cursor > largest ? row.hi - cursor : largest;
}

export type GridCell =
  | { kind: "pad" }
  | { kind: "none" | "unknown"; label: string }
  | {
      kind: "region";
      cat: string;
      isNew: boolean;
      name: string;
      address: string;
    };
export interface LegendItem {
  label: string;
  className: string;
  color?: string;
}
// At most 512 squares of whole pages, high addresses on the top row.
export function memoryGrid(
  row: MemoryBar,
  display: { lo: bigint; hi: bigint },
  regions: readonly ClassifiedRegion[],
  previous: MemoryLayout | null,
  complete: boolean,
  page: number | null,
) {
  const gridSpan = Number(display.hi - display.lo),
    margin = display.hi > row.hi || display.lo < row.lo;
  const unit = page || 1,
    cell = Math.max(unit, Math.ceil(gridSpan / GRID_SQUARES / unit) * unit),
    count = Math.ceil(gridSpan / cell),
    lines = Math.ceil(count / GRID_COLUMNS);
  const overlaps = (region: ClassifiedRegion) =>
    region.hi > display.lo && region.lo < display.hi;
  const offset = (region: ClassifiedRegion) =>
    [Number(region.lo - display.lo), Number(region.hi - display.lo)] as const;
  const members = (margin ? regions.filter(overlaps) : row.members).map(
    (region) => [region, ...offset(region)] as const,
  );
  const before =
    complete && layoutComplete(previous)
      ? memoryRegions(previous).filter(overlaps).map(offset)
      : null;
  const cells: GridCell[] = [],
    legend = new Map<string, LegendItem>();
  for (let line = lines - 1; line >= 0; line--)
    for (let column = 0; column < GRID_COLUMNS; column++) {
      const index = line * GRID_COLUMNS + column;
      if (index >= count) {
        cells.push({ kind: "pad" });
        continue;
      }
      const from = index * cell,
        to = Math.min(gridSpan, from + cell);
      let best: ClassifiedRegion | null = null,
        covered = 0;
      for (const [region, lo, hi] of members) {
        const overlap = Math.min(hi, to) - Math.max(lo, from);
        if (overlap > covered) {
          covered = overlap;
          best = region;
        }
      }
      if (!best) {
        const kind = complete ? "none" : "unknown",
          label = complete ? "not mapped" : "unknown coverage";
        cells.push({ kind, label });
        legend.set(kind, { label, className: `cell-${kind}` });
        continue;
      }
      const cat = catOf(best);
      legend.set(
        kindLabel(cat),
        cat === "guard"
          ? { label: kindLabel(cat), className: "cell-guard" }
          : { label: kindLabel(cat), className: "", color: kindColor(cat) },
      );
      const isNew =
        !!before && !before.some(([lo, hi]) => lo < to && hi > from);
      if (isNew)
        legend.set("new", {
          label: "mapped since the previous layout",
          className: "cell-new",
          color: "var(--raised)",
        });
      cells.push({
        kind: "region",
        cat,
        isNew,
        name: `${memoryRegionName(best) || cat} · ${best.permissions}`,
        address: hex(display.lo + BigInt(from)),
      });
    }
  const caption = `Top = high address. One square = ${
    page
      ? `${memoryBytes(cell)} (${String(cell / page)} page${cell === page ? "" : "s"})`
      : `${String(cell)} bytes`
  }, ${String(count)} squares.${complete ? "" : " Uncovered cells are unknown: layout incomplete, stale, or historical."}`;
  return {
    cells,
    legend: [...legend.values()],
    caption,
    margin: margin
      ? ` · heap mapping end ${hex(row.hi)} · grid ${hex(display.lo)} – ${hex(display.hi)}`
      : null,
  };
}

/** Change of a mapping's size over the history, as zoom fact text. */
export function memoryGrowth(
  history: readonly MemoryPoint[],
  key: "heap" | "stack",
  complete: boolean,
) {
  if (!complete || !isNum(history.at(-1)?.[key])) return "Unavailable";
  const points = history.filter((point) => isNum(point[key]));
  const first = points[0],
    last = points.at(-1);
  return first && last && points.length >= 2
    ? `${signed((last[key] ?? 0) - (first[key] ?? 0))} in ${duration(last.t - first.t)}`
    : "Collecting…";
}

/** A mapping boundary as an offset from its first known address. */
export function boundaryPoints(
  history: readonly MemoryPoint[],
  key: "heapEnd" | "stackStart",
) {
  const base = history.find((point) => point[key] !== null)?.[key];
  return history.map((point) => {
    const value = point[key];
    const offset =
      value !== null && base !== null && base !== undefined
        ? Number(value - base)
        : null;
    return {
      t: point.t,
      value: Number.isSafeInteger(offset) ? offset : null,
    };
  });
}

/** Change per minute: the least-squares line, so one odd sample at either end does not decide it. */
export function slopePerMinute(
  points: readonly { t: number; value: number | null }[],
) {
  const values = points.filter((point): point is { t: number; value: number } =>
    isNum(point.value),
  );
  if (values.length < 2) return null;
  const mean = (list: readonly number[]) =>
      list.reduce((sum, value) => sum + value, 0) / list.length,
    t0 = mean(values.map((point) => point.t)),
    v0 = mean(values.map((point) => point.value));
  let covariance = 0,
    variance = 0;
  for (const point of values) {
    covariance += (point.t - t0) * (point.value - v0);
    variance += (point.t - t0) ** 2;
  }
  return variance > 0 ? (60 * covariance) / variance : null;
}

/**
 * Polylines of a small chart scaled from the lowest to the highest value,
 * so steps of a page stay visible. Steps, not slopes: a value holds until
 * the next sample. A missing sample ends a run; a run of one sample is a
 * dot. Null with fewer than two values.
 */
export function stepLines(
  points: readonly { t: number; value: number | null }[],
  width = 300,
  height = 84,
) {
  const values = points.filter((point): point is { t: number; value: number } =>
    isNum(point.value),
  );
  const first = values[0],
    last = values.at(-1);
  if (!first || !last || values.length < 2) return null;
  const t0 = first.t,
    t1 = last.t,
    low = Math.min(...values.map((point) => point.value)),
    high = Math.max(...values.map((point) => point.value)),
    range = high - low || 1;
  const x = (t: number) =>
      ((t1 > t0 ? (t - t0) / (t1 - t0) : 0) * width).toFixed(1),
    y = (value: number) =>
      (high === low
        ? height / 2
        : height - 10 - ((value - low) / range) * (height - 26)
      ).toFixed(1);
  const lines: { points: string; dot: boolean }[] = [];
  let path = "",
    previous: number | null = null,
    run = 0;
  const finish = () => {
    if (path)
      lines.push({
        points: run === 1 ? `${path} ${path}` : path,
        dot: run === 1,
      });
    path = "";
    previous = null;
    run = 0;
  };
  for (const point of points) {
    if (!isNum(point.value)) {
      finish();
      continue;
    }
    path +=
      previous !== null
        ? ` ${x(point.t)},${y(previous)} ${x(point.t)},${y(point.value)}`
        : `${x(point.t)},${y(point.value)}`;
    run++;
    previous = point.value;
  }
  finish();
  return { lines, first: first.value, last: last.value };
}

// ---------- Tiles ----------
export type MemoryTile = readonly [
  label: string,
  value: string,
  sub: string,
  bad: boolean,
];
/** The six summary tiles, in the old order. */
export function memoryTiles(
  m: MemorySummary,
  resources: Resources | undefined,
  trend: ReturnType<typeof rssTrend>,
  faults: number | null,
  points: readonly { t: number; mf: number | null }[],
  chosen: PressureScope,
): MemoryTile[] {
  const v = m.values ?? {},
    r = resources?.available ? resources : null,
    memory = r?.memory ?? {};
  const tiles: MemoryTile[] = [];
  const peak = memoryBytes(v.vm_peak_bytes);
  tiles.push([
    "Virtual size (VmSize)",
    memoryBytes(v.vm_size_bytes),
    isNum(v.address_space_limit_bytes) && v.address_space_limit_bytes > 0
      ? `limit ${memoryBytes(v.address_space_limit_bytes)} · peak ${peak}`
      : `limit: unlimited · peak ${peak}`,
    false,
  ]);
  const growth =
    trend?.slope ??
    (isNum(memory.rss_growth_per_s) ? 60 * memory.rss_growth_per_s : null);
  tiles.push([
    "Resident (RSS)",
    memoryBytes(memory.rss),
    isNum(growth) && Math.abs(growth) >= 2 ** 20
      ? `${growth > 0 ? "▲" : "▼"} ${memoryBytes(Math.abs(growth))} / min`
      : `peak ${memoryBytes(memory.peak)} · swap ${memoryBytes(memory.swap)}`,
    trend ? trend.steady : isNum(growth) && growth >= 2 ** 20,
  ]);
  const split = [memory.anon, memory.file, memory.shmem];
  const known = split.filter(isNum);
  if (known.length) {
    const largest = Math.max(...known),
      [unit, size] =
        largest >= 2 ** 30
          ? (["GiB", 2 ** 30] as const)
          : largest >= 2 ** 20
            ? (["MiB", 2 ** 20] as const)
            : (["KiB", 2 ** 10] as const);
    tiles.push([
      "Anonymous / file / shared",
      split
        .map((value) =>
          isNum(value) ? num(value / size, value / size >= 10 ? 0 : 1) : "—",
        )
        .join(" / "),
      `${unit}: RssAnon / File / Shmem`,
      false,
    ]);
  } else
    tiles.push([
      "Anonymous / file / shared",
      "—",
      "needs resource samples",
      false,
    ]);
  const vmaShare =
    isNum(v.max_map_count) && v.max_map_count > 0 && isNum(v.vma_count)
      ? (100 * v.vma_count) / v.max_map_count
      : null;
  tiles.push([
    "Mappings (VMAs)",
    isNum(v.vma_count) ? v.vma_count.toLocaleString() : "—",
    isNum(vmaShare) ? `${pct(vmaShare)} of vm.max_map_count` : "limit unknown",
    isNum(vmaShare) && vmaShare >= 75,
  ]);
  // The thread samples' rate ten minutes ago, when they reach back that far.
  const lastT = points.at(-1)?.t ?? 0,
    before = points.find((point) => point.t >= lastT - 600);
  tiles.push([
    "Major faults",
    isNum(faults) ? num(faults) + " /s" : "—",
    isNum(faults) && before && isNum(before.mf) && lastT - before.t >= 300
      ? `was ${num(before.mf)} /s ${duration(lastT - before.t)} ago`
      : `${num(v.major_faults, 0)} since start`,
    isNum(faults) && faults >= 10,
  ]);
  const scope = r ? scopeOf(r, chosen) : chosen,
    pressure = r?.pressure?.[scope]?.memory,
    psi = pressure ? stall(pressure.some) : null,
    full = r ? stall(pressure?.full) : null;
  tiles.push([
    "Memory pressure (PSI some)",
    pct(psi),
    r ? `${scope} full ${pct(full)}` : "needs resource samples",
    isNum(psi) && psi >= 5,
  ]);
  return tiles;
}

/** The zoom's facts for the selected bar, in the old order. */
export function memoryZoomFacts(
  row: MemoryBar,
  m: MemorySummary,
  complete: boolean,
  history: readonly MemoryPoint[],
  page: number | null,
) {
  const v = m.values ?? {},
    span = Number(row.hi - row.lo);
  const facts: (readonly [label: string, value: string])[] = [
    ["Size (mapped)", memoryBytes(row.size)],
    ["Address span", memoryBytes(span)],
    ["Regions / VMAs", `${String(row.members.length)} / ${String(row.vmas)}`],
    [
      "Share of VmSize",
      isNum(v.vm_size_bytes) && v.vm_size_bytes > 0
        ? pct((100 * row.size) / v.vm_size_bytes)
        : "—",
    ],
    [
      "Not mapped inside",
      complete ? memoryBytes(span - row.size) : "Unavailable",
    ],
    [
      "Largest unmapped gap",
      complete ? memoryBytes(Number(memoryLargestGap(row))) : "Unavailable",
    ],
    [
      "Largest region",
      memoryBytes(Math.max(...row.members.map((region) => region.size))),
    ],
  ];
  if (row.cat === "heap" || row.cat === "stack")
    facts.push([
      row.cat === "heap"
        ? "Heap mapping size change"
        : "Stack mapping size change",
      memoryGrowth(history, row.cat, complete),
    ]);
  facts.push(["Page size", page ? memoryBytes(page) : "Unknown"]);
  return facts;
}

// ---------- Address map ----------
export type MapItem =
  | { gap: true; text: string }
  | {
      gap: false;
      bar: MemoryBar;
      address: string;
      name: string;
      meta: string;
      /** Bar height in px, and the darker band's width in %. */
      height: number;
      band: string;
      color: string;
      onDark: boolean;
      range: string;
      members: string;
    };
// The darker part of a bar is its size on a log scale, from 4 KB to the
// largest bar.
export function memoryMapItems(rows: readonly MemoryRow[]): MapItem[] {
  const bars = rows.filter(isBar);
  const largest = Math.log2(Math.max(...bars.map((row) => row.size))),
    scale = (size: number) =>
      Math.max(
        0,
        Math.min(
          1,
          (Math.log2(Math.max(size, 4096)) - 12) / Math.max(1, largest - 12),
        ),
      );
  return rows.map((row) => {
    if (!isBar(row))
      return {
        gap: true,
        text:
          row.gap >= 2 ** 52
            ? "kernel half of the address space"
            : `≈ ${memoryBytes(row.gap)} not mapped`,
      };
    const [color, onDark] = MEMORY_KINDS[row.cat] ?? ["var(--k-anon)", false];
    return {
      gap: false,
      bar: row,
      address: row.lo.toString(16),
      name: memoryRowName(row),
      meta: `${memoryPerms(row)} · ${memoryBytes(row.size)}${memoryGrows(row.cat)}`,
      height: Math.round(24 + 20 * scale(row.size)),
      band: (100 * scale(row.size)).toFixed(1) + "%",
      color,
      onDark,
      range: `${hex(row.lo)} – ${hex(row.hi)}`,
      members: `${String(row.members.length)} region(s), ${String(row.vmas)} VMAs`,
    };
  });
}

// ---------- Section text ----------
export function memorySubtitle(m: MemorySummary, now: number) {
  const age = ago(now - (m.updated ?? 0));
  return `The target's virtual address space: how much is mapped, how close it is to its limits, and what each region holds. Sampled every ${num(m.interval_s, 0)} s; the longest maps read took ${microseconds(m.values?.maps_read_max_us)}. ${m.stale ? "Stale: no sample since " + age + "." : "Updated " + age + "."}`;
}
export interface MeterSpec {
  label: string;
  sub: string;
  value: number | null | undefined;
  max: number | null | undefined;
  text: string;
}
/** The limits card's meters; the main stack only when the layout has one. */
export function memoryLimits(
  m: MemorySummary,
  stack: ClassifiedRegion | undefined,
): MeterSpec[] {
  const v = m.values ?? {};
  const meters: MeterSpec[] = [
    {
      label: "Mappings",
      sub: "vm.max_map_count",
      value: v.vma_count,
      max: v.max_map_count,
      text:
        isNum(v.vma_count) && isNum(v.max_map_count)
          ? `${String(v.vma_count)} / ${String(v.max_map_count)}`
          : "—",
    },
    isNum(v.address_space_limit_bytes)
      ? {
          label: "Address space",
          sub: "RLIMIT_AS",
          value: v.vm_size_bytes,
          max: v.address_space_limit_bytes,
          text: `${memoryBytes(v.vm_size_bytes)} / ${memoryBytes(v.address_space_limit_bytes)}`,
        }
      : {
          label: "Address space",
          sub: "no RLIMIT_AS limit",
          value: null,
          max: 0,
          text: memoryBytes(v.vm_size_bytes),
        },
  ];
  if (stack)
    meters.push(
      isNum(v.stack_limit_bytes)
        ? {
            label: "Main stack",
            sub: "RLIMIT_STACK; the [stack] mapping",
            value: stack.size,
            max: v.stack_limit_bytes,
            text: `${memoryBytes(stack.size)} / ${memoryBytes(v.stack_limit_bytes)}`,
          }
        : {
            label: "Main stack",
            sub: "no RLIMIT_STACK limit",
            value: null,
            max: 0,
            text: memoryBytes(stack.size),
          },
    );
  return meters;
}
export function memoryFacts(m: MemorySummary) {
  const v = m.values ?? {};
  return [
    ["Peak virtual size", memoryBytes(v.vm_peak_bytes)],
    ["Data + heap (VmData)", memoryBytes(v.vm_data_bytes)],
    ["Page tables", memoryBytes(v.vm_pte_bytes)],
    ["Locked", memoryBytes(v.vm_locked_bytes)],
    [
      "Page faults since start",
      `${num(v.major_faults, 0)} major · ${num(v.minor_faults, 0)} minor`,
    ],
    [
      "Longest maps read",
      `${microseconds(v.maps_read_max_us)} (${String(v.maps_reads ?? "—")} reads, ${microseconds(v.maps_read_us)} total)`,
    ],
  ] as const;
}
export function memoryNotes(
  m: MemorySummary,
  layout: MemoryLayout | null,
  regionCount: number,
) {
  const notes: string[] = [];
  if (m.flags?.maps_hidden)
    notes.push(
      "The sampler cannot read /proc/PID/maps: run it as the target's user. The target may also be non-dumpable.",
    );
  if (m.flags?.maps_partial)
    notes.push(
      "The last read of /proc/PID/maps stopped early, for example because the target exited.",
    );
  if (layout?.flags?.regions_truncated)
    notes.push(
      `Only the first ${String(regionCount)} regions are shown; the rest are counted in the mapping total.`,
    );
  return notes.join(" ");
}

// ---------- Zoom charts ----------
export type MemoryChart = {
  title: "Heap mapping end ↑" | "Main stack start ↓" | "Resident anonymous";
  color: string;
  /** Change per minute, or "" when unknown. */
  trend: string;
} & (
  | { empty: string }
  | { lines: { points: string; dot: boolean }[]; range: string }
);
/** The boundary charts follow the current layout; residency does not. */
export function memoryCharts(
  history: readonly MemoryPoint[],
  complete: boolean,
): MemoryChart[] {
  const chart = (
    title: MemoryChart["title"],
    points: readonly { t: number; value: number | null }[],
    color: string,
    offset: boolean,
    available: boolean,
  ): MemoryChart => {
    const slope = available ? slopePerMinute(points) : null,
      trend = isNum(slope) ? `${signed(slope)} / min` : "",
      lines = available ? stepLines(points) : null;
    if (!lines)
      return {
        title,
        color,
        trend,
        empty: !available
          ? "Unavailable"
          : points.length >= 2 && !points.some((point) => isNum(point.value))
            ? "Not in the layout"
            : "Collecting…",
      };
    const format = offset ? signed : memoryBytes;
    return {
      title,
      color,
      trend,
      lines: lines.lines,
      range: `${offset ? "Offset: " : ""}${format(lines.first)} → ${format(lines.last)}`,
    };
  };
  return [
    chart(
      "Heap mapping end ↑",
      boundaryPoints(history, "heapEnd"),
      "var(--k-heap)",
      true,
      complete,
    ),
    chart(
      "Main stack start ↓",
      boundaryPoints(history, "stackStart"),
      "var(--k-stack)",
      true,
      complete,
    ),
    chart(
      "Resident anonymous",
      history.map((point) => ({ t: point.t, value: point.anon })),
      "var(--k-anon)",
      false,
      true,
    ),
  ];
}

/** The member regions table: at most 300 rows. */
export const memoryRegionRows = (row: MemoryBar) =>
  row.members.slice(0, 300).map((region) => ({
    key: region.start,
    name: memoryRegionName(region) || catOf(region),
    path: region.name,
    start: region.start,
    size: memoryBytes(region.size),
    permissions: region.permissions,
    vmas: String(region.vmas),
  }));
export const memoryRegionCount = (
  layout: MemoryLayout | null,
  count: number,
  now: number,
) =>
  layout
    ? `${String(count)} regions · updated ${ago(now - (layout.updated ?? 0))}`
    : "";
