import type { Thread, WatchInfo, WatchLimits, WatchRule } from "../api/types";

// The watched-thread rules editor of the Settings section. The collector is
// the authority: it checks the revision and every rule again. The editor
// keeps the draft of the user, the rules in force that the draft started
// from (`base`), and never replaces a draft with unsaved edits.

/** The rules in force, with the revision that a write must name. */
export type EditableInfo = WatchInfo & { revision: string };
export interface DraftRow {
  /** Stable for the life of the row: its React key. */
  id: number;
  prefix: string;
  /** As typed, in milliseconds. */
  wake: string;
}
export type Change = "save" | "reset";
export type Op = Change | "reload";
export interface Status {
  text: string;
  kind: "muted" | "good" | "bad" | "warning";
}
export interface Ready {
  kind: "ready";
  base: EditableInfo;
  draft: readonly DraftRow[];
  /** The request in flight, if any. */
  op: Op | null;
  /** A write was refused as stale: only Reload continues. */
  conflict: boolean;
  /** The collector applied this change but could not confirm it on disk. */
  unconfirmed: Change | null;
  status: Status;
}
export type ReadyEditor = Extract<WatchEditor, { kind: "ready" }>;
export type WatchEditor = {
  /** The token of the GET whose reply is still wanted. */
  read: number | null;
  /** The id of the next new row. */
  nextId: number;
} & (
  | { kind: "loading"; error: string | null }
  | { kind: "missing" }
  /** A collector without edit revisions: read-only. */
  | { kind: "outdated" }
  | Ready
);

/** The result of a GET at the boundary (api/watches.ts). */
export type WatchRead =
  | { kind: "ok"; info: WatchInfo }
  | { kind: "missing" }
  | { kind: "error"; message: string };
/** The result of a save or reset at the boundary. */
export type WatchWrite =
  | { kind: "done"; info: WatchInfo }
  | { kind: "failed"; message: string; conflict: boolean }
  /** Applied but not confirmed on disk; `state` is null without a revision. */
  | { kind: "applied"; message: string; state: EditableInfo | null };

export type WatchAction =
  | { type: "read"; token: number }
  | { type: "loaded"; token: number; result: WatchRead }
  | { type: "edit"; id: number; field: "prefix" | "wake"; value: string }
  | { type: "add" }
  | { type: "remove"; id: number }
  | { type: "discard" }
  | { type: "start"; op: Op }
  | { type: "written"; change: Change; result: WatchWrite }
  | { type: "reloaded"; result: WatchRead };

export const initialWatchEditor: WatchEditor = {
  kind: "loading",
  error: null,
  read: null,
  nextId: 0,
};
const quiet: Status = { text: "", kind: "muted" };

/** Size in UTF-8 bytes, the unit of the collector's 15-byte limit. */
const encoder = new TextEncoder();
/**
 * Size in UTF-8 bytes, the unit of the collector's 15-byte limit. A lone
 * surrogate counts 3 bytes, as the replacement character that it sends.
 */
export const byteLength = (text: string) => encoder.encode(text).length;

export const isDirty = (state: Ready) =>
  JSON.stringify(
    state.base.rules.map((rule) => [rule.prefix, String(rule.wake_ms)]),
  ) !== JSON.stringify(state.draft.map((row) => [row.prefix, row.wake.trim()]));

/**
 * A GET may start, and its reply may apply, only while nothing is unsaved,
 * in flight, or waiting for a retry. A retry must name the revision of its
 * own applied change, never one that a later read brought from another
 * editor; only Reload replaces it.
 */
export const canRead = (state: WatchEditor) =>
  state.kind !== "ready" ||
  (state.op === null && state.unconfirmed === null && !isDirty(state));

/** The rules a save sends. */
export const draftRules = (draft: readonly DraftRow[]): WatchRule[] =>
  draft.map((row) => ({
    prefix: row.prefix,
    wake_ms: Number(row.wake.trim()),
  }));

