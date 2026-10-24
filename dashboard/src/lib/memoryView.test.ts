// Ported from 777cf3a:tests/dashboard_test.js (old start lines in names).
import { expect, test } from "vitest";
import type {
  MemoryLayout,
  MemoryRegion,
  MemorySummary,
  Resources,
} from "../api/types";
import { memoryFaultRate } from "./assess/index";
import { memoryRegions } from "./assess/memory";
import { point } from "./assess/test-input";
import { memoryBytes } from "./format";
import {
  MEMORY_KINDS,
  MEMORY_KIND_LABELS,
  boundaryPoints,
  displaySpan,
  initialMemory,
  isBar,
  memoryGrid,
  memoryGrowth,
  memoryLargestGap,
  memoryModel,
  memoryReducer,
  memoryResources,
  memoryRowName,
  memoryRows,
  memoryZoomFacts,
  stepLines,
  type MemoryAction,
  type MemoryBar,
  type MemoryLive,
  type MemoryState,
} from "./memoryView";
import { emptySeries } from "./series";

const hex = (value: bigint | number) => "0x" + value.toString(16);
const region = (
  start: bigint | number,
  size: number,
  kind: string,
  permissions = "rw-p",
  name = "",
): MemoryRegion => ({
  start: hex(start),
  end: hex(BigInt(start) + BigInt(size)),
  size,
  vmas: 1,
  kind,
  permissions,
  name,
});
const layout = (
  id: string,
  regions: readonly MemoryRegion[],
  extra: Partial<MemoryLayout> = {},
): MemoryLayout => ({
  available: true,
  id,
  pid: 1,
  updated: 10,
  regions,
  ...extra,
});
const KEY = "t|s|1";
const live = (
  summary: Partial<MemorySummary> = {},
  extra: Partial<MemoryLive> = {},
): MemoryLive => ({
  summary: {
    available: true,
    pid: 1,
    updated: 10,
    interval_s: 30,
    layout_id: "s:1",
    values: {},
    ...summary,
  },
  session: "s",
  comm: undefined,
  resources: null,
  ...extra,
});
const sample = (
  summary: Partial<MemorySummary> = {},
  extra: Partial<MemoryLive> = {},
  key = KEY,
): MemoryAction => ({ type: "sample", key, live: live(summary, extra) });
const arrive = (value: MemoryLayout, key = KEY): MemoryAction => ({
  type: "layout",
  key,
  layout: value,
});
const run = (state: MemoryState, ...actions: MemoryAction[]) =>
  actions.reduce(memoryReducer, state);
const HEAP = region(0x100000, 1048576, "heap");
// Old loadMemoryZoom: one 1 MiB heap, layout s:1, summary at t=10.
const loaded = (regions: readonly MemoryRegion[] = [HEAP]) =>
  run(initialMemory, sample(), arrive(layout("s:1", regions)));
function zoom(state: MemoryState) {
  const model = memoryModel(state);
  const row = model.selected;
  if (!row || !model.m) throw new Error("no selection");
  return {
    model,
    row,
    facts: memoryZoomFacts(
      row,
      model.m,
      model.complete,
      state.history,
      state.page,
    ).map(([, value]) => value),
    display: displaySpan(row, state.heapSpan, model.complete),
  };
}
const grid = (state: MemoryState) => {
  const { model, row, display } = zoom(state);
  return memoryGrid(
    row,
    display,
    model.regions,
    state.previous,
    model.complete,
    state.page,
  );
};

test("1620 memory map rows join neighbours, shorten gaps and stay few", () => {
  const regions: MemoryRegion[] = [
    region(0x555500000000, 0x200000, "file", "r-xp", "/usr/bin/app"),
    region(0x555500400000, 0x800000, "heap"),
    region(0x7f0000000000, 0x100000, "file", "r-xp", "/usr/lib/libc.so.6"),
    region(0x7f0000100000, 0x1000, "anonymous"),
    region(0x7f0000101000, 0x100000, "file", "r-xp", "/usr/lib/libm.so.6"),
    region(0x7ffc00000000, 0x21000, "stack"),
    // Above 2^53: the addresses must not lose precision.
    {
      start: "0xffffffffff600000",
      end: "0xffffffffff601000",
      size: 0x1000,
      vmas: 1,
      kind: "kernel",
      permissions: "--xp",
      name: "[vsyscall]",
    },
  ];
  const rows = memoryRows(memoryRegions(layout("s:1", regions), "app")).map(
    (row) => (isBar(row) ? memoryRowName(row) : "gap"),
  );
  expect(rows).toEqual([
    "[vsyscall]",
    "gap",
    "[stack]",
    "gap",
    "libc, libm (2 libraries)",
    "gap",
    "[heap]",
    "app (program image)",
  ]);
  // Hundreds of small anonymous runs between gaps merge down to the cap.
  const many = Array.from({ length: 300 }, (_, index) =>
    region(
      0x100000000000 + index * 0x80000000,
      0x100000,
      index % 2 ? "file" : "anonymous",
      "rw-p",
      index % 2 ? "/data/f" + String(index) : "[anon:gc]",
    ),
  );
  const bars = memoryRows(memoryRegions(layout("s:1", many))).filter(isBar);
  expect(bars.length).toBeGreaterThan(1);
  expect(bars.length).toBeLessThanOrEqual(18);
});

