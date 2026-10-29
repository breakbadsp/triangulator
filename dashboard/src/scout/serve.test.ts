// @vitest-environment node
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, test } from "vitest";
import type { LiveResponse, Target } from "../api/types";
import { fleetAssessment } from "../lib/assess";
import { serve } from "./serve";

interface Reply {
  id: number;
  result?: {
    content?: { text: string }[];
    isError?: boolean;
    tools?: { name: string }[];
  };
  error?: { code: number };
}

let server: Server | undefined;
afterEach(() => server?.close());

const now = () => Date.now() / 1000;

function target(key: string, extra: Partial<Target> = {}): Target {
  return {
    key,
    host: "app-host",
    id: key,
    pid: 7,
    status: "live",
    process: { command: "/usr/bin/" + key },
    ...extra,
  };
}

function live(cpu: number): LiveResponse {
  return {
    health: {
      session: "s1",
      pid: 7,
      last_seen: now(),
      sampler_silent: false,
      target_absent: false,
      packet_loss_pct: 0.5,
      sample_interval_ms: 200,
    },
    threads: [
      {
        tid: 7,
        name: "orders",
        last_sample: now(),
        cpu_pct: cpu,
        state: "running",
      },
    ],
  };
}

/** A collector stand-in that records each request it gets. */
async function collector(fleet: object) {
  const requests: string[] = [];
  server = createServer((request, response) => {
    requests.push(`${String(request.method)} ${String(request.url)}`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(fleet));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, requests };
}

function config(text: string) {
  const path = join(
    mkdtempSync(join(tmpdir(), "tri-scout-")),
    "collector.toml",
  );
  writeFileSync(path, text);
  return path;
}

const enabled = (port: number, on = true) =>
  `http_host = "0.0.0.0"\nhttp_port = ${String(port)}\n[scout]\nenabled = ${String(on)}\n`;

const call = (id: number, name: string, args: object = {}) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

/** Runs serve on the given lines and returns its status and replies. */
async function session(configPath: string, lines: readonly string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const logs: string[] = [];
  let text = "";
  output.on("data", (chunk: Buffer) => (text += chunk.toString()));
  input.end(lines.join("\n") + "\n");
  const status = await serve({
    configPath,
    input,
    output,
    log: (line) => logs.push(line),
  });
  const replies = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Reply);
  return { status, replies, logs };
}

const resultText = (reply: Reply | undefined) =>
  reply?.result?.content?.[0]?.text ?? "";

test("with the switch off, tri-scout exits 2, answers nothing, and sends no request", async () => {
  const { port, requests } = await collector({});
  for (const path of [
    config(`http_port = ${String(port)}\n`),
    config(enabled(port, false)),
    config("[scout]\nenabled = 'yes'\n"),
    join(tmpdir(), "no-such-dir", "collector.toml"),
  ]) {
    const run = await session(path, [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }),
      call(2, "status_now"),
    ]);
    expect(run.status).toBe(2);
    expect(run.replies).toEqual([]);
    expect(run.logs[0]).toContain("tri-scout is disabled");
  }
  expect(requests).toEqual([]);
});

test("status_now gives the Targets page assessment with data completeness, using GET only", async () => {
  const busy = live(99);
  const { port, requests } = await collector({
    list: { targets: [target("idle"), target("orders", { throttled: true })] },
    live: { idle: live(1), orders: busy },
  });
  const run = await session(config(enabled(port)), [
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    call(3, "status_now"),
    call(4, "status_now", { target: "nope" }),
  ]);
  expect(run.status).toBe(0);
  expect(run.replies.map((reply) => reply.id)).toEqual([1, 2, 3, 4]);
  expect(run.replies[1]?.result?.tools?.map((tool) => tool.name)).toEqual([
    "timeseries",
    "top_threads",
    "compare",
    "list_targets",
    "status_now",
    "list_incidents",
    "get_incident",
  ]);
  const status = JSON.parse(resultText(run.replies[2])) as {
    targets: {
      key: string;
      level: string;
      findings: { title: string }[];
      data: Record<string, unknown>;
    }[];
  };
  // A thread at 99% CPU is serious on the Targets page; worst target first.
  expect(status.targets.map((row) => [row.key, row.level])).toEqual([
    ["orders", "serious"],
    ["idle", "good"],
  ]);
  expect(status.targets[0]?.findings.map((item) => item.title)).toEqual(
    fleetAssessment(busy, now())?.findings.map((item) => item.title),
  );
  expect(status.targets[0]?.data).toMatchObject({
    status: "live",
    view_readable: true,
    sampler_throttled: true,
    packet_loss_pct: 0.5,
    sample_interval_ms: 200,
    session: "s1",
  });
  expect(run.replies[3]?.result?.isError).toBe(true);
  expect(resultText(run.replies[3])).toContain("Unknown target nope");
  expect(requests).toEqual(["GET /api/fleet", "GET /api/fleet"]);
});

test("each result stays inside the size limit and says what it left out", async () => {
  const targets = Array.from({ length: 300 }, (_, index) =>
    target(`target-${String(index)}`),
  );
  const { port } = await collector({ list: { targets }, live: {} });
  const run = await session(config(enabled(port)), [
    call(1, "list_targets"),
    call(2, "status_now"),
  ]);
  for (const reply of run.replies) {
    const text = resultText(reply);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16_384);
    const result = JSON.parse(text) as {
      targets: unknown[];
      omitted_targets: number;
    };
    expect(result.targets.length).toBeGreaterThan(0);
    expect(result.targets.length + result.omitted_targets).toBe(300);
  }
  const status = JSON.parse(resultText(run.replies[1])) as {
    targets: { level: string; data: { view_readable: boolean } }[];
  };
  expect(status.targets[0]).toMatchObject({
    level: "unknown",
    data: { view_readable: false },
  });
});

test("turning the switch off ends a running session at its next tool call", async () => {
  const { port, requests } = await collector({
    list: { targets: [] },
    live: {},
  });
  const path = config(enabled(port));
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Reply[] = [];
  const first = new Promise<void>((resolve) =>
    output.on("data", (chunk: Buffer) => {
      replies.push(JSON.parse(chunk.toString()) as Reply);
      resolve();
    }),
  );
  const running = serve({
    configPath: path,
    input,
    output,
    log: () => undefined,
  });
  input.write(call(1, "list_targets") + "\n");
  await first;
  writeFileSync(path, enabled(port, false));
  input.end(call(2, "list_targets") + "\n" + call(3, "list_targets") + "\n");
  expect(await running).toBe(2);
  expect(replies.map((reply) => [reply.id, reply.result?.isError])).toEqual([
    [1, false],
    [2, true],
  ]);
  expect(requests).toEqual(["GET /api/fleet"]);
});
