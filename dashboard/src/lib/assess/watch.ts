import type { LiveResponse, Thread, WatchRule } from "../../api/types";
import type { Finding } from "../findings";
import { isNum, num, pct, duration } from "../format";
import { kernelShare, stateLabels } from "../threads";
import type { AssessInput } from "./index";
type WatchInput = Pick<AssessInput, "view" | "mode" | "watchRules">;
type WatchedThread = Thread & {
  wake_ms: number;
  last_sample: number;
  last_ran: number;
};
const SATURATED_PCT = 90;
// Seconds a watched thread may go without running before it counts as having
// stopped waking. 2 x wake_ms lets one wake come late under load (a timer that
// fires late is not a hang). 2 x sample interval covers sampling: last_ran is
// the newest sample that saw the thread run, and the thread may have run up to
// one interval earlier, while last_sample may lag the real time by one more.
// Without that term a 10 ms rule would be flagged by ordinary sampling jitter.
const watchOverdueS = (wakeMs: number, intervalMs: number) =>
  (2 * wakeMs + 2 * intervalMs) / 1000;
// Without a known interval, assume a slow one: fewer alarms, never more.
const sampleIntervalMs = (health: LiveResponse["health"]) => {
  const value = health.sample_interval_ms;
  return isNum(value) && value > 0 ? value : 1000;
};
const isWatched = (thread: Thread): thread is WatchedThread =>
  isNum(thread.wake_ms) &&
  thread.wake_ms > 0 &&
  isNum(thread.last_ran) &&
  isNum(thread.last_sample);
// Seconds the thread did not run before its newest sample.
const quietFor = (thread: WatchedThread) =>
  Math.max(0, thread.last_sample - thread.last_ran);
const quietText = (seconds: number) =>
  seconds < 10 ? seconds.toFixed(1) + " s" : duration(seconds);
const isOverdue = (thread: WatchedThread, health: LiveResponse["health"]) =>
  quietFor(thread) > watchOverdueS(thread.wake_ms, sampleIntervalMs(health));
const isBusyWatched = (thread: Thread) =>
  (thread.cpu_pct || 0) >= SATURATED_PCT;
// The watched threads worth checking now: none when the data is not live.
export function watchedThreads(
  threads: readonly Thread[],
  health: LiveResponse["health"],
) {
  return health.sampler_silent || health.target_absent
    ? []
    : threads.filter((thread) => !thread.stale).filter(isWatched);
}
export const watchRuleFor = (name: string, rules: readonly WatchRule[]) =>
  rules.reduce<WatchRule | null>(
    (best, rule) =>
      name.startsWith(rule.prefix) &&
      (!best || rule.prefix.length > best.prefix.length)
        ? rule
        : best,
    null,
  );
// The rule list is older than the threads when a thread's wake_ms differs
// from what the list gives it, for example just after a rule was saved.
export const watchRulesOutdated = (
  threads: readonly Thread[],
  watchRules: readonly WatchRule[] | null,
) =>
  !watchRules ||
  threads.some(
    (thread) =>
      !thread.stale &&
      (watchRuleFor(thread.name, watchRules)?.wake_ms ?? null) !==
        (isNum(thread.wake_ms) ? thread.wake_ms : null),
  );
const andMore = (names: readonly string[], shown: number) =>
  names.slice(0, shown).join(", ") +
  (names.length > shown ? ` and ${String(names.length - shown)} more` : "");
