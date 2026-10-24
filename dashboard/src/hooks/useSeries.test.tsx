import { renderHook } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { LiveResponse } from "../api/types";
import { useSeries } from "./useSeries";

afterEach(() => {
  sessionStorage.clear();
});
const live = (t: number, state = "futex"): LiveResponse => ({
  health: {
    session: "s",
    pid: 1,
    last_seen: t,
    sampler_silent: false,
    target_absent: false,
  },
  threads: [
    {
      tid: 1,
      generation: 1,
      name: "w",
      last_sample: t,
      cpu_pct: 0,
      state,
      state_mix: { [state]: 20 },
      wchan: "futex_do_wait",
    },
  ],
});
const entry = (name: string) =>
  JSON.parse(sessionStorage.getItem(`${name}:h/w`) ?? "null") as {
    session: string;
    points?: { t: number }[];
    seen?: [number, { futexSince?: number | null }][];
  } | null;

test("the tab saves every 5th point and the latest series when the page hides", () => {
  const { result, rerender } = renderHook(
    ({ view }: { view: LiveResponse }) => useSeries("h/w", view),
    { initialProps: { view: live(1) } },
  );
  for (const t of [2, 3, 4, 5]) rerender({ view: live(t) });
  expect(entry("triangulator:buffer")?.points).toHaveLength(5);
  for (const t of [6, 7]) rerender({ view: live(t) });
  expect(entry("triangulator:buffer")?.points).toHaveLength(5);
  dispatchEvent(new Event("pagehide"));
  expect(entry("triangulator:buffer")?.points?.map((point) => point.t)).toEqual(
    [1, 2, 3, 4, 5, 6, 7],
  );
  expect(entry("triangulator:threads")?.seen?.[0]?.[1].futexSince).toBe(1);
  expect(result.current.points).toHaveLength(7);
});

test("a reload restores points and thread observations of the same session", () => {
  const first = renderHook(
    ({ view }: { view: LiveResponse }) => useSeries("h/w", view),
    { initialProps: { view: live(1) } },
  );
  first.rerender({ view: live(2) });
  dispatchEvent(new Event("pagehide"));
  first.unmount();
  // A poll result keeps its identity across renders.
  const third = live(3);
  const { result } = renderHook(() => useSeries("h/w", third));
  expect(result.current.points.map((point) => point.t)).toEqual([1, 2, 3]);
  // The futex wait started at the first tick, before the reload.
  expect(result.current.seen.get(1)?.futexSince).toBe(1);
  // The map's averages survive the reload; the live CPU chart starts again.
  expect(result.current.avg.get(1)?.samples).toEqual([[1, 0]]);
  expect(result.current.since).toBe(1);
  expect(result.current.cpu.get(1)).toEqual([{ t: 3, v: 0 }]);
  // Another target's tab entries are not read.
  const other = renderHook(() => useSeries("h/other", third));
  expect(other.result.current.points).toHaveLength(1);
});
