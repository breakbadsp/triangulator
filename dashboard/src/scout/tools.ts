// The read-only tools that tri-scout serves. Each one is a pure function of
// one /api/fleet reply, so the verdicts are the ones the Targets page shows.
import { parseLive } from "../api/replay";
import type { LiveResponse, Target, TargetsResponse } from "../api/types";
import { fleetAssessment } from "../lib/assess";
import { LEVEL_ORDER, VERDICTS, type Finding } from "../lib/findings";
import { fleetName } from "../lib/target";

/** Limits for each tool result, so one answer cannot fill a context window. */
export const LIMITS = { findings: 20, bytes: 16_384 } as const;

/** A tool input or collector reply that the tool cannot use. */
export class ToolError extends Error {}

export interface Fleet {
  targets: readonly Target[];
  /** null: the live view is missing or this version cannot read it. */
  views: ReadonlyMap<string, LiveResponse | null>;
}

/** Checks the /api/fleet reply where it enters tri-scout. */
export function parseFleet(value: unknown): Fleet {
  if (!isObject(value) || !isObject(value.list) || !isObject(value.live))
    throw new ToolError(
      "The collector sent an /api/fleet reply without list and live.",
    );
  // The Targets page reads the list unchecked (FleetPage.tsx, loadFleet).
  // Check the fields that tri-scout indexes by, and trust the rest the same.
  const targets: unknown = value.list.targets;
  if (
    !Array.isArray(targets) ||
    !targets.every(
      (target: unknown) =>
        isObject(target) &&
        typeof target.key === "string" &&
        typeof target.id === "string" &&
        typeof target.host === "string",
    )
  )
    throw new ToolError(
      "The collector sent an /api/fleet reply without a target list.",
    );
  const list = targets as TargetsResponse["targets"];
  const live = value.live;
  const views = new Map<string, LiveResponse | null>();
  for (const target of list) {
    try {
      views.set(target.key, parseLive(live[target.key]));
    } catch {
      views.set(target.key, null);
    }
  }
  return { targets: list, views };
}

export function listTargets(fleet: Fleet, now: number): string {
  const rows = fleet.targets.map((target) => {
    const view = fleet.views.get(target.key) ?? null;
    return {
      key: target.key,
      name: fleetName(target, view ?? undefined),
      host: target.host,
      id: target.id,
      pid: view?.health.pid ?? target.pid,
      command: view?.process?.command ?? target.process?.command ?? null,
      data: completeness(target, view, now),
    };
  });
  return capped(rows, (targets, omitted) => ({
    targets,
    omitted_targets: omitted,
  }));
}

/** The Targets page verdict and findings for one target, or for all. */
export function statusNow(fleet: Fleet, now: number, key?: string): string {
  const selected = key === undefined ? fleet.targets : [pick(fleet, key)];
  const rows = selected
    .map((target) => {
      const view = fleet.views.get(target.key) ?? null;
      const assessment = fleetAssessment(view, now);
      const findings = assessment?.findings ?? [];
      return {
        key: target.key,
        name: fleetName(target, view ?? undefined),
        level: assessment?.level ?? "unknown",
        verdict: assessment ? VERDICTS[assessment.level] : "No data",
        findings: findings.slice(0, LIMITS.findings).map(finding),
        omitted_findings: Math.max(0, findings.length - LIMITS.findings),
        data: completeness(target, view, now),
      };
    })
    .sort((a, b) => rank(a.level) - rank(b.level));
  return capped(rows, (targets, omitted) => ({
    checked_at: now,
    targets,
    omitted_targets: omitted,
  }));
}

function pick(fleet: Fleet, key: string): Target {
  const byKey = fleet.targets.find((target) => target.key === key);
  if (byKey) return byKey;
  const byId = fleet.targets.filter((target) => target.id === key);
  if (byId.length === 1 && byId[0]) return byId[0];
  throw new ToolError(
    byId.length > 1
      ? `Target ID ${key} is on more than one host. Use a key from list_targets.`
      : `Unknown target ${key}. Use a key from list_targets.`,
  );
}

// What the answer can rest on. The agent must state gaps in its answer.
function completeness(target: Target, view: LiveResponse | null, now: number) {
  const health = view?.health;
  return {
    status: target.status,
    view_readable: view !== null,
    access: target.access ?? "full",
    sampler_throttled: target.throttled === true,
    effective_rate_hz: target.effective_rate_hz ?? null,
    sample_interval_ms: health?.sample_interval_ms ?? null,
    packet_loss_pct: health?.packet_loss_pct ?? null,
    last_sample_age_s:
      typeof health?.last_seen === "number"
        ? Math.round(now - health.last_seen)
        : null,
    session: health?.session ?? null,
  };
}

function finding(item: Finding) {
  return {
    level: item.level,
    type: item.type,
    title: item.title,
    detail: item.detail,
    ...(item.hint ? { hint: item.hint } : {}),
    ...(item.action?.tid !== undefined ? { tid: item.action.tid } : {}),
  };
}

// Worst first, and "unknown" (no readable view) last, as on the Targets page.
const rank = (level: string) => {
  const index = LEVEL_ORDER.findIndex((item) => item === level);
  return index < 0 ? LEVEL_ORDER.length : index;
};

/** The JSON text of the most rows that fit LIMITS.bytes. */
function capped<T>(
  rows: readonly T[],
  wrap: (kept: readonly T[], omitted: number) => object,
): string {
  for (let kept = rows.length; ; kept--) {
    const text = JSON.stringify(wrap(rows.slice(0, kept), rows.length - kept));
    if (kept === 0 || Buffer.byteLength(text) <= LIMITS.bytes) return text;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