export interface Problem {
  prefix: string;
  wake: string;
  /** Advice that does not block Save. */
  note: string;
}
/** One problem message per field, from the limits the collector reports. */
export function watchProblems(
  draft: readonly DraftRow[],
  limits: WatchLimits,
): Problem[] {
  const first = new Map<string, number>();
  return draft.map((row, index) => {
    const problem = { prefix: "", wake: "", note: "" },
      size = byteLength(row.prefix);
    if (!row.prefix) problem.prefix = "Enter a prefix.";
    else if (row.prefix.includes("\0"))
      problem.prefix = "A prefix cannot contain a NUL character.";
    else if (size > limits.prefix_max_bytes)
      problem.prefix = `Too long: ${String(size)} bytes. Thread names are at most ${String(limits.prefix_max_bytes)} bytes.`;
    else if (first.has(row.prefix))
      problem.prefix = `Same prefix as rule ${String((first.get(row.prefix) ?? 0) + 1)}. Each prefix may appear once.`;
    else {
      first.set(row.prefix, index);
      if (/^\s|\s$/.test(row.prefix))
        problem.note =
          "The prefix starts or ends with a space. It must match the thread name exactly.";
    }
    const text = row.wake.trim();
    if (text === "") problem.wake = "Enter a number of milliseconds.";
    else if (!/^\d+$/.test(text))
      problem.wake = "Use a whole number of milliseconds, such as 500.";
    else {
      const wake = Number(text);
      if (wake < limits.wake_ms_min)
        problem.wake = `At least ${limits.wake_ms_min.toLocaleString()} ms.`;
      else if (wake > limits.wake_ms_max)
        problem.wake = `At most ${limits.wake_ms_max.toLocaleString()} ms.`;
    }
    return problem;
  });
}

interface Found {
  /** Thread name to how many threads have it. */
  names: Map<string, number>;
  count: number;
  /** Threads that match the prefix but use a longer rule. */
  longer: number;
}
const usable = (row: DraftRow) =>
  row.prefix !== "" && !row.prefix.includes("\0");
/**
 * For each row id: the threads that use it (the longest matching prefix
 * wins, as in the collector; the first of equal prefixes wins), and the
 * ones that match it but use a longer rule.
 */
export function watchMatches(
  draft: readonly DraftRow[],
  threads: readonly Thread[],
) {
  const rules = draft
    .filter(usable)
    .map((row) => ({ row, size: byteLength(row.prefix) }));
  const result = new Map<number, Found>(
    draft.map((row) => [row.id, { names: new Map(), count: 0, longer: 0 }]),
  );
  for (const thread of threads) {
    const name = typeof thread.name === "string" ? thread.name : "";
    let best: (typeof rules)[number] | null = null;
    const matching: typeof rules = [];
    for (const rule of rules)
      if (name.startsWith(rule.row.prefix)) {
        matching.push(rule);
        if (!best || rule.size > best.size) best = rule;
      }
    if (!best) continue;
    const found = result.get(best.row.id);
    if (!found) continue;
    found.count++;
    found.names.set(name, (found.names.get(name) ?? 0) + 1);
    for (const rule of matching)
      if (rule.size < best.size) {
        const shorter = result.get(rule.row.id);
        if (shorter) shorter.longer++;
      }
  }
  return result;
}

/** The "Matching threads now" cell of one row. */
export function matchText(
  row: DraftRow,
  found: Found | undefined,
  threadCount: number,
): { count: string; names: string } {
  if (!usable(row) || !found) return { count: "—", names: "" };
  const longer = found.longer
    ? `${String(found.longer)} more thread${found.longer === 1 ? " starts" : "s start"} with this prefix but ${found.longer === 1 ? "uses" : "use"} a longer rule.`
    : "";
  const names = [...found.names].map(([name, count]) =>
    count > 1 ? `${name} (×${String(count)})` : name,
  );
  const listed =
    names.slice(0, 3).join(", ") +
    (names.length > 3 ? ` and ${String(names.length - 3)} more` : "");
  return {
    count: String(found.count),
    names: found.count
      ? listed + (longer ? ". " + longer : "")
      : longer
        ? "No thread uses this rule. " + longer
        : threadCount
          ? "No live thread name starts with this prefix."
          : "No live threads to check against.",
  };
}

/** What the controls of a ready editor allow. */
export function watchControls(state: Ready) {
  const problems = watchProblems(state.draft, state.base.limits),
    invalid = problems.some((problem) => problem.prefix || problem.wake),
    dirty = isDirty(state),
    full = state.draft.length >= state.base.limits.max_rules,
    busy = state.op !== null;
  return {
    problems,
    dirty,
    busy,
    canSave:
      !busy &&
      !state.conflict &&
      !invalid &&
      (dirty || state.unconfirmed === "save"),
    showDiscard: dirty && !state.conflict,
    canAdd: !busy && !full,
    limit: full ? `At most ${String(state.base.limits.max_rules)} rules.` : "",
    canReset:
      !busy &&
      !state.conflict &&
      (state.base.source === "dashboard" ||
        !!state.base.saved_error ||
        state.unconfirmed === "reset"),
    unsaved: !dirty
      ? ""
      : invalid
        ? "Unsaved edits. Fix the marked fields, then select Save. Nothing changes until you do."
        : "Unsaved edits. They apply only after you select Save.",
  };
}

