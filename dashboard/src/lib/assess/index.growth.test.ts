import { assert, expect, test } from "vitest";
import type { Resources } from "../../api/types";
import { assess, threadGrowth } from "./index";
import { emptySeries } from "../series";
import type { Point } from "../series";
import { resources, view } from "../test-fixtures";
import { input, point } from "./test-input";
const countsAt = (seconds: number, count: (i: number) => number) =>
  Array.from({ length: seconds }, (_, i) => point(1000 + i, count(i)));
function growthEver(points: readonly Point[]) {
  for (let i = 1; i <= points.length; i++)
    if (threadGrowth(points.slice(0, i))) return i;
  return 0;
}
test("a steady thread leak is flagged with its rate, count and cgroup headroom", () => {
  const points = countsAt(180, (i) => 4 + Math.floor(i * 4));
  const findings = assess(
    input(view(), { series: { ...emptySeries, points } }),
  );
  const finding = findings.find(
    (item) => item.title === "Thread count keeps growing",
  );
  assert.strictEqual(finding?.level, "warning");
  assert.match(
    finding?.detail ?? "",
    /\d+ to \d{3} threads in \d\.\d min, \+2\d\d threads\/min, and still rising/,
  );
  assert.match(finding?.detail ?? "", /No cgroup pids\.max is known/);
  assert.ok(!findings.some((item) => item.level === "good"));
  // The rule needs about two minutes of data: it fires in the third minute, not the first.
  const first = growthEver(points);
  assert.ok(first >= 120 && first <= 150, `fired after ${String(first)} s`);
  // A slow leak (one thread every 4 s, 15 threads/min) shows over five minutes.
  const slow = countsAt(330, (i) => 40 + Math.floor(i / 4));
  assert.ok(growthEver(slow) > 0);
});

test("thread growth needs two minutes of continuous observations", () => {
  const sparse = countsAt(250, (i) => 4 + i * 4).filter((_, i) => i % 30 === 0);
  assert.strictEqual(threadGrowth(sparse), null);
  assert.strictEqual(growthEver(countsAt(120, (i) => 4 + i * 4)), 0);
  const points = countsAt(180, (i) => 4 + i * 4);
  const growth = threadGrowth(points);
  expect(growth?.rate).toBeCloseTo(240);
  assert.ok((growth?.minutes ?? 0) >= 2);
});

test("thread growth escalates when the cgroup limit is close", () => {
  const points = countsAt(150, (i) => 4 + i * 4);
  const run = (pids: NonNullable<Resources["cgroup_limits"]>["pids"]) =>
    assess(
      input(view({ resources: resources({ cgroup_limits: { pids } }) }), {
        series: { ...emptySeries, points },
      }),
    ).find((item) => item.title === "Thread count keeps growing");
  assert.strictEqual(run({ current: 604, max: 100000 })?.level, "warning");
  assert.match(
    run({ current: 604, max: 100000 })?.detail ?? "",
    /full in about \d+ min/,
  );
  const soon = run({ current: 604, max: 1000 });
  assert.strictEqual(soon?.level, "serious");
  assert.match(
    soon?.detail ?? "",
    /allows 1000 processes and threads \(604 in use\); at this rate it is full in about 2 min/,
  );
  assert.strictEqual(run({ current: 800, max: 1000 })?.level, "serious");
  assert.match(
    run({ current: 3, max: null })?.detail ?? "",
    /No cgroup pids\.max is known/,
  );
});

test("pools warming up, restarts, churn and noise are not thread growth", () => {
  // A pool that ramps from 8 to 200 threads in 40 s, then stays there.
  assert.strictEqual(
    growthEver(countsAt(600, (i) => Math.min(200, 8 + i * 5))),
    0,
  );
  // A slower ramp that stops after a minute.
  assert.strictEqual(
    growthEver(countsAt(600, (i) => Math.min(300, 20 + i * 5))),
    0,
  );
  // Growth for less than two minutes.
  assert.strictEqual(growthEver(countsAt(100, (i) => 4 + i * 4)), 0);
  // A restart: 300 threads, then 2, rebuilt to 100 within 25 s, then steady.
  assert.strictEqual(
    growthEver(
      countsAt(600, (i) => (i < 200 ? 300 : Math.min(100, 2 + (i - 200) * 4))),
    ),
    0,
  );
  // A steady count, and one that bursts with short-lived threads.
  assert.strictEqual(growthEver(countsAt(400, () => 50)), 0);
  assert.strictEqual(
    growthEver(countsAt(400, (i) => 50 + (i % 20 < 5 ? 30 : 0))),
    0,
  );
  // A pool that scales in and out around the same level, never settling higher.
  assert.strictEqual(
    growthEver(countsAt(600, (i) => 100 + 40 * Math.sin(i / 20))),
    0,
  );
  // Missing counts do not matter.
  assert.strictEqual(threadGrowth([]), null);
  assert.strictEqual(
    threadGrowth([
      { t: 1, n: null },
      { t: 2, n: null },
    ]),
    null,
  );
});