test("1661 memory history follows the layout the summary names and the sampler session", () => {
  const heap = (size: number) => [region(0x1000000, size, "heap")];
  const summary = { updated: 1, values: { major_faults: 10 } };
  // The summary names a layout that is still loading: the heap waits for it.
  let state = run(
    initialMemory,
    sample({ ...summary, layout_id: "a:1", updated: 0 }, { session: "a" }),
    arrive(layout("a:1", heap(1 << 20))),
    sample({ ...summary, layout_id: "a:2" }, { session: "a" }),
  );
  const at1 = () => state.history.filter((item) => item.t === 1);
  expect(at1().at(-1)?.heap).toBeNull();
  state = run(state, arrive(layout("a:2", heap(2 << 20))));
  expect(at1().length).toBe(1);
  expect(at1().at(-1)?.heap).toBe(2 << 20);
  // The same PID in a new sampler session starts a new history.
  state = run(
    state,
    sample(
      { ...summary, updated: 2, layout_id: null },
      { session: "b" },
      "t|b|1",
    ),
  );
  expect(state.history.length).toBe(1);
});

test("1677 memory history backfills resident bytes from a later resource sample", () => {
  const first = run(initialMemory, sample({ updated: 5, layout_id: null }));
  expect(first.history.at(-1)?.anon).toBeNull();
  const resources: Resources = {
    available: true,
    session: "s",
    pid: 1,
    memory: { rss: 300, anon: 200 },
  };
  const state = run(
    first,
    sample({ updated: 5, layout_id: null }, { resources }),
  );
  expect(state.history.length).toBe(1);
  expect(state.history.at(-1)?.anon).toBe(200);
  expect(state.history.at(-1)?.rss).toBe(300);
});

test("1688 memory fault rate uses the recording in replay and never live history", () => {
  const memoryHistory = [
    { t: 1, mf: 0 },
    { t: 2, mf: 0 },
  ];
  const recorded = { kind: "recorded" } as const;
  const series = (mf: number | null) => ({
    ...emptySeries,
    points: [point(100, 0, { mf })],
  });
  expect(
    memoryFaultRate({ series: series(200), mode: recorded, memoryHistory }),
  ).toBe(200);
  expect(
    memoryFaultRate({ series: series(null), mode: recorded, memoryHistory }),
  ).toBeNull();
  // Live, a counter that went down (another process) gives no rate.
  expect(
    memoryFaultRate({
      series: emptySeries,
      mode: { kind: "live" },
      memoryHistory: [
        { t: 1, mf: 50 },
        { t: 2, mf: 10 },
      ],
    }),
  ).toBeNull();
  expect(
    memoryFaultRate({
      series: emptySeries,
      mode: { kind: "live" },
      memoryHistory: [
        { t: 1, mf: 10 },
        { t: 3, mf: 50 },
      ],
    }),
  ).toBe(20);
});

