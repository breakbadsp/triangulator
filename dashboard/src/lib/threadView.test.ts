import { expect, test } from "vitest";
import type { Thread } from "../api/types";
import { emptySeries, ingest } from "./series";
import { view } from "./test-fixtures";
import {
  chips,
  initialThreadView,
  threadRows,
  threadView,
  type ThreadAction,
} from "./threadView";

const thread = (tid: number, extra: Partial<Thread> = {}): Thread => ({
  tid,
  name: `worker-${String(tid)}`,
  generation: 1,
  group: "main",
  state: "futex",
  wchan: "futex_do_wait",
  state_mix: { futex: 20 },
  cpu_pct: 0,
  last_sample: 100,
  ...extra,
});
const apply = (...actions: ThreadAction[]) =>
  actions.reduce(threadView, initialThreadView);

test("a wait-channel bar shows every thread in it and a chip narrows by state", () => {
  const shown = apply(
    { type: "stateChip", state: "sleep" },
    { type: "wchanBar", wchan: "ep_poll" },
  );
  expect(shown).toMatchObject({ wchan: "ep_poll", state: "", activity: "all" });
  // A second click on the same bar removes its filter only.
  expect(
    threadView(shown, { type: "wchanBar", wchan: "ep_poll" }),
  ).toMatchObject({ wchan: "", activity: "all" });
  // A state chip clears the wait channel; a wait-channel chip keeps the state.
  expect(threadView(shown, { type: "stateChip", state: "poll" })).toMatchObject(
    {
      state: "poll",
      wchan: "",
    },
  );
  expect(
    apply(
      { type: "stateChip", state: "poll" },
      { type: "wchanChip", wchan: "x" },
    ),
  ).toMatchObject({ state: "poll", wchan: "x" });
});

test("a finding, a family bar, and Clear filters set the old combinations", () => {
  const found = apply(
    { type: "wchanChip", wchan: "x" },
    { type: "finding", state: "kernel" },
  );
  expect(found).toMatchObject({ state: "kernel", wchan: "", activity: "all" });
  const family = threadView(found, {
    type: "familyBar",
    mode: "family",
    key: "worker",
  });
  expect(family).toMatchObject({ search: "worker", state: "kernel" });
  expect(
    threadView(family, { type: "familyBar", mode: "group", key: "io" }),
  ).toMatchObject({ search: "", group: "io", activity: "all" });
  expect(threadView(family, { type: "clear" })).toEqual({
    ...initialThreadView,
    sort: family.sort,
  });
});

test("rows sort by the chosen column, then by TID, and the counts ignore activity", () => {
  const threads = [
    thread(3, { read_bps: 10, write_bps: 0, state: "running" }),
    thread(1, { read_bps: 0, write_bps: 10, state: "running" }),
    thread(2, { cpu_pct: 5, name: "alpha", state: "running" }),
    thread(4),
  ];
  const io = { ...initialThreadView, sort: "io" as const };
  const table = threadRows(threads, io, emptySeries);
  expect(table.rows.map((row) => row.tid)).toEqual([1, 3, 2]);
  expect(table.counts).toEqual({ active: 3, idle: 1, all: 4 });
  expect(table.count).toBe("(3 of 4)");
  expect(
    threadRows(threads, { ...initialThreadView, sort: "name" }, emptySeries)
      .rows[0]?.name,
  ).toBe("alpha");
});

test("the idle summary names the hidden waits and a long futex wait", () => {
  let series = emptySeries;
  for (const t of [100, 120, 140])
    series = ingest(
      series,
      view({
        threads: [
          thread(1, { last_sample: t }),
          thread(2, { last_sample: t, state: "sleep", wchan: "hrtimer" }),
        ],
      }),
    );
  const threads = [
    thread(1, { last_sample: 140 }),
    thread(2, { last_sample: 140, state: "sleep" }),
  ];
  const table = threadRows(threads, initialThreadView, series);
  expect(table.idleSummary).toBe(
    "2 idle threads hidden (1 futex wait, 1 sleep). Longest futex wait: over 40 s.",
  );
  expect(table.empty).toBe("Every thread is idle right now.");
  expect(
    threadRows(threads, { ...initialThreadView, search: "none" }, series).empty,
  ).toBe("No threads match these filters.");
  expect(threadRows([], initialThreadView, series).empty).toBe(
    "No threads reported yet.",
  );
});

test("chips count under the other filters and keep a chosen filter at zero", () => {
  const threads = [
    thread(1, { state: "running", wchan: "" }),
    thread(2, { state: "sleep", wchan: "hrtimer", cpu_pct: 1 }),
  ];
  const shown = {
    ...initialThreadView,
    activity: "all" as const,
    wchan: "gone",
  };
  const { states, wchans } = chips(threads, shown);
  // No thread is in the chosen channel, so the state chips count none.
  expect(states.map((chip) => [chip.label, chip.count])).toEqual([["All", 0]]);
  expect(wchans.map((chip) => [chip.label, chip.count, chip.pressed])).toEqual([
    ["All", 2, false],
    ["—", 1, false],
    ["hrtimer", 1, false],
    ["gone", 0, true],
  ]);
});
