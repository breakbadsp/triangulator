import type {
  LiveResponse,
  ProcessExit,
  ProcessInfo,
  Thread,
} from "../api/types";
import { endedTarget, exitReason, exitStatusText } from "./exit";
import type { Level } from "./findings";
import { ago, date, duration, isNum, num, pct, perSec } from "./format";
import type { Point, Series } from "./series";
import { isIdle, stateLabels } from "./threads";

/** One sentence on what the threads are doing, for the Assessment card. */
export function profile(threads: readonly Thread[]) {
  if (!threads.length) return "";
  const counts: Record<string, number> = {};
  for (const thread of threads) {
    const state = String(thread.state);
    counts[state] = (counts[state] || 0) + 1;
  }
  const waiting = threads.length - (counts.running || 0),
    top = Object.entries(counts)
      .filter(([state]) => state !== "running")
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
  const busy = threads.filter((thread) => (thread.cpu_pct || 0) >= 1).length;
  let text =
    `${String(waiting)} of ${String(threads.length)} threads are waiting` +
    (top.length
      ? ": " +
        top
          .map(
            ([state, count]) =>
              `${String(count)} ${(stateLabels[state] || state).toLowerCase()}`,
          )
          .join(", ")
      : "") +
    ". ";
  text += busy
    ? `${String(busy)} thread${busy > 1 ? "s are" : " is"} busy (≥1% CPU).`
    : "No thread is using noticeable CPU.";
  if ((counts.futex || 0) > threads.length / 2)
    text +=
      " Futex waits are locks, condition variables or idle pool workers. Idle workers wait this way normally; a thread blocked on a lock that never frees waits the same way.";
  return text;
}

export type TileTopic = "active" | "switches" | "sysio" | "faults" | "churn";
export interface Tile {
  label: string;
  topic: TileTopic;
  value: string;
  sub: string;
  values: readonly (number | null)[];
}
/** The Summary tiles for the points in the chart window. */
export function summaryTiles(
  threads: readonly Thread[],
  points: readonly Point[],
  all: readonly Point[],
): Tile[] {
  const last = points.at(-1),
    series = (key: "active" | "sw" | "mf") => points.map((point) => point[key]);
  const end = all.at(-1)?.t || 0,
    lastMinute = all.filter((point) => point.t >= end - 60);
  const born = lastMinute.reduce((sum, point) => sum + point.born, 0),
    died = lastMinute.reduce((sum, point) => sum + point.died, 0);
  const idle = threads.filter(isIdle).length,
    active = threads.length - idle;
  const tiles: Tile[] = [
    {
      label: "Active threads",
      topic: "active",
      value: String(active),
      sub: `of ${String(threads.length)} · ${String(idle)} idle for 10 s+`,
      values: series("active"),
    },
    {
      label: "Context switches",
      topic: "switches",
      value: num(last?.sw, 0) + "/s",
      sub: active ? `${num((last?.sw || 0) / active)}/s per active thread` : "",
      values: series("sw"),
    },
    {
      label: "Disk & syscall I/O",
      topic: "sysio",
      value: perSec((last?.rb || 0) + (last?.wb || 0)),
      sub: `read ${perSec(last?.rb)} · write ${perSec(last?.wb)}`,
      values: points.map((point) =>
        point.rb === null ? null : point.rb + (point.wb ?? 0),
      ),
    },
  ];
  // Signals that are usually zero only get a tile when they happened.
  if (points.some((point) => (point.mf ?? 0) > 0))
    tiles.push({
      label: "Major faults",
      topic: "faults",
      value: num(last?.mf) + "/s",
      sub: "reads from disk to fill memory",
      values: series("mf"),
    });
  // Always shown: +0 / −0 must not read as "no churn", because threads that
  // start and exit between samples are never seen.
  if (all.length)
    tiles.push({
      label: "Thread churn",
      topic: "churn",
      value: `+${String(born)} / −${String(died)}`,
      sub: "lower bound · seen starting / ending, last minute",
      values: points.map((point) => point.born + point.died),
    });
  return tiles;
}

/** The hero values of the Process load card. */
export function loadFacts(
  threads: readonly Thread[],
  series: Series,
  live: boolean,
) {
  // A recorded view has no load average, so its values stay unknown.
  const averages = live ? series.load?.averages : undefined;
  const cpu = threads.reduce((sum, thread) => sum + (thread.cpu_pct || 0), 0),
    delay = threads.reduce(
      (sum, thread) => sum + (thread.run_delay_pct || 0),
      0,
    );
  const top = threads.reduce<Thread | null>(
    (best, thread) =>
      (thread.cpu_pct || 0) > (best?.cpu_pct || -1) ? thread : best,
    null,
  );
  const points = series.points,
    span = points.length ? (points.at(-1)?.t ?? 0) - (points[0]?.t ?? 0) : 0,
    load = (value: number | undefined) =>
      averages && isNum(value) ? value.toFixed(2) : "—";
  return {
    load1: load(averages?.[0]),
    load5: load(averages?.[1]),
    load15: load(averages?.[2]),
    load15Label:
      span < 840 && averages ? `15 min (${duration(span)} of data)` : "15 min",
    cpu: threads.length ? (cpu / 100).toFixed(2) + " cores" : "—",
    // Under 1% of a core the ratio is noise, so don't report one.
    wait:
      cpu + delay >= 1
        ? pct((100 * delay) / (cpu + delay)) + " of demand"
        : threads.length
          ? "negligible"
          : "—",
    busiest: top?.cpu_pct ? `${top.name} · ${pct(top.cpu_pct)}` : "all idle",
  };
}

