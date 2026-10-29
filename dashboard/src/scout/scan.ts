import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout } from "node:timers/promises";
import { parseView } from "../api/replay";
import { assessRecorded } from "../lib/assess";
import { asResourcePoints } from "../lib/assess/memory";
import { LEVEL_ORDER } from "../lib/findings";
import { episodes } from "../lib/pastAssessments";
import { readScoutConfig } from "./config";

const dayFiles = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.sqlite3$/.test(name))
        .sort()
        .map((name) => join(dir, name))
    : [];

// Only the scout store is writable. Short, bounded reads release day-file
// snapshots before assessment and never hold a transaction across passes.
export function scanPass(dataDir: string, store: DatabaseSync, cutoff: number) {
  const roots = [{ target: "legacy", path: dataDir }];
  const targets = join(dataDir, "targets");
  if (existsSync(targets))
    for (const name of readdirSync(targets))
      if (/^(?:[0-9a-f]{2})+$/.test(name))
        roots.push({
          target: Buffer.from(name, "hex").toString("utf8"),
          path: join(targets, name),
        });
  for (const root of roots) {
    const cursor = store
      .prepare("SELECT max(ts) AS ts FROM cursor WHERE source=?")
      .get(root.target);
    let after = typeof cursor?.ts === "number" ? cursor.ts : -1;
    for (const file of dayFiles(join(root.path, "replay"))) {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        // One batch per file per pass bounds switch-off latency and memory.
        const rows = db
          .prepare(
            "SELECT ts,snapshot FROM process_snapshot WHERE ts>? ORDER BY ts LIMIT 256",
          )
          .all(after);
        for (const row of rows) {
          if (typeof row.ts !== "number" || typeof row.snapshot !== "string")
            throw Error(`Invalid recording in ${file}`);
          const at = row.ts;
          const view = parseView(JSON.parse(row.snapshot));
          const session = view.health.session ?? "";
          let target = root.target;
          const points = [];
          for (const resourceFile of dayFiles(dataDir).filter((path) => {
            const day = path.slice(-18, -8);
            return (
              day >= new Date((at - 360) * 1000).toISOString().slice(0, 10) &&
              day <= new Date(at * 1000).toISOString().slice(0, 10)
            );
          })) {
            const resources = new DatabaseSync(resourceFile, {
              readOnly: true,
            });
            try {
              if (
                root.target === "legacy" &&
                resources
                  .prepare(
                    "SELECT name FROM sqlite_master WHERE name='session_target'",
                  )
                  .get()
              ) {
                const mapping = resources
                  .prepare(
                    "SELECT host,target FROM session_target WHERE session=?",
                  )
                  .get(view.health.session ?? "");
                if (
                  typeof mapping?.host === "string" &&
                  typeof mapping.target === "string"
                )
                  target = `${mapping.host}/${mapping.target}`;
              }
              for (const point of resources
                .prepare(
                  "SELECT ts,pid,elapsed_s,rss_bytes FROM resource_sample WHERE ts>=? AND ts<=? AND session=? ORDER BY ts",
                )
                .all(at - 360, at, view.health.session ?? "")) {
                if (
                  typeof point.ts !== "number" ||
                  typeof point.pid !== "number"
                )
                  throw Error(`Invalid resource row in ${resourceFile}`);
                points.push({
                  ts: point.ts,
                  pid: point.pid,
                  elapsed_s:
                    typeof point.elapsed_s === "number"
                      ? point.elapsed_s
                      : null,
                  rss_bytes:
                    typeof point.rss_bytes === "number"
                      ? point.rss_bytes
                      : null,
                });
              }
            } finally {
              resources.close();
            }
          }
          const incidents = episodes([
            {
              at: row.ts,
              findings: assessRecorded(view, row.ts, asResourcePoints(points)),
            },
          ]);
          store.exec("BEGIN IMMEDIATE");
          try {
            const active = store
              .prepare(
                "SELECT id,key,last FROM incident WHERE target=? AND active=1",
              )
              .all(target);
            store
              .prepare("UPDATE incident SET active=0 WHERE target=?")
              .run(target);
            for (const incident of incidents) {
              // A session change ends continuity.
              const previous = active.find(
                (item) => item.key === `${session}|${incident.key}`,
              );
              const id =
                typeof previous?.id === "string"
                  ? previous.id
                  : `${session}|${incident.id}`;
              store
                .prepare(
                  `INSERT INTO incident(target,id,key,first,last,count,rank,detail,active) VALUES(?,?,?,?,?,1,?,?,1)
                ON CONFLICT(target,id) DO UPDATE SET last=excluded.last,count=incident.count+1,
                detail=CASE WHEN excluded.rank<incident.rank THEN excluded.detail ELSE incident.detail END,
                rank=min(incident.rank,excluded.rank),active=1`,
                )
                .run(
                  target,
                  id,
                  `${session}|${incident.key}`,
                  incident.first,
                  incident.last,
                  LEVEL_ORDER.indexOf(incident.level),
                  JSON.stringify(incident),
                );
            }
            store
              .prepare(
                "INSERT INTO cursor VALUES(?,?,?) ON CONFLICT(target) DO UPDATE SET ts=excluded.ts,source=excluded.source",
              )
              .run(target, at, root.target);
            store.exec("COMMIT");
          } catch (error) {
            store.exec("ROLLBACK");
            throw error;
          }
          after = row.ts;
        }
        // Finish an older day before advancing the target cursor into the next.
        if (rows.length === 256) break;
      } finally {
        db.close();
      }
    }
  }
  store.prepare("DELETE FROM incident WHERE last<?").run(cutoff);
}

export function openIncidentStore(path: string) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const store = new DatabaseSync(path);
  store.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS incident(target TEXT NOT NULL,id TEXT NOT NULL,key TEXT NOT NULL,first REAL NOT NULL,last REAL NOT NULL,count INTEGER NOT NULL,rank INTEGER NOT NULL,detail TEXT NOT NULL,active INTEGER NOT NULL,PRIMARY KEY(target,id));
    CREATE TABLE IF NOT EXISTS cursor(target TEXT PRIMARY KEY,ts REAL NOT NULL,source TEXT NOT NULL);`);
  return store;
}

export async function scan({
  configPath,
  log,
}: {
  configPath: string;
  log: (line: string) => void;
}): Promise<number> {
  let store: DatabaseSync | undefined;
  const home = process.env.TRIANGULATOR_HOME ?? join(homedir(), "triangulator");
  try {
    for (;;) {
      const config = readScoutConfig(configPath);
      if (config.kind === "off") {
        log(`tri-scout is disabled (${config.reason}).`);
        return 2;
      }
      store ??= openIncidentStore(join(home, "data/scout/incidents.sqlite3"));
      try {
        scanPass(
          resolve(home, config.dataDir),
          store,
          Date.now() / 1000 - config.retentionDays * 86400,
        );
      } catch (error) {
        log(
          `tri-scout scan: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await setTimeout(1000);
    }
  } finally {
    store?.close();
  }
}
