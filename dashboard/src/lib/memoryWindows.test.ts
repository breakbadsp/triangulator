import { expect, it } from "vitest";
import { asResourcePoints, type ResourcePoint } from "./assess/memory";
import type { ResourceRow } from "../api/types";
import {
  autoSpan,
  flatFor,
  hostAvailablePct,
  perHour,
  rateText,
  risingInEveryWindow,
  windowChanges,
} from "./memoryTrend";

const MB = 2 ** 20,
  HOUR = 3600,
  DAY = 24 * HOUR;
// One row each 60 s over `seconds`, ending at t = DAY + 1000.
const rows = (
  seconds: number,
  row: (age: number) => Partial<ResourceRow>,
): ResourcePoint[] =>
  asResourcePoints(
    Array.from({ length: Math.floor(seconds / 60) + 1 }, (_, i) => {
      const age = seconds - i * 60;
      return {
        ts: DAY + 1000 - age,
        pid: 1,
        elapsed_s: 60,
        rss_bytes: null,
        ...row(age),
      };
    }),
  );
const rss = (point: ResourcePoint) => point.rss_bytes;
const arrows = (points: ResourcePoint[]) =>
  windowChanges(points, rss).map((change) => change?.direction ?? "–");

it("measures each window from its start to the newest value", () => {
  // RSS grows 1 MiB each hour from 100 MiB, 24 h ago.
  const changes = windowChanges(
    rows(DAY, (age) => ({ rss_bytes: 100 * MB + ((DAY - age) * MB) / HOUR })),
    rss,
  );
  expect(changes.map((change) => change && change.delta / MB)).toEqual([
    0.25, 1, 6, 24,
  ]);
  // 0.25 MiB of about 124 MiB is inside the 1% dead zone.
  expect(changes.map((change) => change?.direction)).toEqual([
    "flat",
    "flat",
    "up",
    "up",
  ]);
  expect(perHour(changes[3] ?? null)).toBeCloseTo(MB);
});

it("gives down and flat by the 1% dead zone of the window-start value", () => {
  const falling = rows(DAY, (age) => ({ rss_bytes: 100 * MB + age * 4000 }));
  expect(arrows(falling)).toEqual(["down", "down", "down", "down"]);
  // 0.9% over 24 h is flat, 1.1% is not.
  const change = (share: number) =>
    windowChanges(
      rows(DAY, (age) => ({
        rss_bytes: age === 0 ? 100 * MB * (1 + share) : 100 * MB,
      })),
      rss,
    )[3]?.direction;
  expect(change(0.009)).toBe("flat");
  expect(change(0.011)).toBe("up");
});

it("counts only the newest process run", () => {
  // A restart 2 h ago: the 6 h and 24 h windows reach before it.
  const points = asResourcePoints(
    rows(DAY, (age) => ({
      pid: age > 2 * HOUR ? 1 : 2,
      rss_bytes: age > 2 * HOUR ? 900 * MB : 100 * MB,
    })),
  );
  expect(arrows(points)).toEqual(["flat", "flat", "–", "–"]);
});

it("shows – when stored history starts more than 10% into the window", () => {
  // 5.5 h of history: the 6 h window misses 30 min (8%), 24 h misses 77%.
  expect(arrows(rows(5.5 * HOUR, () => ({ rss_bytes: MB })))).toEqual([
    "flat",
    "flat",
    "flat",
    "–",
  ]);
  // 5 h: the 6 h window misses 1 h (17%).
  expect(arrows(rows(5 * HOUR, () => ({ rss_bytes: MB })))[2]).toBe("–");
});

it("reads null values of older rows as missing history", () => {
  // VmSize stored only for the last 30 min; rows before have null.
  const points = rows(DAY, (age) => ({
    vm_size_bytes: age <= 1800 ? 200 * MB : null,
  }));
  expect(
    windowChanges(points, (point) => point.vm_size_bytes).map(
      (change) => change?.direction ?? "–",
    ),
  ).toEqual(["flat", "–", "–", "–"]);
  expect(windowChanges([], rss)).toEqual([null, null, null, null]);
});

