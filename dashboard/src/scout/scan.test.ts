// @vitest-environment node
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { openIncidentStore, scan, scanPass } from "./scan";
import { initialScan, planOlder } from "../lib/pastAssessments";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "scout-scan-"));
  dirs.push(dir);
  const replay = join(dir, "replay");
  mkdirSync(replay);
  const db = new DatabaseSync(join(replay, "2026-10-29.sqlite3"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE process_snapshot(ts REAL PRIMARY KEY,snapshot TEXT)",
  );
  const put = (at: number, bad: boolean) =>
    db.prepare("INSERT INTO process_snapshot VALUES(?,?)").run(
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
            tid: 9,
            name: "worker",
            generation: 1,
            last_sample: at,
            state: "running",
            cpu_pct: bad ? 99 : 0,
            run_delay_pct: 0,
          },
        ],
      }),
    );
  return { dir, db, put };
}

test("stores a 30 s incident between Timeline slots, resumes without duplicates, and prunes", () => {
  const { dir, db, put } = fixture();
  // An older six-hour Timeline period has slots about 181 seconds apart.
  const batch = planOlder(
    { ...initialScan, oldest: 21600, chunk: 21600 },
    { first: 0, last: 21600, interval_s: 1 },
  );
  if (!batch || batch === "done") throw Error("missing Timeline batch");
  expect(batch.times.some((t) => t >= 61 && t <= 90)).toBe(false);
  for (let at = 0; at <= 100; at++) put(at, at >= 61 && at <= 90);
  const path = join(dir, "scout/incidents.sqlite3");
  let store = openIncidentStore(path);
  scanPass(dir, store, -1);
  const incident = store
    .prepare("SELECT first,last,count FROM incident WHERE first=61")
    .get();
  expect(incident).toMatchObject({ first: 61, last: 90, count: 30 });
  store.close();
  store = openIncidentStore(path);
  scanPass(dir, store, -1);
  expect(
    store.prepare("SELECT first,last,count FROM incident WHERE first=61").get(),
  ).toEqual(incident);
  scanPass(dir, store, 101);
  expect(store.prepare("SELECT count(*) AS n FROM incident").get()?.n).toBe(0);
  expect(store.prepare("SELECT ts FROM cursor").get()?.ts).toBe(100);
  store.close();
  db.close();
});

test("keeps one incident across passes and process restarts", () => {
  const { dir, db, put } = fixture();
  put(1, true);
  put(2, true);
  const path = join(dir, "scout/incidents.sqlite3");
  let store = openIncidentStore(path);
  scanPass(dir, store, -1);
  store.close();
  put(3, true);
  put(4, false);
  store = openIncidentStore(path);
  scanPass(dir, store, -1);
  expect(
    store.prepare("SELECT first,last,count FROM incident WHERE first=1").get(),
  ).toMatchObject({ first: 1, last: 3, count: 3 });
  store.close();
  db.close();
});

