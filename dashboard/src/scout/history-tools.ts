import { createHash } from "node:crypto";
import { object, parseReplay } from "../api/replay";
import type { Tool } from "./mcp";
import { LIMITS, parseFleet, ToolError } from "./tools";

const METRICS = ["cpu_pct", "run_delay_pct", "read_bps", "write_bps"] as const;
type Metric = (typeof METRICS)[number];
type Window = { start: number; end: number };
type Row = {
  ts: number;
  values: Record<Metric, number | null>;
  usable: boolean;
  missing: number;
};
type Lifetime = {
  id: string;
  session: string;
  tid: number;
  generation: number;
  rows: Row[];
};
const MAX_THREADS = 64;
const MAX_RECORDINGS = 64;
const MAX_POINTS = 100;

function windowInput(value: unknown): Window {
  if (
    !object(value) ||
    !finite(value.start) ||
    !finite(value.end) ||
    value.start < 0 ||
    value.end > 253402214400 ||
    value.end <= value.start
  )
    throw new ToolError(
      "window requires 0 <= start < end <= 253402214400 in Unix seconds. End is exclusive.",
    );
  return { start: value.start, end: value.end };
}
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
function metricInput(value: unknown): Metric {
  const metric = METRICS.find((metric) => metric === value);
  if (!metric)
    throw new ToolError(`metric must be one of ${METRICS.join(", ")}.`);
  return metric;
}
function rowInput(raw: unknown): { row: Row; generation: number } {
  if (
    !object(raw) ||
    !finite(raw.ts) ||
    !Number.isSafeInteger(raw.generation) ||
    !finite(raw.generation) ||
    !finite(raw.samples) ||
    raw.samples < 0 ||
    !finite(raw.expected_samples) ||
    raw.expected_samples < 0 ||
    (raw.valid !== 0 && raw.valid !== 1)
  )
    throw new ToolError("The collector returned an unreadable history row.");
  const value = (key: Metric) => {
    const item = raw[key];
    if (item !== null && !finite(item))
      throw new ToolError("The collector returned an unreadable metric.");
    return item;
  };
  return {
    generation: raw.generation,
    row: {
      ts: raw.ts,
      usable: raw.valid === 1,
      missing: Math.max(0, raw.expected_samples - raw.samples),
      values: {
        cpu_pct: value("cpu_pct"),
        run_delay_pct: value("run_delay_pct"),
        read_bps: value("read_bps"),
        write_bps: value("write_bps"),
      },
    },
  };
}

// Lifetime tokens hide storage keys while retaining session and TID-reuse isolation.
const identity = (session: string, tid: number, generation: number) =>
  createHash("sha256")
    .update(JSON.stringify([session, tid, generation]))
    .digest("hex")
    .slice(0, 24);

