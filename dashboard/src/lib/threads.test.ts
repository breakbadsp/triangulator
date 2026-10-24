import { expect, test } from "vitest";
import type { Thread } from "../api/types";
import { emptySeries, ingest, type Series } from "./series";
import { view } from "./test-fixtures";
import { coreColumns, familyItems, mapCells } from "./threads";

const busy = (tid: number, cpu: number, t: number): Thread => ({
  tid,
  name: `w${String(tid)}`,
  generation: 1,
  state: "running",
  cpu_pct: cpu,
  last_sample: t,
});
function history(samples: readonly [number, number][]): Series {
  let series = emptySeries;
  for (const [index, [a, b]] of samples.entries()) {
    const t = 1000 + index * 10;
    series = ingest(series, view({ threads: [busy(1, a, t), busy(2, b, t)] }));
  }
  return series;
}

test("the map orders tiles by the window's average CPU, not the latest sample", () => {
  // Thread 1 was busy for minutes; thread 2 is busy only now.
  const series = history([
    [90, 0],
    [90, 0],
    [90, 0],
    [0, 50],
  ]);
  const now = [busy(1, 0, 1030), busy(2, 50, 1030)];
  expect(mapCells(now, series, 0).cells.map((cell) => cell.thread.tid)).toEqual(
    [2, 1],
  );
  const averaged = mapCells(now, series, 300);
  expect(averaged.cells.map((cell) => [cell.thread.tid, cell.text])).toEqual([
    [1, "68%"],
    [2, "13%"],
  ]);
  // 30 s of data cannot fill a 5 min window.
  expect(averaged.shortData).toBe("Only 30 s of data in this tab so far.");
  expect(averaged.cells[0]?.tip.map((row) => row.label)).toContain(
    "average, 5 min",
  );
});

test("CPU by family groups numbered names and collapses past ten rows", () => {
  const threads = Array.from({ length: 12 }, (_, index) => ({
    ...busy(index + 1, index + 1, 1),
    name: `pool-${String(index % 11)}x`,
  }));
  threads.push({ ...busy(20, 1, 1), name: "worker-7" });
  threads.push({ ...busy(21, 2, 1), name: "worker-8" });
  const items = familyItems(threads, "family");
  expect(items).toHaveLength(10);
  expect(items.at(-1)?.label).toMatch(/^\d+ others$/);
  const worker = familyItems(threads.slice(-2), "family")[0];
  expect([worker?.label, worker?.sub, worker?.tip[1]?.value]).toEqual([
    "worker",
    "×2",
    "100%",
  ]);
});

test("core bars scale to the busiest core and keep empty cores", () => {
  const { columns, scale } = coreColumns([
    { ...busy(1, 40, 1), cpu: 0 },
    { ...busy(2, 2, 1), cpu: 2 },
  ]);
  expect(columns.map((column) => [column.core, column.cap])).toEqual([
    [0, "40.0%"],
    [1, ""],
    [2, "2.0%"],
  ]);
  expect(scale).toMatch(/^Bar height: 0 – 50\.0% of one core/);
});
