import { useState, type Dispatch, type MouseEvent } from "react";
import type { LiveResponse, Thread } from "../api/types";
import { Help } from "../help/Help";
import type { HelpTopicId } from "../help/topics";
import { useReadout } from "../hooks/useReadout";
import { useHeld, useHolding } from "../hooks/useHeld";
import { num, pct } from "../lib/format";
import { windowPoints, type Point, type Series } from "../lib/series";
import {
  threadRows,
  isSelected,
  type SelectedThread,
  type ThreadAction,
  type ThreadView,
} from "../lib/threadView";
import {
  STATES,
  coreColumns,
  familyItems,
  mapCells,
  stateColor,
  stateLabels,
  threadLabel,
  wchanItems,
  type BarItem,
  type FamilyMode,
  type MapWindow,
} from "../lib/threads";
import { Fold } from "./Fold";
import { TimeChart } from "./TimeChart";
import { ThreadTable } from "./ThreadTable";
import "./threads.css";

function BarList({
  id,
  topic,
  items,
  format,
  pressed,
  mono,
  empty,
  stamp,
  onClick,
  scope = id,
}: {
  id: string;
  scope?: string;
  topic: HelpTopicId;
  items: readonly BarItem[];
  format: (value: number) => string;
  pressed?: string;
  mono?: boolean;
  empty: string;
  stamp: number;
  onClick: ((item: BarItem) => void) | null;
}) {
  const { readout, show, clear } = useReadout();
  const max = Math.max(...items.map((item) => item.value)) || 1;
  return (
    <Help topic={topic} as="div" readout={readout ?? undefined}>
      <div id={id} className="bars" onMouseLeave={clear}>
        {!items.length && <p className="muted">{empty}</p>}
        {items.map((item) => {
          const Row = onClick ? "button" : "div";
          return (
            <Row
              key={item.key ?? item.label}
              className="bar-row"
              {...(onClick
                ? {
                    type: "button" as const,
                    "aria-pressed": pressed === item.key,
                    onClick: (event: MouseEvent) => {
                      event.stopPropagation();
                      onClick(item);
                    },
                  }
                : {})}
              onMouseMove={(event: MouseEvent) => {
                show(
                  event,
                  `${scope}|${item.label}`,
                  item.label,
                  item.tip,
                  stamp,
                );
              }}
            >
              <span className={"name" + (mono ? " mono" : "")}>
                {item.label}
              </span>
              <span className="track">
                <span
                  className="fill"
                  style={{
                    width: `${String((100 * item.value) / max)}%`,
                    ...(item.color ? { background: item.color } : {}),
                  }}
                />
              </span>
              <span className="val">
                {format(item.value)}
                {item.sub && <small>{item.sub}</small>}
              </span>
            </Row>
          );
        })}
      </div>
    </Help>
  );
}