it("uses the same rule for the host available percent", () => {
  const GiB = 2 ** 30;
  const points = rows(DAY, (age) => ({
    host_mem_total_bytes: 16 * GiB,
    // 50% now, 0.4 points more each hour back in time.
    host_mem_available_bytes: 8 * GiB + (age / HOUR) * 0.004 * 16 * GiB,
  }));
  expect(hostAvailablePct(points.at(-1) as ResourcePoint)).toBe(50);
  const changes = windowChanges(points, hostAvailablePct);
  // 0.4 points of 50.4% is under 1%; 2.4 points of 52.4% is not.
  expect(changes.map((change) => change?.direction)).toEqual([
    "flat",
    "flat",
    "down",
    "down",
  ]);
  expect(changes[2]?.delta).toBeCloseTo(-2.4);
  expect(
    hostAvailablePct({
      ...(points[0] as ResourcePoint),
      host_mem_total_bytes: null,
    }),
  ).toBeNull();
});

it("counts how long the value stayed inside the dead zone", () => {
  expect(
    flatFor([
      { t: 0, v: 100 },
      { t: 60, v: 200 },
      { t: 120, v: 201 },
      { t: 7260, v: 200 },
    ]),
  ).toBe(7200);
  expect(flatFor([{ t: 5, v: 1 }])).toBe(0);
  expect(flatFor([])).toBeNull();
});

it("calls a value that stays at zero flat", () => {
  // Host available 0% all day, and a zero RSS: no change is never "down".
  expect(arrows(rows(DAY, () => ({ rss_bytes: 0 })))).toEqual([
    "flat",
    "flat",
    "flat",
    "flat",
  ]);
  // A fall from nothing to a value is still a change.
  expect(
    arrows(rows(DAY, (age) => ({ rss_bytes: age > 600 ? 0 : 5 * MB }))),
  ).toEqual(["up", "up", "up", "up"]);
  // The newest value is 0: only points that differ end the flat time.
  expect(
    flatFor([
      { t: 0, v: 0 },
      { t: 60, v: 0 },
      { t: 120, v: 0 },
    ]),
  ).toBe(120);
  expect(
    flatFor([
      { t: 0, v: 5 },
      { t: 60, v: 0 },
      { t: 120, v: 0 },
    ]),
  ).toBe(60);
});

it("scales an axis around the values with a minimum span", () => {
  // A 10 KiB wobble at 10 MiB gets the 1 MiB minimum, centred on it.
  expect(autoSpan([10 * MB, 10 * MB + 10240])).toEqual({
    min: 10 * MB + 5120 - MB / 2,
    max: 10 * MB + 5120 + MB / 2,
  });
  // At 1 GiB the minimum is 5% of the newest value.
  const big = autoSpan([1024 * MB, 1024 * MB]);
  expect(big && (big.max - big.min) / MB).toBeCloseTo(51.2);
  // A real change sets the axis; it is not from 0.
  expect(autoSpan([56 * MB, 85 * MB])).toEqual({ min: 56 * MB, max: 85 * MB });
  // Near 0 the axis does not go below 0.
  expect(autoSpan([0, 1000])).toEqual({ min: 0, max: MB });
  expect(autoSpan([])).toBeNull();
});

it("shows the pill only when all four windows rose", () => {
  const up = {
    direction: "up" as const,
    delta: 1,
    start: { t: 0, v: 1 },
    end: { t: HOUR, v: 2 },
  };
  expect(risingInEveryWindow([up, up, up, up])).toBe(true);
  expect(risingInEveryWindow([up, up, up, null])).toBe(false);
  expect(risingInEveryWindow([up, up, { ...up, direction: "flat" }, up])).toBe(
    false,
  );
  expect(risingInEveryWindow([])).toBe(false);
});

it("shows a rate only for a selected range of 1 h or more", () => {
  const change = {
    direction: "up" as const,
    delta: MB,
    start: { t: 0, v: MB },
    end: { t: 2 * HOUR, v: 2 * MB },
  };
  const format = (rate: number) => `+${String(rate / MB)} MiB`;
  expect(rateText(change, 900, format)).toBeNull();
  expect(rateText(change, 3600, format)).toBe("▲ +0.5 MiB/h");
  expect(rateText(null, 86400, format)).toBeNull();
});
