// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { serve } from "./serve";
import { historyTools } from "./history-tools";
import { object } from "../api/replay";

function snapshot(at: number, session: string) {
  return {
    first: 1,
    last: 301,
    interval_s: 10,
    snapshot: {
      recorded_at: at,
      health: { session, pid: 7, last_seen: at },
      threads: [{ tid: 7, name: "worker", generation: 1 }],
    },
  };
}
function row(ts: number, generation = 1, valid = 1) {
  return {
    ts,
    generation,
    valid,
    samples: valid ? 10 : 1,
    expected_samples: 10,
    cpu_pct: valid ? 20 : 999,
    run_delay_pct: 2,
    read_bps: 40,
    write_bps: 80,
    sample_counts: {},
  };
}

test("history tools use real GET history requests, isolate lifetimes, bound results, and check the switch", async () => {
  const requests: { method: string | undefined; url: URL }[] = [];
  let many = false;
  // As after a collector restart: no sampler has registered host/worker
  // again, but the collector answers for its stored data, and 404 for a key
  // with no data.
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://localhost");
    requests.push({ method: req.method, url });
    res.setHeader("content-type", "application/json");
    if (url.searchParams.get("target") !== "host/worker") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "unknown target" }));
    } else if (url.pathname === "/api/replay") {
      const at = Number(url.searchParams.get("at"));
      if (url.searchParams.get("direction") === "at") {
        res.end(
          JSON.stringify(
            at < 1
              ? { first: 1, last: 301, interval_s: 10, snapshot: null }
              : at < 301
                ? snapshot(1, "101")
                : snapshot(301, "202"),
          ),
        );
        return;
      }
      res.end(
        JSON.stringify(
          at < 1
            ? snapshot(1, "101")
            : at < 301
              ? snapshot(301, "202")
              : { first: 1, last: 301, interval_s: 10, snapshot: null },
        ),
      );
    } else if (url.pathname === "/api/history") {
      const second = url.searchParams.get("session") === "202";
      res.end(
        JSON.stringify({
          rows: second
            ? [{ ...row(301), cpu_pct: 60 }]
            : Array.from({ length: 300 }, (_, i) =>
                row(i + 1, many ? i + 1 : i < 150 ? 1 : 2, i === 20 ? 0 : 1),
              ),
          limit: 2000,
          truncated: false,
        }),
      );
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("no server address");
  const dir = mkdtempSync(join(tmpdir(), "scout-history-"));
  const configPath = join(dir, "collector.toml");
  writeFileSync(
    configPath,
    `http_port = ${String(address.port)}\n[scout]\nenabled = true\n`,
  );
  const input = new PassThrough(),
    output = new PassThrough();
  const replies: {
    result: { isError: boolean; content: { text: string }[] };
  }[] = [];
  let next: (() => void) | undefined;
  output.on("data", (chunk: Buffer) => {
    replies.push(JSON.parse(chunk.toString()) as (typeof replies)[number]);
    next?.();
  });
  const running = serve({ configPath, input, output, log: () => {} });
  async function call(name: string, args: object) {
    const ready = new Promise<void>((resolve) => {
      next = resolve;
    });
    input.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: replies.length,
        method: "tools/call",
        params: { name, arguments: args },
      }) + "\n",
    );
    await ready;
    const reply = replies.at(-1);
    if (!reply) throw Error("no reply");
    return reply.result;
  }
  const window = { start: 0, end: 400 };
  try {
    const ranked = await call("top_threads", {
      target: "host/worker",
      window,
      metric: "cpu_pct",
      n: 100,
    });
    expect(ranked.isError, JSON.stringify(ranked)).toBe(false);
    const top = JSON.parse(ranked.content[0]?.text ?? "") as {
      rows: { thread: string; mean: number }[];
      data: unknown;
    };
    expect(top.rows).toHaveLength(3);
    expect(
      new Set(top.rows.map((r: { thread: string }) => r.thread)).size,
    ).toBe(3);
    expect(top.rows.map((r) => r.mean)).toEqual([60, 20, 20]);
    expect(top.data).toMatchObject({
      completeness: "unknown",
      invalid_rollups: 1,
      missing_samples: 9,
      sampler_throttling: "unknown",
    });
    expect(ranked.content[0]?.text).not.toMatch(
      /generation|valid":|session|sqlite/,
    );
    const series = await call("timeseries", {
      target: "host/worker",
      window,
      metric: "cpu_pct",
      step: 0.01,
    });
    const points = JSON.parse(series.content[0]?.text ?? "") as {
      rows: { mean: number }[];
    };
    expect(points.rows.length).toBeLessThanOrEqual(100);
    expect(points.rows.length).toBeGreaterThan(50);
    expect(
      points.rows.every(
        (r: { mean: number }) => r.mean === 20 || r.mean === 40,
      ),
    ).toBe(true);
    expect(points.rows.at(-1)?.mean).toBe(40);
    const thread = await call("timeseries", {
      target: "host/worker",
      window,
      metric: "cpu_pct",
      thread: top.rows[0]?.thread,
    });
    expect(
      (JSON.parse(thread.content[0]?.text ?? "") as { rows: unknown[] }).rows
        .length,
    ).toBeLessThan(50);
    const compared = await call("compare", {
      target: "host/worker",
      window_a: window,
      window_b: { start: 300, end: 400 },
    });
    expect(
      (JSON.parse(compared.content[0]?.text ?? "") as { rows: unknown[] }).rows,
    ).toEqual([
      { metric: "cpu_pct", a: 6040 / 300, b: 40, change: 40 - 6040 / 300 },
      { metric: "run_delay_pct", a: 2, b: 2, change: 0 },
      { metric: "read_bps", a: 40, b: 40, change: 0 },
      { metric: "write_bps", a: 80, b: 80, change: 0 },
    ]);
    for (const reply of [ranked, series, thread, compared])
      expect(
        Buffer.byteLength(reply.content[0]?.text ?? ""),
      ).toBeLessThanOrEqual(16384);
    for (const args of [
      { metric: "unknown" },
      { step: 0 },
      { window: { start: 1, end: 0 } },
      { thread: 7 },
    ]) {
      const before = requests.length;
      expect(
        (
          await call("timeseries", {
            target: "host/worker",
            window,
            metric: "cpu_pct",
            ...args,
          })
        ).isError,
      ).toBe(true);
      expect(requests).toHaveLength(before);
    }
    const histories = requests.filter((r) => r.url.pathname === "/api/history");
    expect(histories.length).toBeGreaterThan(0);
    for (const { url } of histories) {
      expect(url.searchParams.get("target")).toBe("host/worker");
      expect(["101", "202"]).toContain(url.searchParams.get("session"));
      expect(url.searchParams.get("tid")).toBe("7");
      expect(url.searchParams.has("start")).toBe(true);
      expect(url.searchParams.has("end")).toBe(true);
    }
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    expect(requests.some((r) => r.url.pathname === "/api/fleet")).toBe(false);
    const unknown = await call("timeseries", {
      target: "host/nope",
      window,
      metric: "cpu_pct",
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]?.text).toContain("Unknown target.");
    many = true;
    const capped = await call("top_threads", {
      target: "host/worker",
      window,
      metric: "cpu_pct",
      n: 100,
    });
    const cappedResult = JSON.parse(capped.content[0]?.text ?? "") as {
      rows: unknown[];
      unlisted_threads: number;
    };
    expect(cappedResult.rows).toHaveLength(20);
    expect(cappedResult.unlisted_threads).toBe(280);
    expect(
      Buffer.byteLength(capped.content[0]?.text ?? ""),
    ).toBeLessThanOrEqual(16384);
    const before = requests.length;
    writeFileSync(configPath, "[scout]\nenabled = false\n");
    expect(
      (
        await call("top_threads", {
          target: "host/worker",
          window,
          metric: "cpu_pct",
          n: 2,
        })
      ).isError,
    ).toBe(true);
    expect(await running).toBe(2);
    expect(requests).toHaveLength(before);
  } finally {
    input.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["session", "generation", "session with different TID"])(
  "target history excludes transition totals for %s at one timestamp",
  async (transition) => {
    const session = transition.startsWith("session") ? "202" : "101";
    const tid = transition === "session with different TID" ? 9 : 7;
    const partial = {
      ...row(10),
      samples: 5,
      expected_samples: 5,
      cpu_pct: 100,
    };
    function response(path: string) {
      const url = new URL(path, "http://localhost");
      if (url.pathname === "/api/replay") {
        const at = Number(url.searchParams.get("at"));
        if (url.searchParams.get("direction") === "at")
          return snapshot(11, "101");
        if (at < 16) {
          const next = snapshot(16, session);
          next.snapshot.threads = [
            { tid, name: "worker", generation: 2 },
            { tid: 8, name: "peer", generation: 1 },
          ];
          return next;
        }
        return { first: 11, last: 16, interval_s: 10, snapshot: null };
      }
      if (url.pathname === "/api/history") {
        const currentTid = Number(url.searchParams.get("tid"));
        const currentSession = url.searchParams.get("session");
        const rows =
          currentTid === 8
            ? [{ ...row(20), cpu_pct: 10 }]
            : currentSession === "101" && currentTid === 7
              ? transition === "generation"
                ? [
                    partial,
                    { ...partial, generation: 2 },
                    { ...row(20, 2), cpu_pct: 30 },
                  ]
                : [partial]
              : [
                  { ...partial, generation: 2 },
                  { ...row(20, 2), cpu_pct: 30 },
                ];
        return { rows, limit: 2000, truncated: false };
      }
      throw Error(`Unexpected request: ${path}`);
    }
    const tools = historyTools((path) => Promise.resolve(response(path)));
    function resultRows(text: string): unknown[] {
      const result: unknown = JSON.parse(text);
      if (!object(result) || !Array.isArray(result.rows))
        throw Error("Missing result rows");
      return result.rows;
    }
    const series = tools.find((tool) => tool.name === "timeseries");
    const compare = tools.find((tool) => tool.name === "compare");
    const top = tools.find((tool) => tool.name === "top_threads");
    if (!series || !compare || !top) throw Error("Missing history tool");
    const args = {
      target: "host/worker",
      metric: "cpu_pct",
      window: { start: 10, end: 30 },
      step: 10,
    };
    expect(resultRows(await series.run(args))).toEqual([
      { at: 10, mean: null },
      { at: 20, mean: 40 },
    ]);
    const compared = resultRows(
      await compare.run({
        target: args.target,
        window_a: { start: 10, end: 20 },
        window_b: { start: 20, end: 30 },
      }),
    );
    expect(compared).toEqual([
      { metric: "cpu_pct", a: null, b: 40, change: null },
      { metric: "run_delay_pct", a: null, b: 4, change: null },
      { metric: "read_bps", a: null, b: 80, change: null },
      { metric: "write_bps", a: null, b: 160, change: null },
    ]);
    const ranked = resultRows(await top.run({ ...args, n: 10 }));
    const lifetime = ranked.find((item) => object(item) && item.mean === 100);
    if (!object(lifetime) || typeof lifetime.thread !== "string")
      throw Error("Missing lifetime token");
    expect(
      resultRows(await series.run({ ...args, thread: lifetime.thread })),
    ).toEqual([{ at: 10, mean: 100 }]);
  },
);
