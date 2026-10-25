import {
  useEffect,
  useEffectEvent,
  useId,
  useReducer,
  useRef,
  type Dispatch,
} from "react";
import type { Thread } from "../api/types";
import { readWatches, writeWatches } from "../api/watches";
import { Help } from "../help/Help";
import {
  canRead,
  draftRules,
  initialWatchEditor,
  isDirty,
  matchText,
  watchControls,
  watchEditor,
  watchMatches,
  type Change,
  type ReadyEditor,
  type WatchAction,
  type WatchEditor,
} from "../lib/watchEditor";
import "./monitor.css";

const RETRY_MS = 5000;

function readOnlyNote(state: WatchEditor) {
  switch (state.kind) {
    case "missing":
      return "This collector has no /api/watches, so watched threads cannot be edited here. Update the collector, or edit the [[watch]] rules in collector.toml and restart it.";
    case "outdated":
      return "Update the collector to edit watched-thread rules with protection against changes from another user.";
    case "loading":
      return state.error
        ? `Unable to load the watched-thread rules: ${state.error} Trying again…`
        : "Loading the watched-thread rules…";
    case "ready":
      return "";
  }
}

/**
 * The Settings section: the watched-thread rules editor. It is keyed by the
 * page target only (a target switch loads a new page), so the draft survives
 * a new process session, as before.
 */