test("2066 zoom legend names every kind shown in the grid, in the grid colors", () => {
  expect(Object.keys(MEMORY_KINDS).sort()).toEqual([
    "anonymous",
    "code",
    "file",
    "guard",
    "heap",
    "kernel",
    "library",
    "stack",
  ]);
  // Two 8 KB regions with an unmapped page between them, so every zoom also
  // has a "not mapped" square.
  for (const cat of Object.keys(MEMORY_KINDS)) {
    const member = (lo: bigint, hi: bigint) => ({
      ...region(lo, Number(hi - lo), cat),
      lo,
      hi,
      cat,
    });
    const members = [member(0x10000n, 0x12000n), member(0x13000n, 0x15000n)];
    const row: MemoryBar = {
      key: cat,
      cat,
      vmas: 2,
      size: 16384,
      lo: 0x10000n,
      hi: 0x15000n,
      members,
    };
    const { legend } = memoryGrid(row, row, members, null, true, 4096);
    expect(legend.length).toBe(2);
    const mapped = legend.find((item) => item.label !== "not mapped");
    expect(mapped?.label).toBe(MEMORY_KIND_LABELS[cat]);
    if (cat === "guard") expect(mapped?.className).toBe("cell-guard");
    else expect(mapped?.color).toBe(MEMORY_KINDS[cat]?.[0]);
    expect(legend.find((item) => item.label === "not mapped")?.className).toBe(
      "cell-none",
    );
  }
  // Squares mapped since the previous layout add the marker entry;
  // unchanged layouts do not.
  const before = run(
    loaded([region(0x10000, 0x2000, "heap")]),
    sample({ layout_id: "s:2" }),
    arrive(layout("s:2", [region(0x10000, 0x4000, "heap")])),
  );
  expect(
    grid(before)
      .legend.map((item) => item.label)
      .sort(),
  ).toEqual(
    ["heap (brk)", "mapped since the previous layout", "not mapped"].sort(),
  );
  const unchanged = run(
    before,
    sample({ layout_id: "s:3" }),
    arrive(layout("s:3", [region(0x10000, 0x4000, "heap")])),
  );
  expect(grid(unchanged).legend.map((item) => item.label)).not.toContain(
    "mapped since the previous layout",
  );
});

test("2153 memory zoom uses target page size and omits unknown page counts", () => {
  const resources = (extra: Partial<Resources> = {}): Resources => ({
    available: true,
    session: "s",
    pid: 1,
    limits: { page_size: 4096 },
    ...extra,
  });
  const learn = (r: Resources) =>
    run(
      initialMemory,
      sample({}, { resources: memoryResources(live().summary, r, "s") }),
      arrive(layout("s:1", [region(0x100000, 4194304, "heap")])),
    );
  for (const page of [4096, 65536]) {
    const state = learn(resources({ limits: { page_size: page } }));
    expect(state.page).toBe(page);
    const { caption, cells } = grid(state);
    expect(caption).toMatch(/KiB.*pages?\)/);
    expect(
      cells.filter((cell) => cell.kind !== "pad").length,
    ).toBeLessThanOrEqual(512);
  }
  // Nothing learned yet for this process: the page size is unknown.
  for (const r of [
    resources({ limits: {} }),
    resources({ stale: true }),
    resources({ pid: 2 }),
    resources({ session: "old" }),
  ]) {
    const state = learn(r);
    expect(state.page).toBeNull();
    const { caption, cells } = grid(state);
    expect(caption).not.toMatch(/\(.*page|KiB/);
    expect(caption).toMatch(/One square = \d+ bytes,/);
    expect(
      cells.filter((cell) => cell.kind !== "pad").length,
    ).toBeLessThanOrEqual(512);
    expect(zoom(state).facts.at(-1)).toBe("Unknown");
  }
  // Once learned, a late or missing resource sample does not unset it.
  const learned = run(
    learn(resources()),
    sample({ updated: 40 }, { resources: null }),
  );
  expect(learned.page).toBe(4096);
  expect(zoom(learned).facts.at(-1)).toBe("4.0 KiB");
  // Another process starts unknown again.
  expect(run(learned, sample({ pid: 2 }, {}, "t|s|2")).page).toBeNull();
  expect(memoryBytes(2 ** 30)).toBe("1.0 GiB");
});

test("2186 memory growth refreshes unchanged layouts and rejects stale or other-target history", () => {
  let state = loaded();
  const growth = () =>
    memoryGrowth(state.history, "heap", memoryModel(state).complete);
  state = run(state, sample({ updated: 40 }));
  expect(growth()).toBe("0 B in 30 s");
  state = run(state, sample({ updated: 70 }));
  expect(growth()).toBe("0 B in 60 s");
  state = run(state, sample({ updated: 70, stale: true }));
  expect(growth()).toBe("Unavailable");
  state = run(state, sample({ updated: 70, layout_id: "s:2" }));
  expect(growth()).toBe("Unavailable");
  // Another sampler session: a new history, and no previous layout.
  const other = "t|other|1";
  state = run(
    state,
    sample({ layout_id: "other:1" }, { session: "other" }, other),
    arrive(layout("other:1", [HEAP]), other),
  );
  expect(state.history.length).toBe(1);
  expect(growth()).toBe("Collecting…");
  expect(state.previous).toBeNull();
  // Another PID in the same session.
  state = run(
    state,
    sample({ pid: 2, layout_id: "other:2" }, { session: "other" }, "t|other|2"),
  );
  expect(state.history.length).toBe(1);
});