export type FactTopic =
  "cmdline" | "exe" | "cwd" | "started" | "parentpid" | "owner" | "allowedcpus";
export interface Fact {
  label: string;
  topic: FactTopic;
  value: string;
  wide: boolean;
}
/**
 * What the target is, from the sampler's one-time /proc reads. `reference` is
 * the time that the run time counts to.
 */
export function processFacts(info: ProcessInfo, reference: number): Fact[] {
  const missing = "Not available";
  const cut = (text: string, truncated?: boolean, atStart = false) =>
    truncated ? (atStart ? "…" + text : text + " …") : text;
  const path = (value?: string, truncated?: boolean, hidden?: boolean) =>
    value
      ? cut(value, truncated, true)
      : hidden
        ? missing + " (readable only by the process owner)"
        : missing;
  const user = isNum(info.uid)
    ? `UID ${String(info.uid)}` +
      (isNum(info.euid) && info.euid !== info.uid
        ? ` (effective ${String(info.euid)})`
        : "")
    : "UID " + missing;
  const group = isNum(info.gid)
    ? `GID ${String(info.gid)}` +
      (isNum(info.egid) && info.egid !== info.gid
        ? ` (effective ${String(info.egid)})`
        : "")
    : "GID " + missing;
  return [
    {
      label: "Command line",
      topic: "cmdline",
      value: info.command
        ? cut(info.command, info.command_truncated)
        : "Empty (a kernel thread or a process that is ending)",
      wide: true,
    },
    // The sampler strips the kernel's " (deleted)" suffix and sets exe_deleted.
    {
      label: "Executable",
      topic: "exe",
      value:
        path(info.executable, info.executable_truncated, info.exe_hidden) +
        (info.executable && info.exe_deleted ? " (deleted)" : ""),
      wide: true,
    },
    {
      label: "Working directory",
      topic: "cwd",
      value: path(
        info.working_directory,
        info.working_directory_truncated,
        info.cwd_hidden,
      ),
      wide: true,
    },
    {
      label: "Started",
      topic: "started",
      value: isNum(info.started_at)
        ? `${date(info.started_at)} · up ${duration(Math.max(0, reference - info.started_at))}`
        : missing,
      wide: false,
    },
    {
      label: "Parent process",
      topic: "parentpid",
      value: !isNum(info.parent_pid)
        ? missing
        : info.parent_pid === 0
          ? "None visible (outside its PID namespace)"
          : "PID " + String(info.parent_pid),
      wide: false,
    },
    {
      label: "User & group",
      topic: "owner",
      value: `${user} · ${group}`,
      wide: false,
    },
    {
      label: "Allowed CPUs",
      topic: "allowedcpus",
      value: info.cpus_allowed
        ? cut(info.cpus_allowed, info.cpus_truncated)
        : missing,
      wide: false,
    },
  ];
}

/** The process info that belongs to this view's session, or null. */
export const viewProcess = (view: LiveResponse) =>
  view.process && view.process.session === view.health.session
    ? view.process
    : null;

/** The text of the Last process exit card in the live view. */
export function exitCard(ended: ProcessExit, view: LiveResponse, now: number) {
  // The card is open while its exit describes what the page shows. Once
  // another process is the target, it folds to one line.
  const current = !!endedTarget(view);
  const [label, level, meaning]: [string, Level, string] = exitReason(ended);
  const name = ended.name || "Process",
    count =
      (ended.count ?? 0) > 1
        ? ` · ${String(ended.count)} exits since the collector started`
        : "";
  const statusReason = ["crashed", "killed", "exited"].includes(ended.reason);
  return {
    key: `${String(ended.pid)}:${String(ended.process_start)}:${String(current)}`,
    current,
    label,
    level,
    brief: `${name} · PID ${String(ended.pid)} · ${ago(now - ended.ended_at)}${count}`,
    sub: `${name} · PID ${String(ended.pid)} · ended ${date(ended.ended_at)} (${ago(now - ended.ended_at)})${count}`,
    explain:
      meaning +
      (ended.error && !statusReason ? ` (${ended.error})` : "") +
      (statusReason && ended.kernel_log !== "read"
        ? " The kernel log was not readable, so its messages are missing."
        : ""),
    status: exitStatusText(ended),
    logRead: ended.kernel_log === "read",
    messages: ended.messages?.length
      ? ended.messages.join("\n")
      : "No kernel messages name this process.",
  };
}
