// Ports pinned 777cf3a:tests/dashboard_test.js 1124 and 1176.
import { describe, expect, it } from "vitest";
import type { LiveResponse } from "../api/types";
import { assessRecorded } from "./assess";
import type { Finding } from "./findings";
import {
  episodes,
  initialScan,
  planNewer,
  planOlder,
  scanReducer,
  type Sample,
  type Scan,
} from "./pastAssessments";

const finding = (level: Finding["level"], title: string, tid?: number) =>
  ({
    type: "threads",
    level,
    title,
    detail: title,
    action: tid === undefined ? undefined : { tid },
  }) satisfies Finding;

function spinning(at: number, session: string, generation: number) {
  return {
    recorded_at: at,
    health: {
      session,
      pid: 9,
      last_seen: at,
      sampler_silent: false,
      target_absent: false,
      sample_interval_ms: 1000,
    },
    threads: [
      {
        tid: 9,
        name: "worker",
        generation,
        last_sample: at,
        state: "running",
        cpu_pct: 99,
        run_delay_pct: 0,
      },
    ],
  } satisfies LiveResponse;
}

function older(scan: Scan, bounds: Parameters<typeof planOlder>[1]) {
  const batch = planOlder(scan, bounds);
  if (!batch || batch === "done") throw Error("no older period");
  return batch;
}

describe("past-assessment episodes", () => {
  it("join consecutive findings and end at a recording gap", () => {
    const samples: Sample[] = [
      {
        at: 10,
        findings: [
          finding("warning", "2 threads in uninterruptible kernel wait"),
          {
            type: "threads",
            level: "good",
            title: "No problems detected",
            detail: "",
          },
        ],
      },
      {
        at: 20,
        findings: [
          finding("serious", "3 threads in uninterruptible kernel wait"),
          finding("serious", "a-1 is saturating a core", 1),
        ],
      },
      {
        at: 30,
        findings: [
          finding("warning", "2 threads in uninterruptible kernel wait"),
          finding("serious", "a-2 is saturating a core", 2),
        ],
      },
      null,
      {
        at: 50,
        findings: [
          finding("warning", "1 thread in uninterruptible kernel wait"),
        ],
      },
    ];
    expect(
      episodes(samples).map((episode) => [
        episode.item.title,
        episode.level,
        episode.at,
        episode.first,
        episode.last,
        episode.count,
      ]),
    ).toEqual([
      ["1 thread in uninterruptible kernel wait", "warning", 50, 50, 50, 1],
      ["a-2 is saturating a core", "serious", 30, 30, 30, 1],
      ["a-1 is saturating a core", "serious", 20, 20, 20, 1],
      ["3 threads in uninterruptible kernel wait", "serious", 20, 10, 30, 3],
    ]);
  });

  it("end thread findings when a TID has a new generation or sampler session", () => {
    const bounds = { first: 1000, last: 1004, interval_s: 1 };
    let scan = scanReducer(initialScan, { type: "start", kind: "older" });
    const batch = older(initialScan, bounds);
    expect(batch.times).toEqual([1000, 1001, 1002, 1003, 1004]);
    const samples = batch.times.map((at) => ({
      at,
      findings: assessRecorded(
        spinning(
          at,
          at < 1004 ? "first-session" : "second-session",
          at < 1002 ? 1 : 2,
        ),
        at,
        [],
      ),
    }));
    scan = scanReducer(scan, { type: "checked", batch, samples });
    const found = episodes(scan.samples);
    expect(
      found.map((episode) => [
        episode.first,
        episode.last,
        episode.count,
        episode.item.action?.tid,
        episode.item.action?.session,
        episode.item.action?.generation,
      ]),
    ).toEqual([
      [1004, 1004, 1, 9, "second-session", 2],
      [1002, 1003, 2, 9, "first-session", 2],
      [1000, 1001, 2, 9, "first-session", 1],
    ]);
    expect(new Set(found.map((episode) => episode.key)).size).toBe(3);
    expect(scan.done).toBe(true);
  });
});

describe("checked periods", () => {
  it("start at the newest recording and double each earlier period", () => {
    const bounds = { first: 0, last: 1900, interval_s: 1 };
    const first = older(initialScan, bounds);
    expect([first.times.length, first.times[0], first.times.at(-1)]).toEqual([
      120, 1000, 1900,
    ]);
    let scan = scanReducer(initialScan, {
      type: "checked",
      batch: first,
      samples: first.times.map(() => null),
    });
    expect([scan.oldest, scan.newest, scan.chunk, scan.done]).toEqual([
      1000,
      1900,
      1800,
      false,
    ]);
    const earlier = older(scan, bounds);
    expect(earlier.times).toHaveLength(119);
    expect([earlier.times[0], Math.max(...earlier.times) < 1000]).toEqual([
      0,
      true,
    ]);
    scan = scanReducer(scan, {
      type: "checked",
      batch: earlier,
      samples: earlier.times.map(() => null),
    });
    expect([scan.oldest, scan.done, planOlder(scan, bounds)]).toEqual([
      0,
      true,
      "done",
    ]);
  });

  it("plan nothing without recordings and one slot for a single recording", () => {
    expect(
      planOlder(initialScan, { first: null, last: null, interval_s: 1 }),
    ).toBeNull();
    expect(planOlder(initialScan, null)).toBeNull();
    const single = older(initialScan, { first: 5, last: 5, interval_s: 0 });
    expect([single.times, single.step, single.reachesOldest]).toEqual([
      [5],
      1,
      true,
    ]);
  });

  it("add newer slots after the newest checked one, with a gap after a long skip", () => {
    const bounds = { first: 1000, last: 1900, interval_s: 1 };
    const first = older(initialScan, bounds);
    const scan = scanReducer(initialScan, {
      type: "checked",
      batch: first,
      samples: first.times.map(() => null),
    });
    const step = 900 / 119;
    expect(planNewer(scan, bounds)).toBeNull();
    const newer = planNewer(scan, { ...bounds, last: 1960 });
    expect(newer?.times).toHaveLength(Math.floor(60 / step));
    expect(newer?.times[0]).toBeCloseTo(1900 + step);
    const far = planNewer(scan, { ...bounds, last: 1900 + 500 * step });
    if (far?.kind !== "newer") throw Error("no newer batch");
    expect([far.times.length, far.gap]).toEqual([120, true]);
    const added = scanReducer(scan, {
      type: "checked",
      batch: far,
      samples: far.times.map((at) => ({ at, findings: [] })),
    });
    expect(added.samples).toHaveLength(120 + 1 + 120);
    expect(added.samples[120]).toBeNull();
    expect(added.newest).toBeCloseTo(1900 + 500 * step);
  });

  it("show an older-period error and keep a newer-batch error silent", () => {
    const failed = scanReducer(
      scanReducer(initialScan, { type: "start", kind: "older" }),
      { type: "failed", kind: "older", error: "bad at" },
    );
    expect([failed.busy, failed.error]).toEqual([null, "bad at"]);
    expect(
      scanReducer(initialScan, { type: "failed", kind: "newer", error: "x" })
        .error,
    ).toBe("");
  });
});
