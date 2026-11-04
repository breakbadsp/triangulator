import { expect, it } from "vitest";
import { asResourcePoints } from "./assess/memory";
import { classifyMemory } from "./memoryTrend";

const MB = 2 ** 20,
  HOUR = 3600;
// One point each 60 s from `start`, RSS from `rss(seconds)`.
const series = (
  seconds: number,
  rss: (t: number) => number,
  pid: (t: number) => number = () => 1,
) =>
  asResourcePoints(
    Array.from({ length: Math.floor(seconds / 60) + 1 }, (_, i) => ({
      ts: 1000 + i * 60,
      pid: pid(i * 60),
      elapsed_s: 60,
      rss_bytes: rss(i * 60),
    })),
  );

it("calls a flat series steady", () => {
  expect(classifyMemory(series(HOUR, () => 500 * MB)).kind).toBe("steady");
});
it("calls a +50 MB/h ramp over 6 h growing and gives the rate", () => {
  const trend = classifyMemory(
    series(6 * HOUR, (t) => 500 * MB + (50 * MB * t) / HOUR),
  );
  expect(trend.kind).toBe("growing");
  expect(trend.text).toContain("+50.0 MiB/h");
  expect(trend.change).toBe("Grew 300.0 MiB in 6.0 h");
});
it("calls flat then a +200 MB jump stepping", () => {
  const trend = classifyMemory(
    series(HOUR, (t) => (t < 1800 ? 500 * MB : 700 * MB)),
  );
  expect(trend.kind).toBe("stepping");
  expect(trend.text).toContain("1 sudden jump");
});
it("calls a falling series shrinking", () => {
  expect(
    classifyMemory(series(HOUR, (t) => 900 * MB - (200 * MB * t) / HOUR)).kind,
  ).toBe("shrinking");
});
it("needs 6 points and 5 minutes", () => {
  expect(classifyMemory(series(240, () => MB)).kind).toBe("unknown");
  expect(classifyMemory(series(300, () => MB)).kind).toBe("steady");
  const sparse = asResourcePoints(
    [0, 1000, 2000, 3000, 4000].map((ts) => ({
      ts,
      pid: 1,
      elapsed_s: 1,
      rss_bytes: MB,
    })),
  );
  expect(classifyMemory(sparse).kind).toBe("unknown");
});
it("does not read a restart as a step or a drop", () => {
  const up = series(
    HOUR,
    (t) => (t < 1800 ? 100 * MB : 400 * MB),
    (t) => (t < 1800 ? 1 : 2),
  );
  const down = series(
    HOUR,
    (t) => (t < 1800 ? 400 * MB : 100 * MB),
    (t) => (t < 1800 ? 1 : 2),
  );
  expect(classifyMemory(up).kind).toBe("steady");
  expect(classifyMemory(down).kind).toBe("steady");
});
it("ignores the stored bucket that mixes the new pid with the old peak RSS", () => {
  // Bucket at t=1800 has the max pid (2) and the max RSS (old 2 GiB).
  const trend = classifyMemory(
    series(
      HOUR,
      (t) => (t < 1800 ? 2048 * MB : t === 1800 ? 2048 * MB : 100 * MB),
      (t) => (t < 1800 ? 1 : 2),
    ),
  );
  expect(trend.kind).toBe("steady");
});
it("does not call a spike that returns to its start stepping", () => {
  const trend = classifyMemory(
    series(HOUR, (t) =>
      t === 1800 ? 540 * MB : t === HOUR ? 500.5 * MB : 500 * MB,
    ),
  );
  expect(trend.kind).toBe("steady");
});
it("calls a fast ramp over 87 s points growing, not stepping", () => {
  const points = asResourcePoints(
    Array.from({ length: 100 }, (_, i) => ({
      ts: 1000 + i * 87,
      pid: 1,
      elapsed_s: 87,
      rss_bytes: 500 * MB + (1536 * MB * i * 87) / HOUR,
    })),
  );
  expect(classifyMemory(points).kind).toBe("growing");
});
