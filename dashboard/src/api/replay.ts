import type { LiveResponse, MemoryLayout } from "./types";
export const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
export interface ReplayBounds {
  first: number | null;
  last: number | null;
  interval_s: number;
}
export interface ReplayReply extends ReplayBounds {
  snapshot: (LiveResponse & { recorded_at: number }) | null;
}
// Replay and tab storage can outlive the collector version that wrote them.
export function parseView(value: unknown): LiveResponse {
  if (!object(value) || !object(value.health) || !Array.isArray(value.threads))
    throw Error("Invalid recorded process view.");
  const h = value.health;
  if (
    typeof h.session !== "string" ||
    !number(h.pid) ||
    h.pid < 0 ||
    !(h.last_seen === null || number(h.last_seen)) ||
    !value.threads.every(
      (t) =>
        object(t) &&
        number(t.tid) &&
        typeof t.name === "string" &&
        (t.state_mix === undefined ||
          (object(t.state_mix) && Object.values(t.state_mix).every(number))),
    )
  )
    throw Error("Invalid recorded process identity or threads.");
  for (const field of ["resources", "memory"])
    if (
      value[field] !== undefined &&
      (!object(value[field]) || typeof value[field].available !== "boolean")
    )
      throw Error("Invalid recorded samples.");
  if (
    value.process != null &&
    (!object(value.process) ||
      typeof value.process.session !== "string" ||
      typeof value.process.command !== "string")
  )
    throw Error("Invalid recorded process details.");
  if (
    value.exit != null &&
    (!object(value.exit) ||
      !number(value.exit.pid) ||
      !number(value.exit.ended_at) ||
      typeof value.exit.reason !== "string")
  )
    throw Error("Invalid recorded exit.");
  if (
    value.groups !== undefined &&
    (!object(value.groups) || !Object.values(value.groups).every(number))
  )
    throw Error("Invalid recorded groups.");
  return value as unknown as LiveResponse;
}
export function parseBounds(value: unknown): ReplayBounds {
  if (
    !object(value) ||
    !(value.first === null || number(value.first)) ||
    !(value.last === null || number(value.last)) ||
    (number(value.first) && (!number(value.last) || value.last < value.first))
  )
    throw Error("Invalid recording bounds.");
  return {
    first: value.first,
    last: value.last,
    interval_s: number(value.interval_s) ? value.interval_s : 1,
  };
}
export function parseReplay(value: unknown): ReplayReply {
  const bounds = parseBounds(value);
  const raw = (value as Record<string, unknown>).snapshot;
  if (raw == null) return { ...bounds, snapshot: null };
  const snapshot = parseView(raw);
  if (!number(snapshot.recorded_at) || snapshot.recorded_at < 0)
    throw Error("Invalid recording time.");
  return {
    ...bounds,
    snapshot: { ...snapshot, recorded_at: snapshot.recorded_at },
  };
}
export function parseFrozen(
  value: unknown,
  currentSession: string | null | undefined,
) {
  if (!object(value) || !number(value.at) || value.at < 0) return null;
  try {
    const live = parseView(value.live);
    if (!live.threads.length || live.health.session === currentSession)
      return null;
    const raw = value.layout;
    const layout =
      object(raw) &&
      raw.available === true &&
      raw.pid === live.health.pid &&
      typeof raw.id === "string" &&
      raw.id.split(":")[0] === live.health.session &&
      Array.isArray(raw.regions) &&
      raw.regions.every(
        (r) =>
          object(r) &&
          typeof r.start === "string" &&
          typeof r.end === "string" &&
          /^(0x)?[0-9a-f]+$/i.test(r.start) &&
          /^(0x)?[0-9a-f]+$/i.test(r.end) &&
          number(r.size),
      )
        ? (raw as unknown as MemoryLayout)
        : null;
    return {
      at: value.at,
      live: { ...live, exit: null },
      layout,
      exit:
        value.exit == null
          ? null
          : parseView({ ...live, exit: value.exit }).exit,
    };
  } catch {
    return null;
  }
}
// The last selectable step, including a fractional endpoint, is Live.
export const timelineAtLive = (at: number, end: number, step: number) =>
  at + step > end;
