// @vitest-environment node
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { openIncidentStore, scanPass } from "./scan";
import { serve } from "./serve";
import { getIncident, listIncidents } from "./incident-tools";

interface Result {
  incidents: { id: string; start: number; summary: string }[];
  incident: {
    timeline: object;
    top_contributing_threads: object[];
    evidence: unknown;
  };
  data: {
    completeness: string;
    store_available: boolean;
    scan_progress: object;
  };
  error: string;
  omitted_incidents: number;
  omitted_fields: string[];
}
const result = (text: string) => JSON.parse(text) as Result;
const dirs: string[] = [];
const stores: DatabaseSync[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "scout-tools-"));
  dirs.push(home);
  const data = join(home, "data");
  mkdirSync(join(data, "replay"), { recursive: true });
  const replay = new DatabaseSync(join(data, "replay/2026-10-29.sqlite3"));
  stores.push(replay);
  replay.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE process_snapshot(ts REAL PRIMARY KEY,snapshot TEXT)",
  );
  const base = Date.parse("2026-10-29T00:00:00Z") / 1000;
  const put = (offset: number, cpu: number, tid = 9) => {
    const at = base + offset;
    replay.prepare("INSERT INTO process_snapshot VALUES(?,?)").run(
      at,
      JSON.stringify({
        recorded_at: at,
        health: {
          session: "s",
          pid: 9,
          last_seen: at,
          sample_interval_ms: 1000,
        },
        threads: [
          {
            tid,
            name: "worker",
            generation: 1,
            last_sample: at,
            state: "running",
            cpu_pct: cpu,
            run_delay_pct: 0,
          },
        ],
      }),
    );
  };
  const path = join(home, "data/scout/incidents.sqlite3");
  const store = openIncidentStore(path);
  stores.push(store);
  const configPath = join(home, "collector.toml");
  writeFileSync(configPath, "[scout]\nenabled=true\n");
  vi.stubEnv("TRIANGULATOR_HOME", home);
  return { home, data, path, store, put, base, configPath };
}
const windowFor = (start: number, end = start + 86400) => ({
  window: { start, end },
});
const call = (id: number, name: string, args: object) =>
  JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  }) + "\n";

// Exercise the scan writer and MCP reader with a writer transaction still open.
test("answers a day question in one call, returns full stored evidence, and reads WAL without writes or HTTP", async () => {
  const { data, path, store, put, base, configPath } = fixture();
  put(61, 99);
  put(90, 99);
  put(91, 0);
  put(100, 99, 10);
  scanPass(data, store, -1);
  const before = store.prepare("SELECT * FROM incident ORDER BY first").all();
  store.exec("BEGIN IMMEDIATE; UPDATE incident SET count=999");
  const fetch = vi.spyOn(globalThis, "fetch");
  const input = new PassThrough(),
    output = new PassThrough();
  const replies: {
    result: { isError: boolean; content: { text: string }[] };
  }[] = [];
  output.on("data", (chunk: Buffer) =>
    replies.push(JSON.parse(chunk.toString()) as (typeof replies)[number]),
  );
  input.end(
    call(1, "list_incidents", windowFor(base)) +
      call(2, "get_incident", { id: before[0]?.id }),
  );
  expect(await serve({ configPath, input, output, log: () => {} })).toBe(0);
  expect(replies[0]?.result.isError).toBe(false);
  const listed = result(replies[0]?.result.content[0]?.text ?? "");
  expect(listed.incidents.map((i: { start: number }) => i.start)).toEqual([
    base + 100,
    base + 61,
  ]);
  expect(listed.incidents[1]).toMatchObject({
    target: "legacy",
    kind: "threads",
    severity: "serious",
    start: base + 61,
    end: base + 90,
    open: false,
  });
  expect(listed.incidents[1]?.summary).toContain("saturating");
  expect(listed.data.completeness).toBe("unknown");
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
  expect(replies[1]?.result.isError).toBe(false);
  const full = result(replies[1]?.result.content[0]?.text ?? "");
  expect(full.incident.timeline).toEqual({
    first: base + 61,
    worst: base + 61,
    last: base + 90,
    observations: 2,
  });
  expect(full.incident.top_contributing_threads[0]).toMatchObject({ tid: 9 });
  expect(full.incident.evidence).toEqual(
    (JSON.parse(String(before[0]?.detail)) as { item: unknown }).item,
  );
  expect(full.data.scan_progress).toMatchObject({ oldest_cursor: base + 100 });
  store.exec("ROLLBACK");
  expect(store.prepare("SELECT * FROM incident ORDER BY first").all()).toEqual(
    before,
  );
  expect(
    result(listIncidents(path, { ...windowFor(base), target: "other" }))
      .incidents,
  ).toEqual([]);
  expect(
    result(listIncidents(path, windowFor(base + 70, base + 80))).incidents,
  ).toHaveLength(1);
  expect(
    result(listIncidents(path, windowFor(base, base + 61))).incidents,
  ).toEqual([]);
});

