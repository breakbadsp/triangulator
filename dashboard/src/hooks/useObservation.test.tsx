import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { LiveResponse } from "../api/types";
import { clearViewCaches } from "../api/viewStorage";
import { useObservation } from "./useObservation";
function useSeries(target: string, view: LiveResponse) {
  return useObservation(target, { view, now: view.health.last_seen ?? 0 }, 900)
    .observation?.series;
}

afterEach(() => {
  sessionStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
  expect(result.current?.points).toHaveLength(7);
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
  expect(result.current?.points.map((point) => point.t)).toEqual([1, 2, 3]);
  // The futex wait started at the first tick, before the reload.
  expect(result.current?.seen.get(1)?.futexSince).toBe(1);
  // The map's averages survive the reload; the live CPU chart starts again.
  expect(result.current?.avg.get(1)?.samples).toEqual([[1, 0]]);
  expect(result.current?.since).toBe(1);
  expect(result.current?.cpu.get(1)).toEqual([{ t: 3, v: 0 }]);
  // Another target's tab entries are not read.
  const other = renderHook(() => useSeries("h/other", third));
  expect(other.result.current?.points).toHaveLength(1);
});

test("target navigation aborts pending work and pagehide does not restore cleared caches", async () => {
  const pending: {
    path: string;
    signal?: AbortSignal | null;
    deliver: (value: unknown) => void;
  }[] = [];
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string, init?: RequestInit) => {
      requests.push(path);
      if (path === "/api/replay")
        return Promise.resolve(
          Response.json({ first: 1, last: 2, interval_s: 1 }),
        );
      return new Promise<Response>((resolve) => {
        pending.push({
          path,
          signal: init?.signal,
          deliver: (value) => {
            resolve(Response.json(value));
          },
        });
      });
    }),
  );
  vi.useFakeTimers();
  const first: LiveResponse = {
    ...live(10),
    memory: { available: true, pid: 1, layout_id: "s:1" },
  };
  const { result, rerender } = renderHook(
    ({ view }) =>
      useObservation("h/w", { view, now: view.health.last_seen ?? 0 }, 900),
    { initialProps: { view: first } },
  );
  await act(async () => {
    await Promise.resolve();
  });
  let selection: Promise<boolean> | undefined;
  act(() => {
    selection = result.current.inspect(2);
  });
  const expected = result.current.observation?.key;
  act(() => {
    result.current.leave();
    clearViewCaches("h/w");
    dispatchEvent(new Event("pagehide"));
  });
  expect(pending.length).toBeGreaterThan(2);
  expect(pending.every((request) => request.signal?.aborted)).toBe(true);
  await act(async () => {
    for (const request of pending)
      request.deliver(
        request.path.startsWith("/api/replay?")
          ? { first: 1, last: 2, snapshot: { ...live(2), recorded_at: 2 } }
          : { rows: [], available: true, id: "s:1", pid: 1, regions: [] },
      );
    await selection;
  });
  rerender({ view: { ...first, ...live(11) } });
  expect(result.current.observation?.key).toBe(expected);
  expect(result.current.observation?.view.threads[0]?.last_sample).toBe(10);
  expect(entry("triangulator:buffer")).toBeNull();
  expect(entry("triangulator:threads")).toBeNull();
  expect(sessionStorage.getItem("triangulator:frozen:h/w")).toBeNull();
  const count = requests.length;
  await act(() => vi.advanceTimersByTimeAsync(30000));
  expect(requests).toHaveLength(count);
});
