import { assert, test } from "vitest";
import type { MemoryLayout } from "../../api/types";
import { assessMemory, memoryRegions, rssTrend } from "./memory";
import { memorySummary, rssHistory, NOW } from "../test-fixtures";
const GROWS = "Resident memory grows without a plateau";
const trendOf = (input: ReturnType<typeof rssHistory>) =>
  rssTrend(input.view, input.points, input.now);
const growthFindings = (input: ReturnType<typeof rssHistory>) =>
  assessMemory(
    memorySummary({}),
    [],
    input.view.resources,
    null,
    trendOf(input),
  ).map((item) => item.title);

test("memory findings flag mapping limits, deleted libraries and the main stack", () => {
  const summary = memorySummary({
    vma_count: 950,
    max_map_count: 1000,
    stack_limit_bytes: 8 << 20,
  });
  const layout: MemoryLayout = {
    available: true,
    regions: [
      {
        start: "0x7f0000000000",
        end: "0x7f0000100000",
        size: 0x100000,
        vmas: 3,
        kind: "file",
        permissions: "r-xp",
        name: "/usr/lib/libssl.so.3 (deleted)",
      },
      {
        start: "0x7ffc00000000",
        end: "0x7ffc00700000",
        size: 0x700000,
        vmas: 1,
        kind: "stack",
        permissions: "rw-p",
        name: "",
      },
    ],
  };
  assert.deepEqual(
    assessMemory(summary, memoryRegions(layout)).map(
      (item) => `${item.level}: ${item.title}`,
    ),
    [
      "critical: Mapping count is close to the limit",
      "warning: Main stack is at 87.5% of its limit",
      "info: Library replaced on disk",
    ],
  );
});

test("a data file below the executable is not the program image", () => {
  const file = (start: number, permissions: string, name: string) => ({
    start: "0x" + start.toString(16),
    end: "0x" + (start + 0x1000).toString(16),
    size: 0x1000,
    vmas: 1,
    kind: "file",
    permissions,
    name,
  });
  const layout = {
    available: true,
    regions: [
      file(0x40e58000, "rw-p", "/tmp/data (deleted)"),
      file(0x55e558c1c000, "r-xp", "/usr/bin/python3.14"),
    ],
  };
  const regions = memoryRegions(layout, "python3");
  assert.deepEqual(
    regions.map((region) => String(region.cat) + (region.certain ? "!" : "")),
    ["code!", "file"],
  );
  assert.isFalse(
    assessMemory(memorySummary({}), regions).some((item) =>
      /replaced on disk/.test(item.title),
    ),
  );
  const guessed = memoryRegions(
    {
      available: true,
      regions: [file(0x55e558c1c000, "r-xp", "/usr/bin/other (deleted)")],
    },
    "python3",
  );
  assert.include(
    assessMemory(memorySummary({}), guessed).map((item) => item.title),
    "Executable file replaced on disk",
  );
});

test("a leak that started a minute ago is reported at its own rate", () => {
  let input = rssHistory([
    [7, 480, 100, 0],
    [7, 60, 100, 8],
  ]);
  const trend = trendOf(input);
  assert.isTrue(trend?.steady);
  assert.isBelow(Math.abs((trend.slope ?? 0) / 2 ** 20 - 480), 25);
  assert.include(growthFindings(input), GROWS);
  input = rssHistory([
    [7, 400, 100, 0],
    [7, 180, 100, 8],
  ]);
  assert.isBelow(Math.abs((trendOf(input)?.slope ?? 0) / 2 ** 20 - 480), 25);
});

test("an earlier, smaller process in the window does not change the RSS trend", () => {
  let input = rssHistory([
    [4, 300, 400, -1],
    [7, 90, 40, 8],
  ]);
  const trend = trendOf(input);
  assert.isTrue(trend?.steady);
  assert.isBelow(Math.abs((trend.slope ?? 0) / 2 ** 20 - 480), 25);
  assert.include(growthFindings(input), GROWS);
  input = rssHistory([
    [4, 300, 50, 0],
    [7, 20, 40, 8],
  ]);
  assert.isNull(trendOf(input));
  assert.notInclude(growthFindings(input), GROWS);
  input = rssHistory([
    [4, 300, 2000, 0],
    [7, 120, 100, 0],
  ]);
  assert.isFalse(trendOf(input)?.steady);
  assert.isBelow(Math.abs(trendOf(input)?.slope ?? 0), 1);
});

test("RSS growth does not use another target, stale resources, or live history in replay", () => {
  const input = rssHistory([[7, 120, 100, 8]]);
  assert.isTrue(trendOf(input)?.steady);
  const health = { ...input.view.health, pid: 8 };
  assert.isNull(rssTrend({ ...input.view, health }, input.points, NOW));
  assert.notInclude(
    assessMemory(
      memorySummary({}),
      [],
      input.view.resources,
      null,
      rssTrend({ ...input.view, health }, input.points, NOW),
    ).map((item) => item.title),
    GROWS,
  );
  assert.isNull(
    rssTrend(
      {
        ...input.view,
        resources: { ...input.view.resources, available: true, stale: true },
      },
      input.points,
      NOW,
    ),
  );
  assert.isNull(
    rssTrend(
      { ...input.view, resources: { available: false } },
      input.points,
      NOW,
    ),
  );
  assert.isNull(
    rssTrend(
      input.view,
      input.points.filter((point) => point.t <= NOW - 300),
      NOW - 300,
    ),
  );
});

test("unavailable RSS rows preserve process boundaries", () => {
  const input = rssHistory([[7, 120, 100, 8]]);
  const points = [...input.points];
  const last = points.at(-1);
  assert.isDefined(last);
  points.splice(-1, 0, {
    t: last.t - 1,
    ts: last.t - 1,
    pid: 8,
    rss_bytes: null,
    elapsed_s: 5,
    per: () => null,
  });
  assert.isNull(rssTrend(input.view, points, NOW));
});

test("flat, noisy and slowly growing RSS do not raise the growth finding", () => {
  const flat = rssHistory([[7, 600, 300, 0]], { wobble: 0.3 });
  assert.isFalse(trendOf(flat)?.steady);
  assert.notInclude(growthFindings(flat), GROWS);
  const slow = rssHistory([[7, 600, 300, 0.01]], { wobble: 0.3 });
  assert.isFalse(trendOf(slow)?.steady);
  assert.notInclude(growthFindings(slow), GROWS);
  const plateau = rssHistory([
    [7, 120, 100, 4],
    [7, 300, 580, 0],
  ]);
  assert.notInclude(growthFindings(plateau), GROWS);
});

test("a leak with a few non-rising steps is still found", () => {
  const input = rssHistory([[7, 300, 100, 2]], { dip: 15 });
  assert.isTrue(trendOf(input)?.steady);
  assert.include(growthFindings(input), GROWS);
});
