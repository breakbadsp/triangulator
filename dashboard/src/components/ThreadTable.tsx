import { useEffect, useRef, type Dispatch } from "react";
import type { LiveResponse, Thread } from "../api/types";
import { Help } from "../help/Help";
import { isHelpTopicId, type HelpTopicId } from "../help/topics";
import type { useHolding } from "../hooks/useHeld";
import { bytes, isNum, num, pct } from "../lib/format";
import type { Series } from "../lib/series";
import {
  chips,
  isSelected,
  type Activity,
  type SortKey,
  type ThreadAction,
  type ThreadView,
  type threadRows,
} from "../lib/threadView";
import {
  STATES,
  idleFor,
  isIdle,
  stateColor,
  stateLabels,
  threadLabel,
  type TipRow,
} from "../lib/threads";
import { Sparkline } from "./Sparkline";
import { useReadout } from "../hooks/useReadout";

export function StatePill({ thread }: { thread: Thread }) {
  return (
    <span className="pill">
      <i style={{ background: stateColor(thread.state) }} />
      {(stateLabels[thread.state ?? ""] ?? thread.state ?? "") +
        (thread.stale ? " · stale" : "")}
    </span>
  );
}
export function Mix({
  counts,
  inline = false,
}: {
  counts: Readonly<Record<string, number>> | undefined;
  inline?: boolean;
}) {
  const total = Object.values(counts ?? {}).reduce(
    (sum, value) => sum + value,
    0,
  );
  return (
    <div
      className="mix"
      style={inline ? { display: "inline-flex", verticalAlign: "middle" } : {}}
    >
      {STATES.filter((state) => counts?.[state]).map((state) => (
        <span
          key={state}
          className={state}
          style={{
            width: `${String((100 * (counts?.[state] ?? 0)) / total)}%`,
          }}
        />
      ))}
    </div>
  );
}
/** One help row for each state in a sample mix. */
export const mixRows = (
  counts: Readonly<Record<string, number>> | undefined,
): TipRow[] =>
  STATES.filter((state) => counts?.[state]).map((state) => ({
    color: stateColor(state),
    value: `${String(counts?.[state])} samples`,
    label: String(stateLabels[state]),
  }));

interface Column {
  id: string;
  label: string;
  topic: HelpTopicId;
  sort?: SortKey;
  num?: boolean;
  /** The thread field this column shows, for the help card's value. */
  metric?: keyof Thread;
}
const COLUMNS: readonly Column[] = [
  { id: "thread", label: "Thread", topic: "thread", sort: "name" },
  { id: "group", label: "Group", topic: "group" },
  { id: "state", label: "State / wait channel", topic: "states" },
  { id: "mix", label: "Last ~10 s", topic: "mix" },
  {
    id: "cpu",
    label: "CPU",
    topic: "cpu",
    sort: "cpu_pct",
    num: true,
    metric: "cpu_pct",
  },
  {
    id: "delay",
    label: "Run delay",
    topic: "delay",
    sort: "run_delay_pct",
    num: true,
    metric: "run_delay_pct",
  },
  {
    id: "switches",
    label: "Switches/s",
    topic: "switches",
    sort: "switches_per_s",
    num: true,
    metric: "switches_per_s",
  },
  {
    id: "read",
    label: "Read/s",
    topic: "sysio",
    sort: "io",
    num: true,
    metric: "read_bps",
  },
  {
    id: "write",
    label: "Write/s",
    topic: "sysio",
    sort: "io",
    num: true,
    metric: "write_bps",
  },
  {
    id: "faults",
    label: "Maj. faults/s",
    topic: "faults",
    sort: "major_faults_per_s",
    num: true,
    metric: "major_faults_per_s",
  },
  { id: "core", label: "Core", topic: "cores", num: true },
];
const SORTS: readonly [SortKey, string][] = [
  ["cpu_pct", "CPU"],
  ["run_delay_pct", "Run delay"],
  ["switches_per_s", "Switches/s"],
  ["io", "I/O"],
  ["major_faults_per_s", "Major faults/s"],
  ["tid", "TID"],
  ["name", "Name"],
];
const ACTIVITIES: readonly [Activity, string][] = [
  ["active", "Active"],
  ["idle", "Idle"],
  ["all", "All"],
];