test("active incidents overlap only their stored observation interval", () => {
  const { data, path, store, put, base } = fixture();
  put(61, 99);
  put(90, 99);
  scanPass(data, store, -1);

  const observed = result(listIncidents(path, windowFor(base + 70, base + 80)));
  expect(observed.incidents).toHaveLength(1);
  expect(observed.incidents[0]).toMatchObject({
    start: base + 61,
    end: null,
    open: true,
    last_observed: base + 90,
  });
  expect(
    result(listIncidents(path, windowFor(base + 90, base + 91))).incidents,
  ).toHaveLength(1);
  expect(
    result(listIncidents(path, windowFor(base, base + 61))).incidents,
  ).toEqual([]);

  for (const start of [base + 91, base + 86400]) {
    const later = result(listIncidents(path, windowFor(start)));
    expect(later.incidents).toEqual([]);
    expect(later.omitted_incidents).toBe(0);
  }
});

test("missing store gives scan instructions without creating a file; invalid input is rejected", () => {
  const { home, base } = fixture();
  const path = join(home, "missing/incidents.sqlite3");
  const id = JSON.stringify(["legacy", "s", "not-found"]);
  for (const text of [
    listIncidents(path, windowFor(base)),
    getIncident(path, { id }),
  ]) {
    const parsed = result(text);
    expect(parsed.error).toContain("tri-scout scan has not run");
    expect(parsed.data.store_available).toBe(false);
  }
  expect(existsSync(join(home, "missing"))).toBe(false);
  for (const window of [
    undefined,
    {},
    { start: -1, end: 1 },
    { start: 2, end: 1 },
    { start: 1, end: 1 },
    { start: 0, end: Infinity },
    { start: "1", end: 2 },
  ])
    expect(() => listIncidents(path, { window })).toThrow("window");
  for (const id of [
    undefined,
    "",
    "' OR 1=1",
    "[]",
    "[1,2,3]",
    "x".repeat(2049),
  ])
    expect(() => getIncident(path, { id })).toThrow("id");
  expect(() => listIncidents(path, { ...windowFor(base), target: 4 })).toThrow(
    "target",
  );
});

test("incident calls stop when the switch turns off", async () => {
  const { configPath, base } = fixture();
  const input = new PassThrough(),
    output = new PassThrough();
  const replies: { result: { isError: boolean } }[] = [];
  const first = new Promise<void>((resolve) => output.once("data", resolve));
  output.on("data", (chunk: Buffer) =>
    replies.push(JSON.parse(chunk.toString()) as (typeof replies)[number]),
  );
  const running = serve({ configPath, input, output, log: () => {} });
  input.write(call(1, "list_incidents", windowFor(base)));
  await first;
  writeFileSync(configPath, "[scout]\nenabled=false\n");
  input.end(call(2, "get_incident", { id: "invalid" }));
  expect(await running).toBe(2);
  expect(replies.map((r) => r.result.isError)).toEqual([false, true]);
});

test("limits lists to 20 findings and 16 KiB, bounds full evidence, and reports omissions", () => {
  const { data, path, store, put, base } = fixture();
  for (let n = 0; n < 30; n++) put(n, 99, n + 1);
  scanPass(data, store, -1);
  const listed = result(listIncidents(path, windowFor(base)));
  expect(listed.incidents).toHaveLength(20);
  expect(listed.omitted_incidents).toBe(10);
  const id = listed.incidents[0]?.id;
  if (!id) throw Error("missing incident");
  const row = store.prepare("SELECT detail FROM incident WHERE id=?").get(id);
  const detail = JSON.parse(String(row?.detail)) as {
    item: { detail: string; title: string };
  };
  detail.item.detail = "evidence".repeat(10000);
  detail.item.title = "界".repeat(2000);
  store.prepare("UPDATE incident SET detail=?").run(JSON.stringify(detail));
  for (const text of [
    listIncidents(path, windowFor(base)),
    getIncident(path, { id }),
  ]) {
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16384);
    expect(result(text).data.completeness).toBe("unknown");
  }
  expect(
    result(listIncidents(path, windowFor(base))).omitted_incidents,
  ).toBeGreaterThan(10);
  expect(result(getIncident(path, { id })).omitted_fields).toContain(
    "evidence",
  );
  expect(
    result(
      getIncident(path, { id: JSON.stringify(["legacy", "s", "expired"]) }),
    ).error,
  ).toContain("not found");
});