const MAP_WINDOWS: readonly [MapWindow, string][] = [
  [0, "Now"],
  [60, "1 min"],
  [300, "5 min"],
  [900, "15 min"],
];
function ThreadMap({
  threads,
  series,
  selected,
  onOpen,
}: {
  threads: readonly Thread[];
  series: Series;
  selected: SelectedThread | null;
  onOpen: (thread: Thread, session: Series["session"]) => void;
}) {
  const [window, setWindow] = useState<MapWindow>(0);
  const { holding, handlers } = useHolding();
  // The averages and the order come from the same held data, so a poll
  // cannot move the tile under the pointer.
  const held = useHeld({ threads, series }, holding);
  const map = mapCells(held.threads, held.series, window);
  const { readout, show, clear } = useReadout();
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <Help topic="map" as="div">
            <h3>Thread map</h3>
          </Help>
          <p id="mosaic-sub">{map.sub}</p>
        </div>
        <Help topic="map" as="div">
          <div className="seg" role="group" aria-label="Thread map time window">
            {MAP_WINDOWS.map(([seconds, label]) => (
              <button
                key={seconds}
                type="button"
                data-map-window={seconds}
                aria-pressed={window === seconds}
                onClick={() => {
                  setWindow(seconds);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </Help>
      </div>
      <div {...handlers}>
        <Help topic="map" as="div" readout={readout ?? undefined}>
          <div
            id="mosaic"
            className={"mosaic" + (map.dense ? " dense" : "")}
            onMouseLeave={clear}
          >
            {map.cells.map((cell) => (
              <div
                key={`${String(cell.thread.tid)}:${String(cell.thread.generation)}`}
                data-tid={cell.thread.tid}
                className={
                  "cell" +
                  (cell.thread.stale ? " stale" : cell.idle ? " idle" : "")
                }
                aria-label={cell.label}
                style={{
                  background: stateColor(cell.state),
                  color: `var(--t-${cell.state})`,
                  ...(isSelected(selected, held.series.session, cell.thread)
                    ? { outline: "2px solid var(--ink)" }
                    : {}),
                }}
                onMouseMove={(event) => {
                  show(
                    event,
                    `map|${String(cell.thread.tid)}:${String(cell.thread.generation)}`,
                    threadLabel(cell.thread),
                    cell.tip,
                    cell.thread.last_sample ?? held.series.lastTick,
                  );
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(cell.thread, held.series.session);
                }}
              >
                {cell.text}
              </div>
            ))}
            {!held.threads.length && (
              <p className="muted">No threads reported yet.</p>
            )}
          </div>
        </Help>
        <div id="mosaic-legend">
          <div className="legend">
            {map.legend.map(({ state, count }) => (
              <Help key={state} topic={state}>
                <i className={`sw ${state}`} />
                {stateLabels[state]}
                <b>{count}</b>
              </Help>
            ))}
            <Help topic="map" className="muted">
              {map.note}
            </Help>
            {map.shortData && (
              <Help topic="map" className="bad">
                {map.shortData}
              </Help>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const FAMILY_SUBS: Record<FamilyMode, string> = {
  family: "Process CPU by thread family (name without its number).",
  group: "Process CPU by thread group from the collector config.",
  thread: "Process CPU by individual thread.",
};
function Families({
  threads,
  barHandlers,
  stamp,
  dispatch,
  onShowTable,
}: {
  threads: readonly Thread[];
  barHandlers: ReturnType<typeof useHolding>["handlers"];
  stamp: number;
  dispatch: Dispatch<ThreadAction>;
  onShowTable: () => void;
}) {
  const [mode, setMode] = useState<FamilyMode>("family");
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <Help topic="families" as="div">
            <h3>Where the CPU goes</h3>
          </Help>
          <p id="family-sub">{FAMILY_SUBS[mode]}</p>
        </div>
        <Help topic="families">
          <select
            id="family-mode"
            aria-label="Group CPU by"
            value={mode}
            onChange={(event) => {
              setMode(event.target.value as FamilyMode);
            }}
          >
            <option value="family">Name family</option>
            <option value="group">Config group</option>
            <option value="thread">Thread</option>
          </select>
        </Help>
      </div>
      <div {...barHandlers}>
        <BarList
          id="family-bars"
          scope={`families|${mode}`}
          topic="families"
          items={familyItems(threads, mode)}
          format={pct}
          empty="No threads reported yet."
          stamp={stamp}
          onClick={
            mode === "thread"
              ? null
              : (item) => {
                  if (!item.key) return;
                  dispatch({ type: "familyBar", mode, key: item.key });
                  onShowTable();
                }
          }
        />
      </div>
    </div>
  );
}

function Cores({
  threads,
  stamp,
}: {
  threads: readonly Thread[];
  stamp: number;
}) {
  const { readout, show, clear } = useReadout();
  const { holding, handlers } = useHolding();
  const held = useHeld({ threads, stamp }, holding);
  const { columns, scale } = coreColumns(held.threads);
  return (
    <div className="card" {...handlers}>
      <Fold
        name="cores"
        summary={
          <Help topic="cores">
            <h3>Core placement</h3>
          </Help>
        }
      >
        <p className="fold-note">
          CPU of this process&apos;s threads, by the core each thread last ran
          on. Uneven bars can mean pinning or affinity.
        </p>
        <Help topic="cores" as="div" readout={readout ?? undefined}>
          <div id="cores" className="cores" onMouseLeave={clear}>
            {!threads.length && (
              <p className="muted">No threads reported yet.</p>
            )}
            {threads.length > 0 &&
              columns.map((column) => (
                <div
                  key={column.core}
                  className="core"
                  onMouseMove={(event) => {
                    show(
                      event,
                      `cores|${String(column.core)}`,
                      "Core " + String(column.core),
                      column.tip,
                      held.stamp,
                    );
                  }}
                >
                  <span className="cap">{column.cap}</span>
                  <div className="col" style={{ height: column.height }} />
                  <span>#{column.core}</span>
                </div>
              ))}
          </div>
        </Help>
        <div className="core-base" />
        {threads.length > 0 && (
          <Help topic="cores" as="div">
            <div
              id="cores-scale"
              className="muted"
              style={{ fontSize: 12, marginTop: 6 }}
            >
              {scale}
            </div>
          </Help>
        )}
      </Fold>
    </div>
  );
}

/** `section#threads-section`: what the threads do, where they wait, and the table. */
export function Threads({
  view,
  series,
  windowSecs,
  threadView,
  dispatch,
  onOpen,
}: {
  view: LiveResponse | undefined;
  series: Series;
  windowSecs: number;
  threadView: ThreadView;
  dispatch: Dispatch<ThreadAction>;
  onOpen: (thread: Thread, session: Series["session"]) => void;
}) {
  const threads = view?.threads ?? [];
  const { points, from } = windowPoints(series, windowSecs);
  const now = points.at(-1);
  const stamp = series.lastTick;
  // Live panels hold still under the pointer, so clicks and readouts land.
  const wchanHold = useHolding();
  const familyHold = useHolding();
  const tableHold = useHolding();
  const wchanData = useHeld({ threads, stamp }, wchanHold.holding);
  const familyData = useHeld({ threads, stamp }, familyHold.holding);
  // The chips and the table hold together, as `#threads-live` did.
  const tableData = useHeld({ threads, series }, tableHold.holding);
  const table = threadRows(tableData.threads, threadView, tableData.series);
  const showTable = () => {
    document
      .getElementById("thread-details")
      ?.scrollIntoView({ behavior: "smooth" });
  };
  return (
    <section id="threads-section" className="block">
      <div className="section-head">
        <div>
          <Help topic="active" as="div">
            <h2>
              Threads{" "}
              <span id="count" className="muted" style={{ fontWeight: 400 }}>
                {table.count}
              </span>
            </h2>
          </Help>
          <p>
            Thread activity and wait states. Select a row for history; press{" "}
            <kbd>/</kbd> to search.
          </p>
        </div>
      </div>
      <div className="grid g-2-1" style={{ marginTop: 14 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <Help topic="states" as="div">
                <h3>What the threads are doing</h3>
              </Help>
              <p>
                Thread count by latest state, stacked. Hover to read a moment.
              </p>
            </div>
          </div>
          <TimeChart
            id="chart-states"
            topic="states"
            points={points}
            stacked
            format={(value) => num(value, 0)}
            height={200}
            from={from}
            series={STATES.map((state) => ({
              label: String(stateLabels[state]),
              color: stateColor(state),
              get: (point: Point) => point.s[state] || 0,
            }))}
          />
          <div id="states-legend" className="legend">
            {STATES.filter(
              (state) =>
                now?.s[state] || points.some((point) => point.s[state]),
            ).map((state) => (
              <Help key={state} topic={state}>
                <i className={`sw ${state}`} />
                {stateLabels[state]}
                <b>{String(now?.s[state] || 0)}</b>
              </Help>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <Help topic="wchan" as="div">
                <h3>Where threads wait</h3>
              </Help>
              <p>
                Kernel wait channels right now. Click to filter the thread
                table.
              </p>
            </div>
          </div>
          <div {...wchanHold.handlers}>
            <BarList
              id="wchan-bars"
              topic="wchan"
              items={wchanItems(wchanData.threads)}
              format={String}
              mono
              pressed={threadView.wchan}
              empty="No waiting threads."
              stamp={wchanData.stamp}
              onClick={(item) => {
                if (item.key === null) return;
                dispatch({ type: "wchanBar", wchan: item.key });
                if (threadView.wchan !== item.key) showTable();
              }}
            />
          </div>
        </div>
      </div>

      <div className="grid g-2-1" style={{ marginTop: 14 }}>
        <ThreadMap
          threads={threads}
          series={series}
          selected={threadView.selected}
          onOpen={onOpen}
        />
        <Families
          threads={familyData.threads}
          barHandlers={familyHold.handlers}
          stamp={familyData.stamp}
          dispatch={dispatch}
          onShowTable={showTable}
        />
      </div>

      <div className="grid" style={{ marginTop: 14 }}>
        <Cores threads={threads} stamp={stamp} />
      </div>

      <ThreadTable
        view={view}
        threads={tableData.threads}
        series={tableData.series}
        table={table}
        holdHandlers={tableHold.handlers}
        threadView={threadView}
        dispatch={dispatch}
        onOpen={onOpen}
      />
    </section>
  );
}
