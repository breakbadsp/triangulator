import type { LiveResponse, Target } from "../api/types";
import { fleetAssessment } from "./assess";
import { LEVEL_ORDER, VERDICTS, type Finding, type Level } from "./findings";
import { ago, isNum } from "./format";
import { fleetName } from "./target";

export interface TileModel {
  key: string;
  host: string;
  id: string;
  name: string;
  level: Level | "unknown";
  verdict: string;
  search: string;
  card: { proc: string; findings: readonly Finding[]; more: number } | null;
  /** Its sampler runs on the collector host, so local test control applies. */
  local: boolean;
  /** How Remove applies to a discovered target, or null for a target table. */
  discovered: { rule: string | null; pattern: boolean } | null;
  /** A configured name with no process: the tile says what it waits for. */
  waiting: string | null;
}

export function tileModel(
  target: Target,
  view: LiveResponse | null | undefined,
  now: number,
): TileModel {
  const assessment = fleetAssessment(view, now);
  const level = assessment?.level ?? "unknown";
  const name = fleetName(target, view ?? undefined);
  const findings = assessment?.findings ?? [];
  const health = view?.health;
  const process =
    view?.process?.session === health?.session ? view?.process : null;
  return {
    key: target.key,
    host: target.host,
    id: target.id,
    name,
    level,
    verdict: level === "unknown" ? "No data" : VERDICTS[level],
    search: (name + " " + target.key).toLowerCase(),
    local: target.local === true,
    discovered:
      target.name_selected || target.pattern_selected
        ? {
            rule: target.rule ?? null,
            pattern: target.pattern_selected === true,
          }
        : null,
    waiting:
      target.status === "absent" && target.name_selected && target.rule
        ? target.rule
        : null,
    card: findings.some((item) => item.level !== "info")
      ? {
          proc: [
            health?.pid ? "PID " + String(health.pid) : "",
            isNum(process?.started_at)
              ? "Started " + ago(now - process.started_at)
              : "",
            process?.command,
          ]
            .filter(Boolean)
            .join(" · "),
          findings: findings.slice(0, 4),
          more: Math.max(0, findings.length - 4),
        }
      : null,
  };
}

export function rankTiles(tiles: readonly TileModel[]): TileModel[] {
  const rank = (level: TileModel["level"]) =>
    level === "unknown" ? LEVEL_ORDER.length : LEVEL_ORDER.indexOf(level);
  return [...tiles].sort(
    (a, b) =>
      rank(a.level) - rank(b.level) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}
export function fleetCounts(
  tiles: readonly TileModel[],
): Record<TileModel["level"], number> {
  const counts = {
    critical: 0,
    serious: 0,
    warning: 0,
    info: 0,
    good: 0,
    unknown: 0,
  };
  for (const tile of tiles) counts[tile.level]++;
  return counts;
}
export const FLEET_STATUSES = [
  "attention",
  "critical",
  "serious",
  "warning",
  "good",
  "unknown",
] as const;
export type FleetStatus = (typeof FLEET_STATUSES)[number];
export interface FleetFilter {
  q: string;
  status: FleetStatus | "";
}
export function matchesFilter(tile: TileModel, filter: FleetFilter): boolean {
  return (
    tile.search.includes(filter.q.trim().toLowerCase()) &&
    (!filter.status ||
      filter.status === tile.level ||
      (filter.status === "attention" &&
        ["critical", "serious", "warning"].includes(tile.level)))
  );
}
export function fleetQuery(filter: FleetFilter): URLSearchParams {
  const query = new URLSearchParams();
  if (filter.q.trim()) query.set("q", filter.q.trim());
  if (filter.status) query.set("status", filter.status);
  return query;
}
export function targetHref(key: string, filter: FleetFilter): string {
  return (
    "?" +
    new URLSearchParams([["target", key], ...fleetQuery(filter)]).toString()
  );
}
export function backHref(search: string): string {
  const query = new URLSearchParams(
    [...new URLSearchParams(search)].filter(
      ([name]) => name === "q" || name === "status",
    ),
  ).toString();
  return "./" + (query ? "?" + query : "");
}
