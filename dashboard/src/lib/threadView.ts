import type { Thread } from "../api/types";
import { duration, isNum } from "./format";
import type { Series } from "./series";
import { STATES, isIdle, stateLabels } from "./threads";

// What the thread table shows, and which thread the drawer shows. Each action
// is one of the old page's handlers (777cf3a: setActivity, renderChips,
// renderWchans, renderFamilies, the clear-filters button, and the finding
// actions), so the filters that each one clears stay in one place.
export type Activity = "active" | "idle" | "all";
export const SORT_KEYS = [
  "cpu_pct",
  "run_delay_pct",
  "switches_per_s",
  "io",
  "major_faults_per_s",
  "tid",
  "name",
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export interface SelectedThread {
  session: string | null | undefined;
  tid: number;
  generation: number | undefined;
  name: string;
}
export interface ThreadView {
  activity: Activity;
  search: string;
  group: string;
  state: string;
  wchan: string;
  sort: SortKey;
  selected: SelectedThread | null;
}
export const initialThreadView: ThreadView = {
  activity: "active",
  search: "",
  group: "",
  state: "",
  wchan: "",
  sort: "cpu_pct",
  selected: null,
};
export type ThreadAction =
  | { type: "activity"; activity: Activity }
  | { type: "search"; search: string }
  | { type: "group"; group: string }
  | { type: "sort"; sort: SortKey }
  /** A state chip; "" is All. Another state clears the wait channel. */
  | { type: "stateChip"; state: string }
  /** A wait-channel chip; "" is All. */
  | { type: "wchanChip"; wchan: string }
  /** A wait-channel bar: shows all threads in that channel. */
  | { type: "wchanBar"; wchan: string }
  /** A family or group bar. */
  | { type: "familyBar"; mode: "family" | "group"; key: string }
  | {
      type: "finding";
      state?: string | undefined;
      activity?: string | undefined;
    }
  | { type: "clear" }
  | { type: "open"; selected: SelectedThread }
  | { type: "close" };

const toggle = (current: string, value: string) =>
  current === value ? "" : value;
const isActivity = (value: string | undefined): value is Activity =>
  value === "active" || value === "idle" || value === "all";

export function threadView(view: ThreadView, action: ThreadAction): ThreadView {
  switch (action.type) {
    case "activity":
      return { ...view, activity: action.activity };
    case "search":
      return { ...view, search: action.search };
    case "group":
      return { ...view, group: action.group };
    case "sort":
      return { ...view, sort: action.sort };
    case "stateChip":
      return action.state
        ? { ...view, state: toggle(view.state, action.state), wchan: "" }
        : { ...view, state: "" };
    case "wchanChip":
      return {
        ...view,
        wchan: action.wchan && toggle(view.wchan, action.wchan),
      };
    case "wchanBar": {
      const wchan = toggle(view.wchan, action.wchan);
      return {
        ...view,
        wchan,
        state: "",
        activity: wchan ? "all" : view.activity,
      };
    }
    case "familyBar":
      return {
        ...view,
        search: action.mode === "family" ? action.key : "",
        group: action.mode === "group" ? action.key : view.group,
        activity: "all",
      };
    case "finding":
      return {
        ...view,
        state: action.state ?? "",
        wchan: "",
        activity: isActivity(action.activity) ? action.activity : "all",
      };
    case "clear":
      return {
        ...view,
        state: "",
        wchan: "",
        group: "",
        search: "",
        activity: "active",
      };
    case "open":
      return { ...view, selected: action.selected };
    case "close":
      return { ...view, selected: null };
  }
}

/** Whether the table shows the thread, optionally ignoring one filter. */
export function matches(
  thread: Thread,
  view: ThreadView,
  ignore: { state?: boolean; wchan?: boolean; activity?: boolean } = {},
) {
  const search = view.search.toLowerCase();
  if (
    !ignore.activity &&
    view.activity !== "all" &&
    isIdle(thread) !== (view.activity === "idle")
  )
    return false;
  if (view.group && thread.group !== view.group) return false;
  if (
    search &&
    !`${thread.name} ${String(thread.tid)} ${thread.wchan ?? ""}`
      .toLowerCase()
      .includes(search)
  )
    return false;
  if (!ignore.state && view.state && thread.state !== view.state) return false;
  if (!ignore.wchan && view.wchan && (thread.wchan || "—") !== view.wchan)
    return false;
  return true;
}

function tally<K>(threads: readonly Thread[], key: (thread: Thread) => K) {
  const counts = new Map<K, number>();
  for (const thread of threads) {
    const value = key(thread);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts].sort(
    (left, right) =>
      right[1] - left[1] || String(left[0]).localeCompare(String(right[0])),
  );
}
export interface Chip {
  /** The filter value; "" is All. */
  value: string;
  label: string;
  count: number;
  pressed: boolean;
}
/** The state and wait-channel chips, each counted under the other filters. */
export function chips(threads: readonly Thread[], view: ThreadView) {
  const stateBase = threads.filter((thread) =>
    matches(thread, view, { state: true }),
  );
  const present = new Map(tally(stateBase, (thread) => thread.state ?? ""));
  if (view.state && !present.has(view.state)) present.set(view.state, 0);
  const states: Chip[] = [
    { value: "", label: "All", count: stateBase.length, pressed: !view.state },
    ...STATES.filter((state) => present.has(state)).map((state) => ({
      value: state,
      label: String(stateLabels[state]),
      count: present.get(state) ?? 0,
      pressed: view.state === state,
    })),
  ];
  const wchanBase = threads.filter((thread) =>
    matches(thread, view, { wchan: true }),
  );
  const channels = tally(wchanBase, (thread) => thread.wchan || "—");
  if (view.wchan && !channels.some(([name]) => name === view.wchan))
    channels.push([view.wchan, 0]);
  const wchans: Chip[] = [
    { value: "", label: "All", count: wchanBase.length, pressed: !view.wchan },
    ...channels.map(([name, count]) => ({
      value: name,
      label: name,
      count,
      pressed: view.wchan === name,
    })),
  ];
  return { states, wchans };
}

const STUCK_FUTEX_S = 30;
const sortValue: Record<
  Exclude<SortKey, "name">,
  (thread: Thread) => number
> = {
  tid: (thread) => -thread.tid,
  io: (thread) => (thread.read_bps || 0) + (thread.write_bps || 0),
  cpu_pct: (thread) => thread.cpu_pct ?? -1,
  run_delay_pct: (thread) => thread.run_delay_pct ?? -1,
  switches_per_s: (thread) => thread.switches_per_s ?? -1,
  major_faults_per_s: (thread) => thread.major_faults_per_s ?? -1,
};
/** The rows, the activity counts, and the idle summary of the thread table. */
export function threadRows(
  threads: readonly Thread[],
  view: ThreadView,
  series: Series,
) {
  const base = threads.filter((thread) =>
      matches(thread, view, { activity: true }),
    ),
    idle = base.filter(isIdle);
  let idleSummary = "";
  if (view.activity === "active" && idle.length) {
    const waits = tally(
      idle,
      (thread) => stateLabels[thread.state ?? ""] ?? thread.state ?? "",
    )
      .map(([state, count]) => `${String(count)} ${state.toLowerCase()}`)
      .join(", ");
    const longest = Math.max(
      0,
      ...idle
        .filter((thread) => thread.state === "futex")
        .map((thread) => {
          const since = series.seen.get(thread.tid)?.futexSince;
          return isNum(since)
            ? (series.lastTick || thread.last_sample || 0) - since
            : null;
        })
        .filter(isNum),
    );
    idleSummary =
      `${String(idle.length)} idle thread${idle.length > 1 ? "s" : ""} hidden (${waits}).` +
      (longest >= STUCK_FUTEX_S
        ? ` Longest futex wait: over ${duration(longest)}.`
        : "");
  }
  const key = view.sort === "name" ? null : sortValue[view.sort];
  const rows = threads
    .filter((thread) => matches(thread, view))
    .sort(
      key
        ? (left, right) => key(right) - key(left) || left.tid - right.tid
        : (left, right) =>
            left.name.localeCompare(right.name) || left.tid - right.tid,
    );
  const filtered =
    view.activity !== "active" || view.state || view.wchan || view.search;
  return {
    rows,
    counts: {
      active: base.length - idle.length,
      idle: idle.length,
      all: base.length,
    },
    idleSummary,
    count:
      rows.length === threads.length
        ? `(${String(threads.length)})`
        : `(${String(rows.length)} of ${String(threads.length)})`,
    empty: !threads.length
      ? "No threads reported yet."
      : filtered
        ? "No threads match these filters."
        : "Every thread is idle right now.",
  };
}
