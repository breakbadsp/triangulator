import { expect, test } from "vitest";
import type { MemorySummary, Resources } from "../api/types";
import { emptySeries, ingest } from "./series";
import { view, lockThread } from "./test-fixtures";

test("summary points record RSS and VmSize only from current samples", () => {
  let series = emptySeries;
  const feed = (
    time: number,
    resources?: Resources,
    memory?: MemorySummary,
  ) => {
    series = ingest(
      series,
      view({
        health: { ...view().health, pid: 7 },
        threads: [
          {
            tid: 1,
            generation: 1,
            name: "w",
            last_sample: time,
            cpu_pct: 5,
            state: "sleep",
          },
        ],
        resources,
        memory,
      }),
    );
    const point = series.points.at(-1);
    return [point?.rss, point?.vm];
  };
  expect(
    feed(
      1,
      { available: true, session: "s", pid: 7, memory: { rss: 3 << 20 } },
      { available: true, pid: 7, values: { vm_size_bytes: 9 << 20 } },
    ),
  ).toEqual([3 << 20, 9 << 20]);
  expect(
    feed(
      2,
      {
        available: true,
        stale: true,
        session: "s",
        pid: 7,
        memory: { rss: 1 },
      },
      { available: true, stale: true, pid: 7, values: { vm_size_bytes: 1 } },
    ),
  ).toEqual([null, null]);
  expect(
    feed(
      3,
      { available: true, session: "old", pid: 7, memory: { rss: 1 } },
      { available: false },
    ),
  ).toEqual([null, null]);
  expect(
    feed(
      4,
      { available: true, session: "s", pid: 6, memory: { rss: 1 } },
      { available: true, pid: 6, values: { vm_size_bytes: 1 } },
    ),
  ).toEqual([null, null]);
  expect(feed(5)).toEqual([null, null]);
});

test("ingest preserves its inputs, counts thread generations, and resets on a new session", () => {
  const a = view({ threads: [lockThread(1, "a", "futex")] });
  const first = ingest(emptySeries, a);
  expect(emptySeries.points).toEqual([]);
  expect(emptySeries.seen.size).toBe(0);
  expect(ingest(first, a)).toBe(first);
  const second = ingest(first, {
    ...a,
    threads: [
      { ...a.threads[0], tid: 1, name: "a", generation: 1, last_sample: 1001 },
    ],
  });
  expect(second.points.at(-1)).toMatchObject({ born: 1, died: 1 });
  expect(first.seen.get(1)).toMatchObject({ first: 1000 });
  expect(second.seen.get(1)).toMatchObject({ first: 1001 });
  const reset = ingest(second, {
    ...a,
    health: { ...a.health, session: "new" },
    threads: [{ ...lockThread(2, "b", "running"), last_sample: 1002 }],
  });
  expect(reset.points).toHaveLength(1);
  expect(reset.points[0]).toMatchObject({ born: 0, died: 0 });
  expect(reset.seen.has(1)).toBe(false);
  expect(a.threads[0]?.last_sample).toBe(1000);
});

test("a pause leaves unknown rates and series retention stays at 900 seconds", () => {
  let series = ingest(
    emptySeries,
    view({ threads: [lockThread(1, "a", "running")] }),
  );
  series = ingest(
    series,
    view({
      threads: [
        {
          ...lockThread(1, "a", "sleep"),
          last_sample: 1001,
          cpu_pct: null,
          switches_per_s: null,
        },
      ],
    }),
  );
  expect(series.points.at(-1)).toMatchObject({
    cpu: null,
    rd: null,
    sw: null,
    rb: null,
    wb: null,
    mf: null,
    busy: null,
    active: null,
  });
  series = ingest(
    series,
    view({
      threads: [{ ...lockThread(1, "a", "running"), last_sample: 1901 }],
    }),
  );
  expect(series.points.map((point) => point.t)).toEqual([1001, 1901]);
});