async function history(
  get: (path: string) => Promise<unknown>,
  target: string,
  window: Window,
) {
  const pairs = new Map<string, { session: string; tid: number }>();
  let at = window.start;
  let recordings = 0;
  let discoveryLimited = false;
  // The history API needs a session and TID. Recorded views supply these keys.
  for (; recordings < MAX_RECORDINGS; recordings++) {
    const replay = parseReplay(
      await get(
        `/api/replay?${new URLSearchParams({ target, at: String(at), direction: recordings === 0 ? "at" : "next" })}`,
      ),
    );
    const view = replay.snapshot;
    if (!view) {
      if (recordings === 0) {
        at = Math.max(0, window.start - 0.001);
        continue;
      }
      break;
    }
    if (view.recorded_at >= window.end) break;
    if (recordings > 0 && view.recorded_at <= at)
      throw new ToolError("The collector recording cursor did not advance.");
    at = view.recorded_at;
    const session = view.health.session;
    if (!session || !/^\d+$/.test(session)) continue;
    for (const thread of view.threads) {
      const key = JSON.stringify([session, thread.tid]);
      if (pairs.has(key)) continue;
      if (pairs.size >= MAX_THREADS) {
        discoveryLimited = true;
        continue;
      }
      pairs.set(key, { session, tid: thread.tid });
    }
  }
  const lifetimes = new Map<string, Lifetime>();
  let truncated = false;
  let invalid = 0;
  let missing = 0;
  for (const { session, tid } of pairs.values()) {
    const raw = await get(
      `/api/history?${new URLSearchParams({ target, session, tid: String(tid), start: String(window.start), end: String(window.end) })}`,
    );
    if (
      !object(raw) ||
      !Array.isArray(raw.rows) ||
      typeof raw.truncated !== "boolean" ||
      !finite(raw.limit) ||
      raw.rows.length > 2000
    )
      throw new ToolError("The collector returned unreadable history.");
    truncated ||= raw.truncated;
    for (const entry of raw.rows) {
      const { row, generation } = rowInput(entry);
      if (row.ts < window.start || row.ts >= window.end) continue;
      const id = identity(session, tid, generation);
      let lifetime = lifetimes.get(id);
      if (!lifetime) {
        lifetime = { id, session, tid, generation, rows: [] };
        lifetimes.set(id, lifetime);
      }
      lifetime.rows.push(row);
      invalid += Number(!row.usable);
      missing += row.missing;
    }
  }
  return {
    lifetimes: [...lifetimes.values()],
    data: {
      completeness: "unknown",
      invalid_rollups: invalid,
      missing_samples: missing,
      history_truncated: truncated,
      discovery_limited: discoveryLimited || recordings === MAX_RECORDINGS,
      sampler_throttling: "unknown",
      gaps: [
        "Only threads present in inspected recordings can be discovered. Missing recordings and unreadable history are not reported by the collector. Missing samples can include packet loss or sampler throttling. History cannot prove complete window coverage.",
        "Target totals exclude timestamps that contain different lifetimes of one thread or different sampler runs; stored rows cannot establish overlap.",
      ],
    },
  };
}

function average(rows: readonly Row[], metric: Metric) {
  const values = rows
    .filter((row) => row.usable)
    .flatMap((row) =>
      row.values[metric] === null ? [] : [row.values[metric]],
    );
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : null;
}
function bounded(result: object, rows: object[]) {
  const total = rows.length;
  for (;;) {
    const text = JSON.stringify({
      ...result,
      rows,
      omitted_rows: total - rows.length,
    });
    if (Buffer.byteLength(text) <= LIMITS.bytes) return text;
    if (!rows.length)
      throw new ToolError("History result exceeds the size limit.");
    rows.pop();
  }
}
const windowSchema = {
  type: "object",
  required: ["start", "end"],
  properties: {
    start: { type: "number", minimum: 0 },
    end: { type: "number", description: "Exclusive Unix seconds." },
  },
};