test("2204 largest unmapped gap clips and merges exact high-address ranges", () => {
  const base = 2n ** 60n;
  const span = (lo: bigint, hi: bigint) => ({
    ...region(lo, Number(hi - lo), "heap"),
    lo,
    hi,
  });
  const row = {
    lo: base,
    hi: base + 100n,
    members: [
      span(base + 80n, base + 110n),
      span(base + 30n, base + 50n),
      span(base - 10n, base + 10n),
      span(base + 40n, base + 60n),
    ],
  };
  expect(memoryLargestGap(row)).toBe(20n);
  expect(
    memoryLargestGap({
      ...row,
      members: [...row.members, span(base, base + 100n)],
    }),
  ).toBe(0n);
  expect(memoryLargestGap({ ...row, members: [] })).toBe(100n);
});

test("2216 incomplete memory layouts cannot claim unmapped gaps or new mappings", () => {
  const regions = [HEAP, region(0x300000, 1048576, "heap")];
  const facts = (state: MemoryState) => {
    const model = memoryModel(state);
    const members = model.regions;
    const row: MemoryBar = {
      key: "heap",
      cat: "heap",
      lo: 0x100000n,
      hi: 0x400000n,
      size: 2097152,
      vmas: 2,
      members,
    };
    if (!model.m) throw new Error("no summary");
    return {
      facts: memoryZoomFacts(
        row,
        model.m,
        model.complete,
        state.history,
        null,
      ).map(([, value]) => value),
      cells: memoryGrid(row, row, members, null, model.complete, null).cells,
    };
  };
  const complete = facts(loaded(regions));
  expect(complete.facts).toContain("1.0 MiB");
  expect(complete.cells.some((cell) => cell.kind === "none")).toBe(true);
  for (const flag of ["maps_partial", "maps_hidden", "regions_truncated"]) {
    const { facts: values, cells } = facts(
      run(loaded(regions), sample({ flags: { [flag]: true } })),
    );
    expect(values).toContain("Unavailable");
    expect(cells.some((cell) => cell.kind === "unknown")).toBe(true);
    expect(cells.some((cell) => cell.kind === "none")).toBe(false);
  }
  const truncated = run(
    initialMemory,
    sample(),
    arrive(layout("s:1", regions, { flags: { regions_truncated: true } })),
  );
  expect(facts(truncated).facts).toContain("Unavailable");
});

test("2232 memory boundary charts preserve high-address steps and missing samples", () => {
  const high = 2n ** 60n;
  const at = (heapHi: bigint, stackLo: bigint) => [
    region(stackLo, Number(high + 69632n - stackLo), "stack"),
    region(high, Number(heapHi - high), "heap"),
  ];
  let state = run(
    initialMemory,
    sample({ updated: 10 }),
    arrive(layout("s:1", at(high + 4096n, high + 65536n))),
    sample({ updated: 40, layout_id: "s:2" }),
    arrive(layout("s:2", at(high + 8192n, high + 61440n))),
    sample({ updated: 70, layout_id: "s:2" }),
    // The summary names a layout that never arrives.
    sample({ updated: 100, layout_id: "s:3" }),
    sample({ updated: 130, layout_id: "s:4" }),
    arrive(layout("s:4", at(high + 4096n, high + 61440n))),
  );
  const offsets = (key: "heapEnd" | "stackStart") =>
    boundaryPoints(state.history, key).map((item) => item.value);
  expect(offsets("heapEnd")).toEqual([0, 4096, 4096, null, 0]);
  expect(offsets("stackStart")).toEqual([0, -4096, -4096, null, -4096]);
  // The missing sample splits the two valid runs.
  const chart = stepLines(boundaryPoints(state.history, "heapEnd"));
  expect(chart?.lines.length).toBe(2);
  expect([chart?.first, chart?.last]).toEqual([0, 0]);
  state = run(
    state,
    sample({ updated: 160, layout_id: "new:1" }, { session: "new" }, "t|new|1"),
    arrive(layout("new:1", at(high + 4096n, high + 61440n)), "t|new|1"),
  );
  expect(offsets("heapEnd")).toEqual([0]);
});

