import { expect, test } from "vitest";
import type { LiveResponse } from "../api/types";
import { emptySeries, ingest, restoreSeries, type Series } from "./series";
import { loadFacts } from "./summary";

function tick(
  series: Series,
  time: number,
  cpu: number | null,
  session = "session-1",
  state = "sleep",
  delay = 0,
) {
  const view: LiveResponse = {
    health: {
      session,
      pid: 0,
      last_seen: time,
      sampler_silent: false,
      target_absent: false,
    },
    threads: [
      {
        tid: 1,
        generation: 1,
        name: "worker",
        last_sample: time,
        cpu_pct: cpu,
        run_delay_pct: delay,
        state,
      },
    ],
  };
  return ingest(series, view);
}
const average = (series: Series, index: number) =>
  series.load?.averages[index] ?? Number.NaN;
// The saved entry as the old page and the hook write it.
const saved = (series: Series) =>
  JSON.parse(
    JSON.stringify({
      session: series.session,
      points: series.points,
      loadState: series.load,
    }),
  ) as unknown;

// A long idle interval must keep decaying the initial load after that sample
// expires from the chart, including the saved one-minute overlay values.
test("load averages continue smoothly after chart eviction and redraws", () => {
  let series = tick(emptySeries, 1000, 100);
  for (let time = 1001; time <= 1900; time++) series = tick(series, time, 0);
  expect(average(series, 2)).toBeCloseTo(Math.exp(-1), 12);
  series = tick(series, 1901, 0);
  expect(series.points[0]?.t).toBe(1001);
  for (const [index, seconds] of [60, 300, 900].entries())
    expect(average(series, index)).toBeCloseTo(Math.exp(-901 / seconds), 12);
  expect(series.points.at(-1)?.l1).toBeCloseTo(Math.exp(-901 / 60), 12);
  const facts = loadFacts([], series, true);
  expect(facts.load15).toBe("0.37");
  expect(loadFacts([], series, true)).toEqual(facts);
});

test("saved averages survive reload and reset for a new sampler session", () => {
  let series = tick(emptySeries, 1000, 100);
  for (let time = 1001; time <= 1901; time++) series = tick(series, time, 0);
  let restored = restoreSeries(saved(series), null, "session-1");
  restored = tick(restored, 1901, 0);
  expect(restored.load).toEqual(series.load);
  restored = tick(restored, 1902, 0);
  expect(average(restored, 2)).toBeCloseTo(Math.exp(-902 / 900), 12);
  restored = tick(restored, 2000, 0, "session-2");
  expect(average(restored, 2)).toBe(0);
  expect(restored.points).toHaveLength(1);
});

test("unknown rates stay gaps and resumed samples keep bounded decay", () => {
  let series = tick(emptySeries, 1000, 100);
  series = tick(series, 1010, null);
  expect(series.points.at(-1)?.l1).toBeNull();
  expect(series.load?.t).toBe(1000);
  series = tick(series, 1100, 0);
  expect(average(series, 2)).toBeCloseTo(Math.exp(-30 / 900), 12);
});

test("load includes CPU demand and uninterruptible waits", () => {
  const series = tick(emptySeries, 1000, 100, "session-1", "kernel", 50);
  expect(average(series, 0)).toBe(2.5);
});

test("old or invalid saved average state is seeded from retained points", () => {
  for (const loadState of [
    undefined,
    { t: 1001, averages: [0] },
    { t: 9999, averages: [0, 0, 0] },
  ]) {
    let series = restoreSeries(
      {
        session: "session-1",
        points: [
          { t: 1000, cpu: 100, rd: 0, s: {} },
          { t: 1001, cpu: 0, rd: 0, s: {} },
        ],
        loadState,
      },
      null,
      "session-1",
    );
    expect(average(series, 2)).toBeCloseTo(Math.exp(-1 / 900), 12);
    series = tick(series, 1002, 0);
    expect(average(series, 2)).toBeCloseTo(Math.exp(-2 / 900), 12);
  }
});

test("a restore takes thread observations from the threads entry of the same session", () => {
  const seen = [[1, { first: 900, active: null, generation: 1 }]];
  expect([
    ...restoreSeries(null, { session: "s", since: 0, avg: [], seen }, "s").seen,
  ]).toEqual(seen);
  expect(
    restoreSeries(null, { session: "old", since: 0, avg: [], seen }, "s").seen
      .size,
  ).toBe(0);
});

test("a recorded view shows no load average", () => {
  const series = tick(emptySeries, 1000, 100);
  expect(loadFacts([], series, false)).toMatchObject({
    load1: "—",
    load5: "—",
    load15: "—",
    load15Label: "15 min",
  });
});
