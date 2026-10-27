import { expect, test } from "vitest";
import { restoreSeries, threadsEntry, type Point } from "./series";

const point = (t: number, extra: Partial<Point> = {}): Point => ({
  t,
  cpu: 10,
  rd: 0,
  sw: 1,
  rb: 0,
  wb: 0,
  mf: 0,
  n: 3,
  busy: 1,
  active: 2,
  s: { running: 1 },
  born: 0,
  died: 0,
  rss: null,
  vm: null,
  ...extra,
});

test("restoring keeps valid entries and drops damaged ones", () => {
  const buffer = {
    session: "s",
    points: [
      point(1),
      { ...point(2), t: null },
      { ...point(3), s: { running: "x" } },
      "damaged",
      { ...point(4), cpu: "10" },
      point(5),
    ],
  };
  const threads = {
    session: "s",
    since: 1,
    avg: [
      [1, [7, 10, 5, 20, 6]],
      [2, [7, 10, 5, 20]],
      [3, [7, 10, "5"]],
      ["4", [7, 10, 5]],
      [5, "damaged"],
    ],
    seen: [
      [1, { first: 1, active: 2, generation: 7 }],
      [2, { first: "1", active: 2 }],
      [3, { first: 1, active: "2" }],
      [4, null],
      ["5", { first: 1, active: 2 }],
    ],
  };
  const series = restoreSeries(buffer, threads, "s");
  expect(series.points.map((item) => item.t)).toEqual([1, 5]);
  expect(series.lastTick).toBe(5);
  expect([...series.seen.keys()]).toEqual([1]);
  expect([...series.avg.keys()]).toEqual([1]);
  expect(series.avg.get(1)).toEqual({
    generation: 7,
    samples: [
      [10, 5],
      [20, 6],
    ],
  });
});

test("an entry that this page saved restores unchanged", () => {
  const first = restoreSeries(
    {
      session: "s",
      points: [point(1), point(2, { cpu: null, l1: null })],
    },
    {
      session: "s",
      since: 1,
      avg: [[1, [null, 10, 5]]],
      seen: [[1, { first: 1, active: null, futexSince: null }]],
    },
    "s",
  );
  const again = restoreSeries(
    { session: "s", points: first.points },
    JSON.parse(JSON.stringify(threadsEntry(first))),
    "s",
  );
  expect(again.seen).toEqual(first.seen);
  expect(again.avg).toEqual(first.avg);
  expect(again.points).toEqual(first.points);
});