test("2252 heap margin survives layout replacement and a pending layout fetch", () => {
  let state = loaded();
  const before = state.heapSpan?.hi;
  const count = grid(state).cells.length;
  // A new layout ID arrives before its maps response. Coverage is unknown
  // during that poll, but it must not discard the selected heap's span.
  state = run(state, sample({ layout_id: "s:2", updated: 11 }));
  expect(state.heapSpan?.hi).toBe(before);
  state = run(
    state,
    arrive(layout("s:2", [{ ...HEAP, end: "0x201000", size: 1052672 }])),
  );
  expect(state.heapSpan?.hi).toBe(before);
  expect(grid(state).cells.length).toBe(count);
  expect(zoom(state).facts).toContain("1.0 MiB");
  // A command name update also rebuilds the map without changing selection.
  state = run(
    state,
    sample({ layout_id: "s:2", updated: 11 }, { comm: "renamed" }),
  );
  expect(state.heapSpan?.hi).toBe(before);
  // Growth beyond the retained margin creates a new bounded span.
  state = run(
    state,
    sample({ layout_id: "s:3", updated: 12 }),
    arrive(layout("s:3", [{ ...HEAP, end: "0x241000", size: 1314816 }])),
  );
  const hi = state.heapSpan?.hi ?? 0n;
  expect(hi > (before ?? 0n)).toBe(true);
  expect(hi - zoom(state).row.hi <= 1048576n).toBe(true);
  state = run(
    state,
    sample({ layout_id: null }, { session: "other" }, "t|other|1"),
  );
  expect(state.heapSpan).toBeNull();
});

test("2276 heap margin stays bounded and stable, includes neighbors, and resets on selection", () => {
  const stack = region(0x7ffc00000000, 0x21000, "stack");
  const neighbor = region(0x210000, 65536, "file", "rw-p", "/tmp/data");
  let state = loaded([stack, neighbor, HEAP]);
  const span = state.heapSpan;
  expect(span && span.hi - zoom(state).row.hi <= 1048576n).toBe(true);
  expect(grid(state).legend.map((item) => item.label)).toContain(
    "file mapping",
  );
  const before = span?.hi ?? 0n;
  const grow = (id: string, end: bigint) =>
    run(
      state,
      sample({ layout_id: id }),
      arrive(
        layout(id, [
          stack,
          neighbor,
          { ...HEAP, end: hex(end), size: Number(end - 0x100000n) },
        ]),
      ),
    );
  state = grow("s:2", 0x210000n);
  expect(state.heapSpan?.hi).toBe(before);
  state = grow("s:3", before + 65536n);
  expect((state.heapSpan?.hi ?? 0n) > before).toBe(true);
  // Another selection drops the heap span.
  state = run(state, { type: "select", row: "stack" });
  expect(state.heapSpan).toBeNull();
  // A stale sample hides the margin.
  state = run(
    state,
    { type: "select", row: "heap" },
    sample({ layout_id: "s:3", stale: true }),
  );
  const { row, display } = zoom(state);
  expect(display.hi).toBe(row.hi);
  expect(
    grid(state).cells.filter((cell) => cell.kind !== "pad").length,
  ).toBeLessThanOrEqual(512);
});

test("a new target, session or PID key leaves nothing of the earlier process", () => {
  const resources: Resources = {
    available: true,
    session: "s",
    pid: 1,
    limits: { page_size: 4096 },
    memory: { rss: 1, anon: 1 },
  };
  const full = run(
    loaded(),
    sample({ layout_id: "s:2", updated: 40 }, { resources }),
    arrive(layout("s:2", [{ ...HEAP, end: "0x210000", size: 1114112 }])),
  );
  expect([
    full.layout?.id,
    full.previous?.id,
    full.history.length,
    full.page,
    full.selected,
    full.heapSpan !== null,
  ]).toEqual(["s:2", "s:1", 2, 4096, "heap", true]);
  for (const key of ["u|s|1", "t|s2|1", "t|s|2"]) {
    const next = run(full, sample({ updated: 50, layout_id: null }, {}, key));
    expect(next).toEqual({
      ...initialMemory,
      key,
      live: live({ updated: 50, layout_id: null }),
      history: [
        {
          t: 50,
          heap: null,
          stack: null,
          heapEnd: null,
          stackStart: null,
          mf: null,
          rss: null,
          anon: null,
        },
      ],
    });
  }
});

test("a layout of another process or session, or for an old key, is rejected", () => {
  const state = run(initialMemory, sample({ layout_id: "s:1" }));
  for (const action of [
    arrive(layout("s:1", [HEAP], { pid: 2 })),
    arrive(layout("old:1", [HEAP])),
    arrive(layout("s:1", [HEAP]), "t|old|1"),
    arrive({ available: false }),
  ])
    expect(run(state, action)).toBe(state);
  expect(run(state, arrive(layout("s:1", [HEAP]))).layout?.id).toBe("s:1");
});