export function WatchRules({
  threads,
  recorded = false,
  opened,
  onChanged,
}: {
  /** The collector's current threads, to count matches against. */
  threads: readonly Thread[];
  recorded?: boolean;
  /** Increases each time the Settings tab is selected. */
  opened: number;
  /** A change was applied: the assessment reads the rules again. */
  onChanged: () => void;
}) {
  const [state, dispatch] = useReducer(watchEditor, initialWatchEditor);
  const reads = useRef(0);
  const active = useRef(!recorded);
  useEffect(() => {
    active.current = !recorded;
  }, [recorded]);
  useEffect(() => {
    if (recorded) {
      ++reads.current;
      dispatch({ type: "suspend-read" });
    }
  }, [recorded]);
  useEffect(
    () => () => {
      ++reads.current;
    },
    [],
  );
  // A GET starts only while nothing is unsaved or in flight.
  const read = useEffectEvent(() => {
    if (recorded || !canRead(state)) return;
    const token = ++reads.current;
    dispatch({ type: "read", token });
    void readWatches().then((result) => {
      if (active.current && token === reads.current)
        dispatch({ type: "loaded", token, result });
    });
  });
  // At mount, and each time the Settings tab is selected.
  useEffect(() => {
    read();
  }, [opened, recorded]);
  // Until the first good reply, try again every 5 s.
  const failed =
    state.kind === "loading" && state.error !== null ? state : null;
  useEffect(() => {
    if (!failed || recorded) return;
    const timer = setTimeout(() => {
      read();
    }, RETRY_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [failed, recorded]);
  const dirty = state.kind === "ready" && isDirty(state);
  useEffect(() => {
    if (!dirty) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    addEventListener("beforeunload", warn);
    return () => {
      removeEventListener("beforeunload", warn);
    };
  }, [dirty]);
  return (
    <section id="collector-settings" className="block">
      <div className="section-head">
        <div>
          <Help topic="collsettings" as="div">
            <h2>Settings</h2>
          </Help>
          <p>
            Change how the collector watches this process, without editing files
            on the collector host. Changes apply at once.
          </p>
        </div>
      </div>
      <div className="card" id="watch-card">
        <div className="card-head">
          <div>
            <Help topic="watches" as="div">
              <h3>Watched threads</h3>
            </Help>
            <p>
              Threads whose name starts with a prefix should wake at least every
              N milliseconds, as workers that wait with a timeout do. The
              Assessment flags a matching thread that stops waking or keeps a
              core busy.
            </p>
          </div>
        </div>
        {recorded && (
          <Help topic="collsettings" as="div">
            <p id="watch-recorded-readonly" className="muted">
              Settings cannot be edited while you inspect a recorded moment.
              Select Live on the Timeline to edit them.
              {dirty ? " Your unsaved edits are kept." : ""}
            </p>
          </Help>
        )}
        <div hidden={recorded}>
          {state.kind === "ready" ? (
            <Editor
              state={state}
              recorded={recorded}
              dispatch={dispatch}
              threads={threads}
              onChanged={onChanged}
            />
          ) : (
            <Help topic="collsettings" as="div">
              <p id="watch-readonly" className="muted">
                {readOnlyNote(state)}
              </p>
            </Help>
          )}
        </div>
      </div>
    </section>
  );
}

function Editor({
  state,
  recorded,
  dispatch,
  threads,
  onChanged,
}: {
  state: ReadyEditor;
  recorded: boolean;
  dispatch: Dispatch<WatchAction>;
  threads: readonly Thread[];
  onChanged: () => void;
}) {
  const id = useId();
  const controls = watchControls(state);
  const matches = watchMatches(state.draft, threads);
  // One request at a time, even for two clicks before the next render.
  const busy = useRef(false);
  const readEpoch = useRef(0);
  const suspendRead = useEffectEvent(() => {
    ++readEpoch.current;
    if (state.op === "reload") busy.current = false;
  });
  useEffect(() => {
    suspendRead();
  }, [recorded]);
  const focusRow = useRef<number | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  async function write(change: Change) {
    if (recorded || busy.current) return;
    busy.current = true;
    dispatch({ type: "start", op: change });
    const result = await writeWatches(
      change,
      state.base.revision,
      draftRules(state.draft),
    );
    busy.current = false;
    dispatch({ type: "written", change, result });
    if (result.kind !== "failed") onChanged();
  }
  async function reload() {
    if (recorded || busy.current) return;
    if (
      controls.dirty &&
      !confirm(
        "Discard your unsaved edits and load the current rules saved by other users?",
      )
    )
      return;
    busy.current = true;
    dispatch({ type: "start", op: "reload" });
    const epoch = readEpoch.current;
    const result = await readWatches();
    if (epoch !== readEpoch.current) return;
    busy.current = false;
    dispatch({ type: "reloaded", result });
  }
  function reset() {
    const lose = controls.dirty ? " Your unsaved edits will also be lost." : "";
    if (
      confirm(
        "Discard the rules saved from the dashboard and use the [[watch]] rules from collector.toml?" +
          lose,
      )
    )
      void write("reset");
  }
  const { base } = state;
  return (
    <div id="watch-editor">
      <Help topic="watchsource" as="div">
        <p id="watch-source">
          {base.source === "dashboard"
            ? "Saved from the dashboard. These replace the [[watch]] rules in collector.toml until you reset."
            : "From the config file (collector.toml)."}
        </p>
      </Help>
      {base.saved_error && (
        <Help topic="watchsource" as="div">
          <p id="watch-warning" className="watch-warning" role="alert">
            {`The rules saved from the dashboard could not be used: ${base.saved_error.replace(/\.?$/, ".")} The rules from the config file are in force. Save new rules, or reset to remove the saved file.`}
          </p>
        </Help>
      )}
      <div className="table-wrap">
        <table className="watch-table">
          <thead>
            <tr>
              <th>
                <Help topic="watchprefix">Thread name prefix</Help>
              </th>
              <th>
                <Help topic="watchwake">Wakes at least every (ms)</Help>
              </th>
              <th>
                <Help topic="watchmatch">Matching threads now</Help>
              </th>
              <th>
                <Help topic="watchremove">Remove</Help>
              </th>
            </tr>
          </thead>
          <tbody id="watch-rows">
            {state.draft.map((row, index) => {
              const problem = controls.problems[index],
                found = matchText(row, matches.get(row.id), threads.length),
                rule = String(index + 1);
              return (
                <tr key={row.id}>
                  <td>
                    <input
                      ref={(input) => {
                        if (input && focusRow.current === row.id) {
                          focusRow.current = null;
                          input.focus();
                        }
                      }}
                      className="watch-prefix"
                      type="text"
                      value={row.prefix}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={`Thread name prefix, rule ${rule}`}
                      aria-invalid={!!problem?.prefix}
                      aria-describedby={`${id}-prefix-${String(row.id)}`}
                      disabled={controls.busy}
                      onChange={(event) => {
                        dispatch({
                          type: "edit",
                          id: row.id,
                          field: "prefix",
                          value: event.target.value,
                        });
                      }}
                    />
                    <div
                      id={`${id}-prefix-${String(row.id)}`}
                      className="watch-err"
                    >
                      {problem?.prefix || problem?.note}
                    </div>
                  </td>
                  <td>
                    <input
                      className="watch-wake"
                      type="text"
                      inputMode="numeric"
                      value={row.wake}
                      autoComplete="off"
                      spellCheck={false}
                      aria-label={`Wakes at least every (ms), rule ${rule}`}
                      aria-invalid={!!problem?.wake}
                      aria-describedby={`${id}-wake-${String(row.id)}`}
                      disabled={controls.busy}
                      onChange={(event) => {
                        dispatch({
                          type: "edit",
                          id: row.id,
                          field: "wake",
                          value: event.target.value,
                        });
                      }}
                    />
                    <div
                      id={`${id}-wake-${String(row.id)}`}
                      className="watch-err"
                    >
                      {problem?.wake}
                    </div>
                  </td>
                  <td>
                    <span className="watch-count value">{found.count}</span>
                    <span className="watch-names">{found.names}</span>
                  </td>
                  <td>
                    <button
                      type="button"
                      aria-label={`Remove rule ${rule}`}
                      disabled={controls.busy}
                      onClick={() => {
                        dispatch({ type: "remove", id: row.id });
                        addButton.current?.focus();
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {state.draft.length === 0 && (
        <Help topic="watches" as="div">
          <p id="watch-empty" className="muted">
            No rules. No thread is watched.
          </p>
        </Help>
      )}
      <div className="actions">
        <Help topic="watchadd">
          <button
            ref={addButton}
            id="watch-add"
            type="button"
            disabled={!controls.canAdd}
            onClick={() => {
              focusRow.current = state.nextId;
              dispatch({ type: "add" });
            }}
          >
            Add rule
          </button>
        </Help>
        {controls.limit && (
          <Help topic="watchadd">
            <span id="watch-limit" className="muted">
              {controls.limit}
            </span>
          </Help>
        )}
      </div>
      {controls.unsaved && (
        <Help topic="watchsave" as="div">
          <p id="watch-unsaved" className="watch-unsaved">
            {controls.unsaved}
          </p>
        </Help>
      )}
      <div className="actions">
        <Help topic="watchsave">
          <button
            id="watch-save"
            className="primary"
            type="button"
            disabled={!controls.canSave}
            onClick={() => {
              void write("save");
            }}
          >
            Save
          </button>
        </Help>
        {controls.showDiscard && (
          <Help topic="watchsave">
            <button
              id="watch-discard"
              type="button"
              disabled={controls.busy}
              onClick={() => {
                dispatch({ type: "discard" });
              }}
            >
              Discard edits
            </button>
          </Help>
        )}
        {state.conflict && (
          <Help topic="watchreload">
            <button
              id="watch-reload"
              type="button"
              disabled={controls.busy}
              onClick={() => {
                void reload();
              }}
            >
              Reload current rules
            </button>
          </Help>
        )}
        <Help topic="watchreset">
          <button
            id="watch-reset"
            type="button"
            disabled={!controls.canReset}
            onClick={reset}
          >
            Reset to config file
          </button>
        </Help>
        {/* Always present, so screen readers announce each new status. */}
        <Help topic="watchsave">
          <span id="watch-status" role="status" className={state.status.kind}>
            {state.status.text}
          </span>
        </Help>
      </div>
    </div>
  );
}