/** `#thread-details`: the filters, chips, and the thread table. */
export function ThreadTable({
  view,
  threads,
  series,
  table,
  holdHandlers,
  threadView,
  dispatch,
  onOpen,
}: {
  view: LiveResponse | undefined;
  /** The held threads and series that `table` was built from. */
  threads: readonly Thread[];
  series: Series;
  table: ReturnType<typeof threadRows>;
  holdHandlers: ReturnType<typeof useHolding>["handlers"];
  threadView: ThreadView;
  dispatch: Dispatch<ThreadAction>;
  onOpen: (thread: Thread) => void;
}) {
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (
        event.key !== "/" ||
        /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName ?? "")
      )
        return;
      event.preventDefault();
      search.current?.focus();
      search.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
    };
  }, []);
  const { readout, show, clear } = useReadout();
  const { states, wchans } = chips(threads, threadView);
  // A cell's help: the column topic, the cell value, and the thread.
  function cellHelp(
    event: React.MouseEvent,
    thread: Thread,
    column: Column,
    value: string,
    topic: HelpTopicId = column.topic,
    rows?: readonly TipRow[],
  ) {
    const raw = column.metric ? thread[column.metric] : undefined;
    const shown =
      column.metric && !isNum(raw)
        ? "Not available"
        : value === "·"
          ? "0"
          : value === "—" || value === ""
            ? "Not available"
            : value;
    show(
      event,
      `${topic}|${column.id}|${String(thread.tid)}:${String(thread.generation)}`,
      threadLabel(thread),
      rows ?? [
        {
          color: "",
          value: shown,
          label: column.label,
        },
      ],
      thread.last_sample ?? series.lastTick,
      topic,
    );
  }
  return (
    <div id="thread-details" className="card" style={{ marginTop: 14 }}>
      <div className="card-head">
        <Help topic="active" as="div">
          <h3>Thread details</h3>
        </Help>
      </div>
      <div className="toolbar">
        <Help topic="active" as="div">
          <div className="seg" role="group" aria-label="Which threads to show">
            {ACTIVITIES.map(([activity, label]) => (
              <button
                key={activity}
                type="button"
                data-activity={activity}
                aria-pressed={threadView.activity === activity}
                onClick={() => {
                  dispatch({ type: "activity", activity });
                }}
              >
                {label}{" "}
                <span id={`n-${activity}`} className="muted">
                  {table.counts[activity]}
                </span>
              </button>
            ))}
          </div>
        </Help>
        <Help topic="thread">
          <input
            ref={search}
            id="search"
            type="search"
            placeholder="Thread name, TID or wait channel"
            aria-label="Find thread"
            value={threadView.search}
            onChange={(event) => {
              dispatch({ type: "search", search: event.target.value });
            }}
          />
        </Help>
        <Help topic="group">
          <label>
            Group{" "}
            <select
              id="group"
              value={threadView.group}
              onChange={(event) => {
                dispatch({ type: "group", group: event.target.value });
              }}
            >
              <option value="">All groups</option>
              {Object.entries(view?.groups ?? {}).map(([name, count]) => (
                <option key={name} value={name}>
                  {`${name} (${String(count)})`}
                </option>
              ))}
            </select>
          </label>
        </Help>
        <Help topic="active">
          <label>
            Sort{" "}
            <select
              id="sort"
              value={threadView.sort}
              onChange={(event) => {
                dispatch({
                  type: "sort",
                  sort: event.target.value as SortKey,
                });
              }}
            >
              {SORTS.map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </Help>
        <Help topic="active">
          <button
            id="clear-filters"
            type="button"
            onClick={() => {
              dispatch({ type: "clear" });
            }}
          >
            Clear filters
          </button>
        </Help>
      </div>
      <div id="threads-live" {...holdHandlers}>
        <Help topic="states" as="div" className="chips-title">
          State / block type
        </Help>
        <div id="state-chips" className="chips">
          {states.map((chip) => (
            <Help
              key={chip.value}
              topic={chip.value ? (chip.value as HelpTopicId) : "active"}
            >
              <button
                type="button"
                className="chip"
                aria-pressed={chip.pressed}
                onClick={() => {
                  dispatch({ type: "stateChip", state: chip.value });
                }}
              >
                {chip.value && <span className={`sw ${chip.value}`} />}
                <span>{chip.label}</span>
                <span className="count">{chip.count}</span>
              </button>
            </Help>
          ))}
        </div>
        <Help topic="wchan" as="div" className="chips-title">
          Wait channel{" "}
          <span style={{ textTransform: "none", letterSpacing: 0 }}>
            (kernel function the thread is blocked in)
          </span>
        </Help>
        <div id="wchan-chips" className="chips">
          {wchans.map((chip) => (
            <Help key={chip.value} topic={chip.value ? "wchan" : "active"}>
              <button
                type="button"
                className="chip mono"
                aria-pressed={chip.pressed}
                onClick={() => {
                  dispatch({ type: "wchanChip", wchan: chip.value });
                }}
              >
                <span>{chip.label}</span>
                <span className="count">{chip.count}</span>
              </button>
            </Help>
          ))}
        </div>
        <p
          id="idle-summary"
          className="muted"
          style={{ margin: "0 0 8px", fontSize: 13 }}
        >
          {table.idleSummary && (
            <Help topic="active">
              {table.idleSummary}
              <button
                type="button"
                style={{ padding: "2px 8px", marginLeft: 6, fontSize: 12 }}
                onClick={() => {
                  dispatch({ type: "activity", activity: "idle" });
                }}
              >
                Show them
              </button>
            </Help>
          )}
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th
                    key={column.id}
                    className={column.num ? "num" : undefined}
                    data-sort={column.sort}
                    aria-sort={
                      column.sort
                        ? column.sort === threadView.sort
                          ? "descending"
                          : "none"
                        : undefined
                    }
                    onClick={
                      column.sort
                        ? () => {
                            if (column.sort)
                              dispatch({ type: "sort", sort: column.sort });
                          }
                        : undefined
                    }
                  >
                    <Help topic={column.topic}>{column.label}</Help>
                  </th>
                ))}
              </tr>
            </thead>
            <Help
              as="tbody"
              id="threads"
              topic={readout?.topic ?? "thread"}
              readout={readout ?? undefined}
            >
              {table.rows.map((thread) => {
                const cell = (
                  column: Column,
                  value: string,
                  className?: string,
                ) => (
                  <td
                    className={className}
                    onMouseMove={(event) => {
                      cellHelp(event, thread, column, value);
                    }}
                  >
                    {value}
                  </td>
                );
                const [
                  name,
                  group,
                  state,
                  mix,
                  cpu,
                  delay,
                  switches,
                  read,
                  write,
                  faults,
                  core,
                ] = COLUMNS as [
                  Column,
                  Column,
                  Column,
                  Column,
                  Column,
                  Column,
                  Column,
                  Column,
                  Column,
                  Column,
                  Column,
                ];
                const idle = isIdle(thread);
                // A zero rate shows a dot, so the busy cells stand out.
                const rateCell = (
                  column: Column,
                  value: number | null | undefined,
                  format: (value: unknown) => string,
                ) => {
                  const shown = value && value > 0 ? format(value) : "·";
                  return (
                    <td
                      key={column.id}
                      className={"num" + (shown === "·" ? " muted" : "")}
                      onMouseMove={(event) => {
                        cellHelp(event, thread, column, shown);
                      }}
                    >
                      {shown}
                    </td>
                  );
                };
                return (
                  <tr
                    key={`${String(thread.tid)}:${String(thread.generation)}`}
                    className={
                      "clickable" +
                      (isSelected(
                        threadView.selected,
                        view?.health.session,
                        thread,
                      )
                        ? " selected"
                        : "")
                    }
                    data-tid={thread.tid}
                    data-generation={thread.generation}
                    tabIndex={0}
                    onMouseLeave={clear}
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpen(thread);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") onOpen(thread);
                    }}
                  >
                    <td
                      onMouseMove={(event) => {
                        cellHelp(event, thread, name, thread.name);
                      }}
                    >
                      <span>{thread.name}</span>
                      <small>TID {thread.tid}</small>
                    </td>
                    {cell(group, thread.group ?? "")}
                    <td
                      onMouseMove={(event) => {
                        cellHelp(
                          event,
                          thread,
                          state,
                          (stateLabels[thread.state ?? ""] ??
                            thread.state ??
                            "") + (thread.wchan ? " · " + thread.wchan : ""),
                          thread.state && isHelpTopicId(thread.state)
                            ? thread.state
                            : "states",
                        );
                      }}
                    >
                      <StatePill thread={thread} />
                      {thread.wchan && (
                        <span className="wchan">{thread.wchan}</span>
                      )}
                    </td>
                    <td
                      onMouseMove={(event) => {
                        cellHelp(
                          event,
                          thread,
                          mix,
                          "",
                          "mix",
                          mixRows(thread.state_mix),
                        );
                      }}
                    >
                      <Mix counts={thread.state_mix} />
                    </td>
                    {idle ? (
                      <>
                        <td
                          className="muted"
                          colSpan={6}
                          onMouseMove={(event) => {
                            cellHelp(
                              event,
                              thread,
                              {
                                ...cpu,
                                id: "idle",
                                label: "Activity",
                                metric: undefined,
                              },
                              idleFor(thread, series) || "idle",
                              "active",
                            );
                          }}
                        >
                          {idleFor(thread, series) || "idle"}
                        </td>
                        {cell(core, String(thread.cpu ?? ""), "num")}
                      </>
                    ) : (
                      <>
                        <td
                          className="num"
                          onMouseMove={(event) => {
                            cellHelp(event, thread, cpu, pct(thread.cpu_pct));
                          }}
                        >
                          <div className="cpu-cell">
                            <Sparkline
                              className="spark"
                              values={(series.cpu.get(thread.tid) ?? []).map(
                                (sample) => sample.v,
                              )}
                              color="var(--series-1)"
                              min={5}
                            />
                            <span>{pct(thread.cpu_pct)}</span>
                          </div>
                        </td>
                        {rateCell(delay, thread.run_delay_pct, pct)}
                        {rateCell(switches, thread.switches_per_s, num)}
                        {rateCell(read, thread.read_bps, bytes)}
                        {rateCell(write, thread.write_bps, bytes)}
                        {rateCell(faults, thread.major_faults_per_s, num)}
                        {cell(core, String(thread.cpu ?? ""), "num")}
                      </>
                    )}
                  </tr>
                );
              })}
              {!table.rows.length && (
                <tr>
                  <td className="muted" colSpan={11}>
                    {table.empty}
                  </td>
                </tr>
              )}
            </Help>
          </table>
        </div>
      </div>
    </div>
  );
}