export function historyTools(get: (path: string) => Promise<unknown>): Tool[] {
  return ["timeseries", "top_threads", "compare"].map((name) => ({
    name,
    description: `${name}: historical rollup means for cpu_pct, run_delay_pct, read_bps, write_bps. Threads have opaque lifetime tokens. Coverage and sampler throttling can be unknown; state all gaps. Means weight rollup rows equally. At most 16 KiB, 100 time points or 20 ranked threads. Discovery inspects at most 64 recordings and 64 session/thread pairs.`,
    inputSchema: {
      type: "object",
      required:
        name === "compare"
          ? ["target", "window_a", "window_b"]
          : name === "top_threads"
            ? ["target", "metric", "window", "n"]
            : ["target", "metric", "window"],
      properties: {
        target: { type: "string" },
        thread: {
          type: "string",
          description:
            "Opaque thread token from top_threads; omit for target totals.",
        },
        metric: { enum: METRICS },
        window: windowSchema,
        window_a: windowSchema,
        window_b: windowSchema,
        step: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Bucket seconds; increased to keep at most 100 points.",
        },
        n: { type: "integer", minimum: 1, description: "Capped at 20." },
      },
    },
    run: async (args) => {
      if (
        typeof args.target !== "string" ||
        !args.target.trim() ||
        Buffer.byteLength(args.target) > 1024
      )
        throw new ToolError(
          "target must be an exact target key, at most 1024 bytes.",
        );
      if (
        args.thread !== undefined &&
        (typeof args.thread !== "string" || !/^[a-f0-9]{24}$/.test(args.thread))
      )
        throw new ToolError(
          "thread must be a lifetime token from top_threads.",
        );
      if (args.step !== undefined && (!finite(args.step) || args.step <= 0))
        throw new ToolError("step must be positive finite seconds.");
      if (
        name === "top_threads" &&
        (!finite(args.n) || !Number.isSafeInteger(args.n) || args.n < 1)
      )
        throw new ToolError("n must be a positive integer.");
      const metric = name === "compare" ? "cpu_pct" : metricInput(args.metric);
      const window = windowInput(
        name === "compare" ? args.window_a : args.window,
      );
      const other = name === "compare" ? windowInput(args.window_b) : null;
      const fleet = parseFleet(await get("/api/fleet"));
      if (!fleet.targets.some((target) => target.key === args.target))
        throw new ToolError(
          "Unknown target. Use an exact key from list_targets.",
        );
      const a = await history(get, args.target, window);
      // Stored transition rows do not establish duration or overlap.
      // Sum only one sampler session and one lifetime per TID at each timestamp.
      const totals = (lifetimes: Lifetime[]) => {
        const rows = new Map<
          number,
          { row: Row; session: string; tids: Set<number> }
        >();
        for (const lifetime of lifetimes)
          for (const row of lifetime.rows) {
            if (!row.usable) continue;
            const existing = rows.get(row.ts);
            let total = existing?.row;
            if (existing) {
              if (
                existing.session !== lifetime.session ||
                existing.tids.has(lifetime.tid)
              )
                existing.row.usable = false;
              existing.tids.add(lifetime.tid);
            }
            if (!total) {
              total = {
                ...row,
                values: {
                  cpu_pct: null,
                  run_delay_pct: null,
                  read_bps: null,
                  write_bps: null,
                },
              };
              rows.set(row.ts, {
                row: total,
                session: lifetime.session,
                tids: new Set([lifetime.tid]),
              });
            }
            for (const key of METRICS)
              if (row.values[key] !== null)
                total.values[key] = (total.values[key] ?? 0) + row.values[key];
          }
        return [...rows.values()].map((item) => item.row);
      };
      if (other) {
        const b = await history(get, args.target, other);
        const ra = totals(a.lifetimes),
          rb = totals(b.lifetimes);
        return bounded(
          { window_a: window, window_b: other, data: { a: a.data, b: b.data } },
          METRICS.map((metric) => {
            const va = average(ra, metric),
              vb = average(rb, metric);
            return {
              metric,
              a: va,
              b: vb,
              change: va === null || vb === null ? null : vb - va,
            };
          }),
        );
      }
      if (name === "top_threads") {
        const ranked = a.lifetimes
          .map((lifetime) => ({
            thread: lifetime.id,
            mean: average(lifetime.rows, metric),
          }))
          .filter((row) => row.mean !== null)
          .sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0));
        const n = Math.min(Number(args.n), LIMITS.findings);
        return bounded(
          {
            metric,
            window,
            data: a.data,
            unlisted_threads: Math.max(0, ranked.length - n),
          },
          ranked.slice(0, n),
        );
      }
      const selected =
        args.thread === undefined
          ? a.lifetimes
          : a.lifetimes.filter((item) => item.id === args.thread);
      const rows =
        args.thread === undefined
          ? totals(selected)
          : selected.flatMap((item) => item.rows);
      const step = Math.max(
        finite(args.step) ? args.step : 1,
        (window.end - window.start) / MAX_POINTS,
      );
      const buckets = new Map<number, Row[]>();
      for (const row of rows) {
        const bucket = Math.min(
          MAX_POINTS - 1,
          Math.floor((row.ts - window.start) / step),
        );
        const values = buckets.get(bucket) ?? [];
        values.push(row);
        buckets.set(bucket, values);
      }
      return bounded(
        { metric, window, step, data: a.data },
        [...buckets]
          .sort(([a], [b]) => a - b)
          .map(([bucket, rows]) => ({
            at: window.start + bucket * step,
            mean: average(rows, metric),
          })),
      );
    },
  }));
}
