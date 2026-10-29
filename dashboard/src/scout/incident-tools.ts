// The incident store is the only local data source for these tools.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LIMITS, ToolError } from "./tools";

const unknownCoverage = {
  completeness: "unknown",
  gaps: [
    "The store does not retain recording coverage, packet loss, access, or throttle history. An empty list does not prove that no issue occurred.",
    "Timeline contains first, worst, and last observations, not every sample. End time is the last finding, not a confirmed recovery time. Open means active at the last scan.",
    "Only the thread identified by the stored rule is available; contributor ranking is not stored.",
  ],
};

function windowInput(value: unknown) {
  if (
    !isObject(value) ||
    typeof value.start !== "number" ||
    typeof value.end !== "number" ||
    !Number.isFinite(value.start) ||
    !Number.isFinite(value.end) ||
    value.start < 0 ||
    value.end > 8.64e12 ||
    value.end <= value.start
  )
    throw new ToolError(
      "window needs finite Unix seconds: 0 <= start < end <= 8640000000000. The end is exclusive.",
    );
  return { start: value.start, end: value.end };
}

function targetInput(value: unknown) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    Buffer.byteLength(value) > 1024
  )
    throw new ToolError(
      "target must be a nonempty target key of at most 1024 bytes.",
    );
  return value;
}

function idInput(value: unknown): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > 2048)
    throw new ToolError(
      "id must be an incident ID from list_incidents, at most 2048 bytes.",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    /* Rejected below. */
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    !parsed.every((part: unknown) => typeof part === "string") ||
    !parsed[0] ||
    !parsed[2]
  )
    throw new ToolError("id must be an incident ID from list_incidents.");
  return value;
}

function readStore(
  path: string,
  read: (store: DatabaseSync) => string,
): string {
  if (!existsSync(path))
    return JSON.stringify({
      error:
        "tri-scout scan has not run: the incident store is missing. Run tri-scout scan on the collector host.",
      data: { ...unknownCoverage, store_available: false },
    });
  const store = new DatabaseSync(path, { readOnly: true });
  try {
    // Keep incident rows and scan cursors in one WAL snapshot.
    store.exec("BEGIN");
    return read(store);
  } finally {
    store.close();
  }
}

function completeness(store: DatabaseSync, target?: string) {
  const progress = store
    .prepare(
      `SELECT min(ts) AS oldest_cursor, max(ts) AS newest_cursor, count(*) AS sources FROM cursor WHERE (? IS NULL OR target=?)`,
    )
    .get(target ?? null, target ?? null);
  return { ...unknownCoverage, store_available: true, scan_progress: progress };
}

function incident(row: Record<string, unknown>) {
  const raw: unknown =
    typeof row.detail === "string" ? JSON.parse(row.detail) : null;
  if (
    !isObject(raw) ||
    !isObject(raw.item) ||
    typeof raw.type !== "string" ||
    typeof raw.level !== "string" ||
    typeof raw.at !== "number" ||
    typeof raw.item.title !== "string" ||
    typeof raw.item.detail !== "string" ||
    typeof row.id !== "string" ||
    typeof row.target !== "string" ||
    typeof row.first !== "number" ||
    typeof row.last !== "number" ||
    typeof row.count !== "number"
  )
    throw new ToolError("The incident store contains an unreadable incident.");
  return {
    id: row.id,
    target: row.target,
    start: row.first,
    end: row.active === 1 ? null : row.last,
    open: row.active === 1,
    last_observed: row.last,
    kind: raw.type,
    severity: raw.level,
    summary: raw.item.title.slice(0, 512),
    timeline: {
      first: row.first,
      worst: raw.at,
      last: row.last,
      observations: row.count,
    },
    top_contributing_threads:
      isObject(raw.item.action) && typeof raw.item.action.tid === "number"
        ? [raw.item.action]
        : [],
    evidence: raw.item,
  };
}

export function listIncidents(
  path: string,
  args: Readonly<Record<string, unknown>>,
): string {
  const window = windowInput(args.window);
  const target = targetInput(args.target);
  return readStore(path, (store) => {
    const data = completeness(store, target);
    const where =
      "first<? AND (active=1 OR last>=?) AND (? IS NULL OR target=?)";
    const params = [window.end, window.start, target ?? null, target ?? null];
    const total = store
      .prepare(`SELECT count(*) AS n FROM incident WHERE ${where}`)
      .get(...params)?.n;
    if (typeof total !== "number")
      throw new ToolError("Cannot count stored incidents.");
    const rows = store
      .prepare(
        `SELECT * FROM incident WHERE ${where} ORDER BY first DESC, rank, id LIMIT ?`,
      )
      .all(...params, LIMITS.findings);
    const incidents = rows.map((row) => {
      const {
        id,
        target,
        start,
        end,
        open,
        last_observed,
        kind,
        severity,
        summary,
      } = incident(row);
      return {
        id,
        target,
        start,
        end,
        open,
        last_observed,
        kind,
        severity,
        summary,
      };
    });
    for (;;) {
      const text = JSON.stringify({
        window,
        incidents,
        omitted_incidents: total - incidents.length,
        data,
      });
      if (Buffer.byteLength(text) <= LIMITS.bytes) return text;
      incidents.pop();
    }
  });
}

export function getIncident(
  path: string,
  args: Readonly<Record<string, unknown>>,
): string {
  const id = idInput(args.id);
  return readStore(path, (store) => {
    const row = store
      .prepare("SELECT * FROM incident WHERE id=? LIMIT 1")
      .get(id);
    if (!row)
      return JSON.stringify({
        error: "Incident not found. It may have expired from retention.",
        data: completeness(store),
      });
    const result = incident(row);
    const data = completeness(store, result.target);
    const text = JSON.stringify({ incident: result, data, omitted_fields: [] });
    if (Buffer.byteLength(text) <= LIMITS.bytes) return text;
    const summary = {
      ...result,
      evidence: undefined,
      top_contributing_threads: undefined,
    };
    const reduced = JSON.stringify({
      incident: summary,
      data,
      omitted_fields: ["evidence", "top_contributing_threads"],
    });
    if (Buffer.byteLength(reduced) <= LIMITS.bytes) return reduced;
    return JSON.stringify({
      error: "Stored incident exceeds the result size limit.",
      data,
      omitted_fields: ["incident"],
    });
  });
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