test("disabled scan exits 2 before it creates any store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "scout-off-"));
  dirs.push(dir);
  const configPath = join(dir, "collector.toml");
  writeFileSync(configPath, "[scout]\nenabled=false\n");
  const previous = process.env.TRIANGULATOR_HOME;
  process.env.TRIANGULATOR_HOME = dir;
  try {
    expect(await scan({ configPath, log: () => {} })).toBe(2);
    expect(existsSync(join(dir, "data"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.TRIANGULATOR_HOME;
    else process.env.TRIANGULATOR_HOME = previous;
  }
});

test("reads shared resource rows by session for each target and carries trends across midnight", () => {
  const { dir, db } = fixture();
  db.close();
  const base = Date.parse("2026-10-29T00:00:30Z") / 1000;
  for (const day of ["2026-10-28", "2026-10-29"]) {
    const resources = new DatabaseSync(join(dir, `${day}.sqlite3`));
    resources.exec(
      "CREATE TABLE resource_sample(ts REAL,pid INTEGER,session TEXT,elapsed_s REAL,rss_bytes REAL); CREATE TABLE session_target(session TEXT,host TEXT,target TEXT)",
    );
    resources
      .prepare("INSERT INTO session_target VALUES('s','host','first')")
      .run();
    for (let i = 0; i < 8; i++) {
      const at = base - 70 + i * 10;
      if (new Date(at * 1000).toISOString().slice(0, 10) !== day) continue;
      resources
        .prepare("INSERT INTO resource_sample VALUES(?,9,'s',10,?)")
        .run(at, 100e6 + i * 50e6);
      resources
        .prepare("INSERT INTO resource_sample VALUES(?,9,'other',10,100000000)")
        .run(at);
    }
    resources.close();
  }
  for (const [target, replay] of [
    ["host/first", join(dir, "replay")],
    [
      "host/second",
      join(
        dir,
        "targets",
        Buffer.from("host/second").toString("hex"),
        "replay",
      ),
    ],
  ]) {
    if (!target || !replay) throw Error("invalid fixture");
    mkdirSync(replay, { recursive: true });
    const recordings = new DatabaseSync(join(replay, "2026-10-29.sqlite3"));
    recordings.exec(
      "CREATE TABLE IF NOT EXISTS process_snapshot(ts REAL PRIMARY KEY,snapshot TEXT)",
    );
    recordings.prepare("INSERT INTO process_snapshot VALUES(?,?)").run(
      base,
      JSON.stringify({
        recorded_at: base,
        health: {
          session: target === "host/first" ? "s" : "other",
          pid: 9,
          last_seen: base,
        },
        threads: [],
        memory: { available: true, pid: 9, updated: base },
        resources: { available: true, pid: 9, updated: base },
      }),
    );
    recordings.close();
  }
  const store = openIncidentStore(join(dir, "scout/incidents.sqlite3"));
  scanPass(dir, store, -1);
  const rows = store.prepare("SELECT target,detail FROM incident").all();
  expect(
    rows.some(
      (row) =>
        row.target === "host/first" &&
        String(row.detail).includes("Resident memory grows without a plateau"),
    ),
  ).toBe(true);
  expect(
    rows.some(
      (row) =>
        row.target === "host/second" &&
        String(row.detail).includes("Resident memory grows without a plateau"),
    ),
  ).toBe(false);
  expect(
    store.prepare("SELECT target FROM cursor ORDER BY target").all(),
  ).toEqual([{ target: "host/first" }, { target: "host/second" }]);
  store.close();
});

test("finishes an older batch before it advances into the next day", () => {
  const { dir, db, put } = fixture();
  for (let at = 1; at <= 300; at++) put(at, true);
  const next = new DatabaseSync(join(dir, "replay/2026-10-30.sqlite3"));
  next.exec("CREATE TABLE process_snapshot(ts REAL PRIMARY KEY,snapshot TEXT)");
  const last = db
    .prepare("SELECT snapshot FROM process_snapshot WHERE ts=300")
    .get();
  if (typeof last?.snapshot !== "string") throw Error("missing fixture");
  next.prepare("INSERT INTO process_snapshot VALUES(301,?)").run(last.snapshot);
  const store = openIncidentStore(join(dir, "scout/incidents.sqlite3"));
  scanPass(dir, store, -1);
  expect(store.prepare("SELECT ts FROM cursor").get()?.ts).toBe(256);
  scanPass(dir, store, -1);
  expect(store.prepare("SELECT ts FROM cursor").get()?.ts).toBe(301);
  expect(
    store.prepare("SELECT first,last,count FROM incident WHERE first=1").get(),
  ).toMatchObject({ first: 1, last: 301, count: 301 });
  store.close();
  db.close();
  next.close();
});

test("skips invalid recordings and continues through later rows and roots", () => {
  const { dir, db, put } = fixture();
  put(1, true);
  put(2, true);
  db.prepare("UPDATE process_snapshot SET snapshot='{}' WHERE ts=2").run();
  db.prepare("INSERT INTO process_snapshot VALUES(3,NULL)").run();
  db.prepare("INSERT INTO process_snapshot VALUES(3.5,'{')").run();
  db.prepare("INSERT INTO process_snapshot VALUES('invalid','{}')").run();
  put(4, true);
  const other = join(
    dir,
    "targets",
    Buffer.from("host/other").toString("hex"),
    "replay",
  );
  mkdirSync(other, { recursive: true });
  const next = new DatabaseSync(join(other, "2026-10-29.sqlite3"));
  next.exec("CREATE TABLE process_snapshot(ts REAL PRIMARY KEY,snapshot TEXT)");
  next
    .prepare("INSERT INTO process_snapshot VALUES(5,?)")
    .run(
      db.prepare("SELECT snapshot FROM process_snapshot WHERE ts=4").get()
        ?.snapshot ?? "",
    );
  const store = openIncidentStore(join(dir, "scout/incidents.sqlite3"));
  const logs: string[] = [];
  scanPass(dir, store, -1, (line) => logs.push(line));
  expect(logs).toHaveLength(3);
  expect(
    store
      .prepare("SELECT last,count FROM incident WHERE target='legacy'")
      .get(),
  ).toMatchObject({ last: 4, count: 2 });
  expect(
    store.prepare("SELECT last FROM incident WHERE target='host/other'").get()
      ?.last,
  ).toBe(5);
  scanPass(dir, store, 5, (line) => logs.push(line));
  expect(logs).toHaveLength(3);
  expect(
    store
      .prepare("SELECT count(*) AS n FROM incident WHERE target='legacy'")
      .get()?.n,
  ).toBe(0);
  store.close();
  next.close();
  db.close();
});

test("keeps cursors and incident continuity separate for two roots of one target", () => {
  const { dir, db, put } = fixture();
  put(1, true);
  const resources = new DatabaseSync(join(dir, "1970-01-01.sqlite3"));
  resources.exec(
    "CREATE TABLE session_target(session TEXT,host TEXT,target TEXT); INSERT INTO session_target VALUES('s','host','same'); CREATE TABLE resource_sample(ts REAL,pid INTEGER,session TEXT,elapsed_s REAL,rss_bytes REAL)",
  );
  resources.close();
  const other = join(
    dir,
    "targets",
    Buffer.from("host/same").toString("hex"),
    "replay",
  );
  mkdirSync(other, { recursive: true });
  const next = new DatabaseSync(join(other, "2026-10-29.sqlite3"));
  next.exec("CREATE TABLE process_snapshot(ts REAL PRIMARY KEY,snapshot TEXT)");
  next
    .prepare("INSERT INTO process_snapshot VALUES(2,?)")
    .run(
      db.prepare("SELECT snapshot FROM process_snapshot WHERE ts=1").get()
        ?.snapshot ?? "",
    );
  const path = join(dir, "scout/incidents.sqlite3");
  let store = openIncidentStore(path);
  scanPass(dir, store, -1);
  const before = store
    .prepare("SELECT first,last,count,active FROM incident ORDER BY first")
    .all();
  scanPass(dir, store, -1);
  expect(
    store
      .prepare("SELECT first,last,count,active FROM incident ORDER BY first")
      .all(),
  ).toEqual(before);
  store.close();
  put(3, true);
  store = openIncidentStore(path);
  scanPass(dir, store, -1);
  expect(
    store
      .prepare("SELECT first,last,count,active FROM incident ORDER BY first")
      .all(),
  ).toEqual([
    { first: 1, last: 3, count: 2, active: 1 },
    { first: 2, last: 2, count: 1, active: 1 },
  ]);
  store.close();
  next.close();
  db.close();
});

test("continues other sources and retention when a source database is unreadable", () => {
  const { dir, db, put } = fixture();
  put(1, true);
  const other = join(
    dir,
    "targets",
    Buffer.from("host/other").toString("hex"),
    "replay",
  );
  mkdirSync(other, { recursive: true });
  const next = new DatabaseSync(join(other, "2026-10-29.sqlite3"));
  next.exec("CREATE TABLE process_snapshot(ts REAL PRIMARY KEY,snapshot TEXT)");
  next
    .prepare("INSERT INTO process_snapshot VALUES(5,?)")
    .run(
      db.prepare("SELECT snapshot FROM process_snapshot WHERE ts=1").get()
        ?.snapshot ?? "",
    );
  const store = openIncidentStore(join(dir, "scout/incidents.sqlite3"));
  scanPass(dir, store, -1);
  db.exec("DROP TABLE process_snapshot");
  next
    .prepare(
      "INSERT INTO process_snapshot SELECT 6,snapshot FROM process_snapshot WHERE ts=5",
    )
    .run();
  const logs: string[] = [];
  scanPass(dir, store, 5, (line) => logs.push(line));
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("tri-scout source");
  expect(store.prepare("SELECT target,last,count FROM incident").all()).toEqual(
    [{ target: "host/other", last: 6, count: 2 }],
  );
  store.close();
  next.close();
  db.close();
});

test("migrates an existing store without losing cursor progress or incident continuity", () => {
  const { dir, db, put } = fixture();
  put(1, true);
  const path = join(dir, "incidents.sqlite3");
  let store = openIncidentStore(path);
  scanPass(dir, store, -1);
  const original = store.prepare("SELECT id,key FROM incident").get();
  store.exec(`ALTER TABLE incident DROP COLUMN source;
    ALTER TABLE cursor RENAME TO new_cursor;
    CREATE TABLE cursor(target TEXT PRIMARY KEY,ts REAL NOT NULL,source TEXT NOT NULL);
    INSERT INTO cursor SELECT target,ts,source FROM new_cursor;
    DROP TABLE new_cursor;`);
  store.close();
  store = openIncidentStore(path);
  scanPass(dir, store, -1);
  expect(store.prepare("SELECT count,source FROM incident").all()).toEqual([
    { count: 1, source: "legacy" },
  ]);
  put(2, true);
  scanPass(dir, store, -1);
  expect(store.prepare("SELECT id,key FROM incident").get()).toEqual(original);
  expect(
    store.prepare("SELECT first,last,count FROM incident").get(),
  ).toMatchObject({ first: 1, last: 2, count: 2 });
  store.prepare("INSERT INTO cursor VALUES('legacy',2,'host/other')").run();
  store.close();
  store = openIncidentStore(path);
  expect(store.prepare("SELECT count(*) AS n FROM cursor").get()?.n).toBe(2);
  store.close();
  db.close();
});