// Takes a reply as the new truth: the base and a draft equal to it.
function apply(
  state: WatchEditor,
  info: WatchInfo,
  change: Partial<Ready> = {},
): WatchEditor {
  const { revision } = info;
  if (!revision) return { kind: "outdated", read: null, nextId: state.nextId };
  const previous = state.kind === "ready" ? state : null;
  return {
    kind: "ready",
    read: null,
    nextId: state.nextId + info.rules.length,
    base: { ...info, revision },
    draft: info.rules.map((rule, index) => ({
      id: state.nextId + index,
      prefix: rule.prefix,
      wake: String(rule.wake_ms),
    })),
    op: null,
    conflict: false,
    unconfirmed: previous?.unconfirmed ?? null,
    status: previous?.status ?? quiet,
    ...change,
  };
}

const DONE: Record<Change, string> = {
  save: "Saved and applied.",
  reset: "Reset. The rules from the config file are in force.",
};
const BUTTON: Record<Change, string> = {
  save: "Save",
  reset: "Reset to config file",
};

export function watchEditor(
  state: WatchEditor,
  action: WatchAction,
): WatchEditor {
  switch (action.type) {
    case "read":
      return canRead(state) ? { ...state, read: action.token } : state;
    case "loaded": {
      // Drop a reply that a newer read, a write, or an edit overtook.
      if (action.token !== state.read || !canRead(state)) return state;
      const { result } = action;
      if (result.kind === "ok") return apply(state, result.info);
      if (result.kind === "missing")
        return { kind: "missing", read: null, nextId: state.nextId };
      return state.kind === "ready" || state.kind === "outdated"
        ? { ...state, read: null }
        : {
            kind: "loading",
            error: result.message,
            read: null,
            nextId: state.nextId,
          };
    }
    case "start":
      if (state.kind !== "ready" || state.op) return state;
      return {
        ...state,
        op: action.op,
        read: null,
        status: {
          text: action.op === "reload" ? "Loading current rules…" : "Saving…",
          kind: "muted",
        },
      };
    case "written": {
      if (state.kind !== "ready") return state;
      const idle = { ...state, op: null };
      const { result, change } = action;
      if (result.kind === "done")
        return apply(idle, result.info, {
          unconfirmed: null,
          status: { text: DONE[change], kind: "good" },
        });
      if (result.kind === "failed")
        return {
          ...idle,
          conflict: idle.conflict || result.conflict,
          status: { text: result.message, kind: "bad" },
        };
      // Retry only with the revision of this change. A later GET can belong
      // to another editor and must not authorize overwriting its rules.
      const next = result.state
        ? apply(idle, result.state, { unconfirmed: change })
        : { ...idle, unconfirmed: change, conflict: true };
      if (next.kind !== "ready") return next;
      return {
        ...next,
        status: {
          text: `Warning: ${result.message.replace(/\.?$/, ".")} ${next.conflict ? "Reload current rules before retrying." : `Select ${BUTTON[change]} again to retry.`}`,
          kind: "warning",
        },
      };
    }
    case "reloaded": {
      if (state.kind !== "ready") return state;
      const idle = { ...state, op: null };
      const { result } = action;
      if (result.kind === "ok")
        return apply(idle, result.info, {
          unconfirmed: null,
          status: {
            text: "Current rules loaded. Review them before editing.",
            kind: "muted",
          },
        });
      return {
        ...idle,
        status: {
          text:
            result.kind === "missing"
              ? "The collector answered HTTP 404."
              : result.message,
          kind: "bad",
        },
      };
    }
  }
  // Draft edits: only while no request is in flight.
  if (state.kind !== "ready" || state.op) return state;
  const edited = (draft: readonly DraftRow[], nextId = state.nextId) => ({
    ...state,
    draft,
    nextId,
    status: quiet,
  });
  switch (action.type) {
    case "edit":
      return edited(
        state.draft.map((row) =>
          row.id === action.id ? { ...row, [action.field]: action.value } : row,
        ),
      );
    case "add":
      return edited(
        [...state.draft, { id: state.nextId, prefix: "", wake: "" }],
        state.nextId + 1,
      );
    case "remove":
      return edited(state.draft.filter((row) => row.id !== action.id));
    case "discard":
      return apply(state, state.base, { status: quiet });
  }
}
