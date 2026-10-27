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
// The live reply is checked once a second, thread by thread.
const splitNames = new Map<string, string[]>();
function namesOf(names: string) {
  let list = splitNames.get(names);
  if (!list) splitNames.set(names, (list = names.split(" ").filter(Boolean)));
  return list;
}
function fields(
  value: Record<string, unknown>,
  numbers: string,
  strings = "",
  booleans = "",
) {
  for (const [names, check] of [
    [numbers, number],
    [strings, (v: unknown) => typeof v === "string"],
    [booleans, (v: unknown) => typeof v === "boolean"],
  ] as const)
    for (const name of namesOf(names))
      if (value[name] != null && !check(value[name]))
        throw Error(`Invalid recorded field: ${name}.`);
}
function numericTree(value: unknown): boolean {
  return (
    value == null ||
    number(value) ||
    (Array.isArray(value)
      ? value.every(numericTree)
      : object(value) && Object.values(value).every(numericTree))
  );
}
function sample(value: unknown) {
  if (value === undefined) return;
  if (!object(value) || typeof value.available !== "boolean")
    throw Error("Invalid recorded samples.");
  fields(
    value,
    "pid updated interval_s sequence",
    "reason session cgroup layout_id",
    "available stale",
  );
  if (
    value.flags != null &&
    (!object(value.flags) ||
      !Object.values(value.flags).every((v) => typeof v === "boolean"))
  )
    throw Error("Invalid recorded sample flags.");
  for (const key of [
    "pressure",
    "memory",
    "io",
    "fds",
    "cgroup_limits",
    "sockstat",
    "limits",
    "network",
    "values",
  ])
    if (
      value[key] !== undefined &&
      (!object(value[key]) || !numericTree(value[key]))
    )
      throw Error(`Invalid recorded ${key}.`);
  if (value.sockets !== undefined) {
    const sockets = value.sockets;
    if (!object(sockets)) throw Error("Invalid recorded sockets.");
    for (const key of ["tcp_states", "tcp", "udp", "unix"])
      if (
        sockets[key] !== undefined &&
        (!object(sockets[key]) || !numericTree(sockets[key]))
      )
        throw Error("Invalid recorded socket totals.");
    fields(sockets, "matched unmatched", "", "complete");
    if (sockets.top !== undefined) {
      if (!Array.isArray(sockets.top))
        throw Error("Invalid recorded socket rows.");
      for (const row of sockets.top) {
        if (
          !object(row) ||
          typeof row.kind !== "string" ||
          typeof row.state !== "string" ||
          typeof row.listener !== "boolean"
        )
          throw Error("Invalid recorded socket row.");
        fields(
          row,
          "fd inode rmem_alloc rcvbuf wmem_alloc wmem_queued sndbuf drops rx_queue tx_queue rx_fill_pct tx_fill_pct accept_fill_pct drops_delta",
          "local remote path",
        );
        if (
          row.tcp !== undefined &&
          (!object(row.tcp) || !numericTree(row.tcp))
        )
          throw Error("Invalid recorded TCP values.");
      }
    }
  }
}
// Replay and tab storage can outlive the collector version that wrote them.
// A live reply has no session before the first sampler packet.
function view(value: unknown, live: boolean): LiveResponse {
  if (!object(value) || !object(value.health) || !Array.isArray(value.threads))
    throw Error("Invalid recorded process view.");
  const h = value.health;
  if (
    !(typeof h.session === "string" || (live && h.session == null)) ||
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
  fields(
    h,
    "last_seen packet_loss_pct sample_interval_ms bad_packets duplicates late_packets raw_samples",
    "session sampler_ip",
    "sampler_silent target_absent",
  );
  for (const thread of value.threads)
    fields(
      thread as Record<string, unknown>,
      "tid cpu generation last_sample last_ran wake_ms cpu_pct system_pct run_delay_pct switches_per_s major_faults_per_s read_bps write_bps",
      "name group state wchan",
      "stale",
    );
  sample(value.resources);
  sample(value.memory);
  if (
    value.process != null &&
    (!object(value.process) ||
      typeof value.process.session !== "string" ||
      typeof value.process.command !== "string")
  )
    throw Error("Invalid recorded process details.");
  if (object(value.process))
    fields(
      value.process,
      "pid started_at parent_pid uid euid gid egid",
      "session command executable working_directory cpus_allowed",
      "exe_deleted exe_hidden cwd_hidden command_truncated executable_truncated working_directory_truncated cpus_truncated",
    );
  if (
    value.exit != null &&
    (!object(value.exit) ||
      !number(value.exit.pid) ||
      !number(value.exit.ended_at) ||
      typeof value.exit.reason !== "string")
  )
    throw Error("Invalid recorded exit.");
  if (object(value.exit)) {
    fields(
      value.exit,
      "pid process_start ended_at signal exit_code count",
      "session name reason next_session signal_name kernel_log error",
      "core_dumped",
    );
    if (
      value.exit.messages !== undefined &&
      (!Array.isArray(value.exit.messages) ||
        !value.exit.messages.every((v) => typeof v === "string"))
    )
      throw Error("Invalid recorded exit messages.");
  }
  if (
    value.groups !== undefined &&
    (!object(value.groups) || !Object.values(value.groups).every(number))
  )
    throw Error("Invalid recorded groups.");
  return value as unknown as LiveResponse;
}
export const parseView = (value: unknown) => view(value, false);
/**
 * The 1 Hz live reply, checked like a recording. A reply that does not fit
 * fails the poll, so the page shows the error, not a blank tile.
 */
export function parseLive(value: unknown): LiveResponse {
  try {
    return view(value, true);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "";
    throw Error(
      `The collector sent a live reply that this page cannot read. ${detail.replace("recorded ", "")}`.trim(),
      { cause },
    );
  }
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
          number(r.size) &&
          number(r.vmas) &&
          typeof r.kind === "string" &&
          typeof r.permissions === "string" &&
          typeof r.name === "string",
      )
        ? (raw as unknown as MemoryLayout)
        : null;
    const ended =
      value.exit == null ? null : parseView({ ...live, exit: value.exit }).exit;
    return {
      at: value.at,
      live: { ...live, exit: null },
      layout,
      exit:
        ended &&
        ended.session === live.health.session &&
        ended.pid === live.health.pid
          ? ended
          : null,
    };
  } catch {
    return null;
  }
}
// The last selectable step, including a fractional endpoint, is Live.
export const timelineAtLive = (at: number, end: number, step: number) =>
  at + step > end;
