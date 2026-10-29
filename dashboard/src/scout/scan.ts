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
export function scanPass(
  dataDir: string,
  store: DatabaseSync,
  cutoff: number,
  log: (line: string) => void = () => {},
) {
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
    try {
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
              "SELECT ts,snapshot FROM process_snapshot WHERE typeof(ts) IN ('integer','real') AND ts>? ORDER BY ts LIMIT 256",
            )
            .all(after);
          for (const row of rows) {
            // Non-numeric timestamps cannot be ordered on the recording timeline.
            if (typeof row.ts !== "number") continue;
            const at = row.ts;
            let view: ReturnType<typeof parseView>;
            try {
              if (typeof row.snapshot !== "string")
                throw Error("Invalid snapshot");
              view = parseView(JSON.parse(row.snapshot));
            } catch (error) {
              store
                .prepare(
                  "INSERT INTO cursor VALUES(?,?,?) ON CONFLICT(source,target) DO UPDATE SET ts=excluded.ts",
                )
                .run(root.target, at, root.target);
              after = at;
              log(
                `tri-scout recording ${file} at ${String(at)}: ${String(error)}`,
              );
              continue;
            }
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
                findings: assessRecorded(
                  view,
                  row.ts,
                  asResourcePoints(points),
                ),
              },
            ]);
            store.exec("BEGIN IMMEDIATE");
            try {
              const active = store
                .prepare(
                  "SELECT id,key,last FROM incident WHERE target=? AND source=? AND active=1",
                )
                .all(target, root.target);
              store
                .prepare(
                  "UPDATE incident SET active=0 WHERE target=? AND source=?",
                )
                .run(target, root.target);
              for (const incident of incidents) {
                // A session change ends continuity.
                const previous = active.find(
                  (item) => item.key === `${session}|${incident.key}`,
                );
                const id =
                  typeof previous?.id === "string"
                    ? previous.id
                    : JSON.stringify([root.target, session, incident.id]);
                store
                  .prepare(
                    `INSERT INTO incident(target,id,key,first,last,count,rank,detail,active,source) VALUES(?,?,?,?,?,1,?,?,1,?)
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
                    root.target,
                  );
              }
              store
                .prepare(
                  "INSERT INTO cursor VALUES(?,?,?) ON CONFLICT(source,target) DO UPDATE SET ts=excluded.ts",
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
    } catch (error) {
      log(`tri-scout source ${root.path}: ${String(error)}`);
    }
  }
  store.prepare("DELETE FROM incident WHERE last<?").run(cutoff);
}

export function openIncidentStore(path: string) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const store = new DatabaseSync(path);
  store.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS incident(target TEXT NOT NULL,id TEXT NOT NULL,key TEXT NOT NULL,first REAL NOT NULL,last REAL NOT NULL,count INTEGER NOT NULL,rank INTEGER NOT NULL,detail TEXT NOT NULL,active INTEGER NOT NULL,source TEXT NOT NULL DEFAULT 'legacy',PRIMARY KEY(target,id));
    CREATE TABLE IF NOT EXISTS cursor(target TEXT NOT NULL,ts REAL NOT NULL,source TEXT NOT NULL,PRIMARY KEY(source,target));`);
  // Preserve progress and continuity from stores made before source isolation.
  if (
    !store
      .prepare("PRAGMA table_info(incident)")
      .all()
      .some((column) => column.name === "source")
  ) {
    store.exec(`BEGIN IMMEDIATE;
      ALTER TABLE incident ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy';
      UPDATE incident SET source=coalesce((SELECT source FROM cursor WHERE cursor.target=incident.target),'legacy');
      ALTER TABLE cursor RENAME TO old_cursor;
      CREATE TABLE cursor(target TEXT NOT NULL,ts REAL NOT NULL,source TEXT NOT NULL,PRIMARY KEY(source,target));
      INSERT INTO cursor SELECT target,ts,source FROM old_cursor;
      DROP TABLE old_cursor;
      COMMIT;`);
  }
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
          log,
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