function stuckFinding(stuck: readonly WatchedThread[]): Finding[] {
  stuck = [...stuck].sort((a, b) => quietFor(b) - quietFor(a));
  const worst = stuck[0];
  if (!worst) return [];
  const lastState = `Last state: ${String(stateLabels[worst.state ?? ""] || worst.state)}${worst.wchan ? " in " + worst.wchan : ""}.`;
  const advice = "deadlocked or waiting without a timeout";
  if (stuck.length === 1)
    return [
      {
        type: "watched",
        level: "serious",
        title: `${worst.name} stopped waking up`,
        help: "watched",
        action: { tid: worst.tid },
        detail: `TID ${String(worst.tid)} is set to wake at least every ${num(worst.wake_ms, 0)} ms, but it has not run for ${quietText(quietFor(worst))}. It may be ${advice}. ${lastState}`,
      },
    ];
  return [
    {
      type: "watched",
      level: "serious",
      title: `${String(stuck.length)} watched threads stopped waking up`,
      help: "watched",
      action: { tid: worst.tid },
      hint: "Open the worst thread",
      detail: `Each is set to wake regularly but has been quiet much longer than its interval. Worst first: ${andMore(
        stuck.map(
          (thread) =>
            `${thread.name} (${quietText(quietFor(thread))}, every ${num(thread.wake_ms, 0)} ms)`,
        ),
        3,
      )}. They may be ${advice}. Worst thread: ${worst.name}. ${lastState}`,
    },
  ];
}
function busyFinding(busy: readonly WatchedThread[]): Finding[] {
  busy = [...busy].sort((a, b) => (b.cpu_pct ?? 0) - (a.cpu_pct ?? 0));
  const worst = busy[0];
  if (!worst) return [];
  const share = kernelShare(worst);
  const loop =
    "It may be stuck in an infinite or retry loop." +
    (share === null
      ? ""
      : ` ${pct(100 * share)} of its CPU is kernel time with ${num(worst.switches_per_s, 0)} context switches/s, which looks like a polling or yield loop.`);
  if (busy.length === 1)
    return [
      {
        type: "watched",
        level: "serious",
        title: `${worst.name} is running instead of sleeping`,
        help: "watched",
        action: { tid: worst.tid },
        detail: `TID ${String(worst.tid)} is expected to sleep and wake every ${num(worst.wake_ms, 0)} ms, but it uses ${pct(worst.cpu_pct)} of one core. ${loop}`,
      },
    ];
  return [
    {
      type: "watched",
      level: "serious",
      title: `${String(busy.length)} watched threads are running instead of sleeping`,
      help: "watched",
      action: { tid: worst.tid },
      hint: "Open the busiest thread",
      detail: `They are expected to sleep between wakes, but each uses ${String(SATURATED_PCT)}% of a core or more: ${andMore(
        busy.map((thread) => `${thread.name} ${pct(thread.cpu_pct)}`),
        3,
      )}. Worst: ${worst.name}. ${loop}`,
    },
  ];
}
// Rules that match no current thread. Only for the live view of a present
// target: the rule list says nothing reliable about a past or ended view.
function unmatchedRules(
  threads: readonly Thread[],
  { view, mode, watchRules }: WatchInput,
) {
  const health = view.health;
  if (
    mode.kind !== "live" ||
    health.sampler_silent ||
    health.target_absent ||
    !watchRules ||
    !watchRules.length
  )
    return [];
  const current = threads.filter((thread) => !thread.stale);
  if (!current.length || watchRulesOutdated(current, watchRules)) return [];
  const used = new Set(
    current.map((thread) => watchRuleFor(thread.name, watchRules)?.prefix),
  );
  return watchRules.filter((rule) => !used.has(rule.prefix));
}
export function watchFindings(
  threads: readonly Thread[],
  watched: readonly WatchedThread[],
  input: WatchInput,
) {
  const { view, mode, watchRules } = input;
  const found: Finding[] = [],
    busy = watched.filter(isBusyWatched),
    stuck = watched.filter(
      (thread) => !isBusyWatched(thread) && isOverdue(thread, view.health),
    );
  if (stuck.length) found.push(...stuckFinding(stuck));
  if (busy.length) found.push(...busyFinding(busy));
  const missing = unmatchedRules(threads, input);
  if (missing.length) {
    const names = missing.map((rule) => `“${rule.prefix}”`);
    found.push({
      type: "watched",
      level: "warning",
      help: "watched",
      title:
        missing.length === 1
          ? "A watch rule matches no thread"
          : `${String(missing.length)} watch rules match no thread`,
      detail: `No thread matches watch rule${missing.length > 1 ? "s" : ""} ${andMore(names, 3)}: the threads may have exited or been renamed. Check the prefix, or remove the rule.`,
    });
  }
  if (watched.length && !stuck.length && !busy.length) {
    const prefixes =
      !watchRulesOutdated(watched, watchRules) &&
      mode.kind === "live" &&
      watchRules
        ? [
            ...new Set(
              watched.map(
                (thread) => watchRuleFor(thread.name, watchRules)?.prefix ?? "",
              ),
            ),
          ]
        : [];
    found.push({
      type: "watched",
      level: "info",
      help: "watched",
      title: `${String(watched.length)} watched thread${watched.length > 1 ? "s wake" : " wakes"} on schedule${prefixes.length ? ` (${andMore(prefixes, 3)})` : ""}`,
      detail: `Each ran within twice its wake interval, so none looks deadlocked or stuck in a loop.`,
    });
  }
  return found;
}
