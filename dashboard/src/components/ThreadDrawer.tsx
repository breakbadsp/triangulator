import { ObservationContext } from "../hooks/observationContext";
import { useContext } from "react";
import { useEffect, useRef, useState } from "react";
import { ApiError, getJson } from "../api/client";
import type { HistoryResponse, HistoryRow, LiveResponse } from "../api/types";
import { useReadout } from "../hooks/useReadout";
import { Help, HelpEnabled } from "../help/Help";
import { isHelpTopicId, type HelpTopicId } from "../help/topics";
import { watchLine } from "../lib/assess/watch";
import { bytes, clock, date, num, pct, perSec } from "../lib/format";
import type { Series } from "../lib/series";
import type { SelectedThread } from "../lib/threadView";
import {
  STATES,
  family,
  idleFor,
  isIdle,
  stateColor,
  stateLabels,
} from "../lib/threads";
import { Mix, mixRows, StatePill } from "./ThreadTable";
import { TimeChart } from "./TimeChart";

const RANGES: readonly [number, string][] = [
  [900, "15 min"],
  [3600, "1 h"],
  [21600, "6 h"],
  [86400, "24 h"],
];
// A datetime-local value in the browser's time zone.
function localInput(milliseconds: number) {
  const offset = new Date(milliseconds).getTimezoneOffset() * 60000;
  return new Date(milliseconds - offset).toISOString().slice(0, 19);
}
interface HistoryRequest {
  seq: number;
  session: string;
  tid: number;
  from: string;
  to: string;
  cutoff: number | null;
}
interface HistoryPoint {
  t: number;
  cpu: number | null;
  rd: number | null;
  rb: number | null;
  wb: number | null;
  s: Record<string, number>;
}
type HistoryResult =
  | {
      seq: number;
      rows: readonly HistoryRow[];
      points: readonly HistoryPoint[];
      note: string;
    }
  | { seq: number; error: string };

function historyPoints(rows: readonly HistoryRow[]): HistoryPoint[] {
  return rows.map((item) => {
    const counts = item.sample_counts,
      total = Object.values(counts).reduce((sum, value) => sum + value, 0) || 1,
      shares: Record<string, number> = {};
    for (const [state, count] of Object.entries(counts))
      shares[state] = (100 * count) / total;
    return {
      t: item.ts,
      cpu: item.cpu_pct,
      rd: item.run_delay_pct,
      rb: item.read_bps,
      wb: item.write_bps,
      s: shares,
    };
  });
}

function History({
  selected,
  now,
}: {
  selected: SelectedThread | null;
  now: number;
}) {
  // The range survives closing the drawer: 0 is a custom interval.
  const [range, setRange] = useState(3600);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [request, setRequest] = useState<HistoryRequest | null>(null);
  const [result, setResult] = useState<HistoryResult | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const observation = useContext(ObservationContext);
  const key = selected
    ? `${observation.key}|${String(selected.session)}:${String(selected.tid)}:${String(selected.generation)}`
    : null;
  function load(fromValue: string, toValue: string) {
    if (!selected) return;
    setRequest({
      seq: (request?.seq ?? 0) + 1,
      session: String(selected.session),
      tid: selected.tid,
      from: fromValue,
      to: toValue,
      cutoff: observation.recorded ? now : null,
    });
  }
  function applyRange(seconds: number) {
    setRange(seconds);
    if (seconds <= 0) {
      load(from, to);
      return;
    }
    const end = now * 1000,
      fromValue = localInput(end - seconds * 1000),
      toValue = localInput(end);
    setFrom(fromValue);
    setTo(toValue);
    load(fromValue, toValue);
  }
  // Each opened thread loads once, with the range the reader chose last.
  if (key !== opened) {
    setOpened(key);
    if (key) applyRange(range);
    else {
      setRequest(null);
      setResult(null);
    }
  }
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    const start = new Date(request.from).getTime() / 1000,
      end = Math.min(
        new Date(request.to).getTime() / 1000,
        request.cutoff ?? Infinity,
      );
    const query = new URLSearchParams({
      session: request.session,
      tid: String(request.tid),
      start: String(start),
      end: String(end),
    });
    getJson<HistoryResponse>(`/api/history?${String(query)}`, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const rows = data.rows.filter((row) => row.ts <= end);
        setResult({
          seq: request.seq,
          rows,
          points: historyPoints(rows),
          note: data.truncated
            ? "First 2,000 summaries shown; narrow the range."
            : `${String(rows.length)} summaries from ${request.from.replace("T", " ")} to ${localInput(end * 1000).replace("T", " ")}.`,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setResult({
          seq: request.seq,
          error:
            error instanceof ApiError || !(error instanceof Error)
              ? "Unable to load history: check the time range."
              : error.message,
        });
      });
    return () => {
      controller.abort();
    };
  }, [request]);
  const current =
    result && request && result.seq === request.seq ? result : null;
  const data = current && "rows" in current ? current : null;
  const empty = "No stored summaries in this range yet.";
  const seen = new Set(data?.points.flatMap((point) => Object.keys(point.s)));
  const selection = `${String(request?.seq)}|${String(range)}|${from}|${to}`;
  const { readout, show, clear } = useReadout(selection);
  function historyCell(
    event: React.MouseEvent,
    item: HistoryRow,
    column: string,
    topic: HelpTopicId,
    value: string,
  ) {
    show(
      event,
      `${topic}|${column}|${String(item.ts)}`,
      date(item.ts),
      column === "mix"
        ? mixRows(item.sample_counts)
        : [
            {
              color: "",
              value: value === "—" ? "Not available" : value,
              label: column,
            },
          ],
      item.ts,
      topic,
    );
  }
  return (
    <ObservationContext
      value={{ ...observation, key: `${observation.key}|history|${selection}` }}
    >
      <div className="card" id="history">
        <div className="card-head">
          <div>
            <Help topic="history" as="div">
              <h3>History</h3>
            </Help>
            <p>5-second summaries stored by the collector.</p>
          </div>
        </div>
        <div className="range">
          <Help topic="history" as="div">
            <div className="seg" role="group" aria-label="History range">
              {RANGES.map(([seconds, label]) => (
                <button
                  key={seconds}
                  type="button"
                  data-range={seconds}
                  aria-pressed={range === seconds}
                  onClick={() => {
                    applyRange(seconds);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </Help>
          <Help topic="history">
            <input
              id="from"
              type="datetime-local"
              step="1"
              aria-label="From"
              value={from}
              onChange={(event) => {
                setFrom(event.target.value);
              }}
            />
          </Help>
          <Help topic="history">
            <input
              id="to"
              type="datetime-local"
              step="1"
              aria-label="To"
              value={to}
              onChange={(event) => {
                setTo(event.target.value);
              }}
            />
          </Help>
          <Help topic="history">
            <button
              id="load-history"
              type="button"
              onClick={() => {
                setRange(0);
                load(from, to);
              }}
            >
              Load
            </button>
          </Help>
        </div>
        <p id="history-note" className="muted" style={{ fontSize: 12 }}>
          {!request
            ? ""
            : !current
              ? "Loading…"
              : "error" in current
                ? current.error
                : current.note}
        </p>
        {data && (
          <>
            <HistoryHeading topic="cpu">CPU</HistoryHeading>
            <TimeChart
              id="history-cpu"
              topic="cpu"
              points={data.points}
              series={[
                {
                  label: "CPU",
                  color: "var(--series-1)",
                  get: (point: HistoryPoint) => point.cpu,
                },
              ]}
              format={pct}
              height={130}
              minMax={5}
              empty={empty}
            />
            <HistoryHeading topic="delay">Run delay</HistoryHeading>
            <TimeChart
              id="history-delay"
              topic="delay"
              points={data.points}
              series={[
                {
                  label: "Run delay",
                  color: "var(--series-2)",
                  get: (point: HistoryPoint) => point.rd,
                },
              ]}
              format={pct}
              height={100}
              minMax={1}
              empty={empty}
            />
            <HistoryHeading topic="mix">State mix</HistoryHeading>
            <TimeChart
              id="history-states"
              topic="mix"
              points={data.points}
              stacked
              format={(value) =>
                (typeof value === "number" ? value.toFixed(0) : "") + "%"
              }
              height={120}
              empty={empty}
              series={STATES.map((state) => ({
                label: String(stateLabels[state]),
                color: stateColor(state),
                get: (point: HistoryPoint) => point.s[state] || 0,
              }))}
            />
            <div id="legend" className="legend">
              {STATES.filter((state) => seen.has(state)).map((state) => (
                <Help key={state} topic={state}>
                  <i className={`sw ${state}`} />
                  {stateLabels[state]}
                </Help>
              ))}
            </div>
            <HistoryHeading topic="sysio">I/O</HistoryHeading>
            <TimeChart
              id="history-io"
              topic="sysio"
              points={data.points}
              series={[
                {
                  label: "Read/s",
                  color: "var(--series-1)",
                  get: (point: HistoryPoint) => point.rb,
                },
                {
                  label: "Write/s",
                  color: "var(--series-2)",
                  get: (point: HistoryPoint) => point.wb,
                },
              ]}
              format={perSec}
              height={110}
              minMax={1}
              empty={empty}
            />
            <div className="legend">
              <Help topic="sysio">
                <i
                  className="sw line"
                  style={{ background: "var(--series-1)" }}
                />
                Read/s
              </Help>
              <Help topic="sysio">
                <i
                  className="sw line"
                  style={{ background: "var(--series-2)" }}
                />
                Write/s
              </Help>
            </div>
          </>
        )}
        {/* Uncontrolled, so the reader's open choice survives each load. */}
        <details style={{ marginTop: 12 }}>
          <summary>
            <Help topic="history">Table view</Help>
          </summary>
          <div className="table-wrap" style={{ maxHeight: 340, marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  {(
                    [
                      ["Time", "history", ""],
                      ["CPU", "cpu", "num"],
                      ["Run delay", "delay", "num"],
                      ["Read/s", "sysio", "num"],
                      ["Write/s", "sysio", "num"],
                      ["Samples", "samples", ""],
                      ["State mix", "mix", ""],
                    ] as const
                  ).map(([label, topic, className]) => (
                    <th key={label} className={className || undefined}>
                      <Help topic={topic}>{label}</Help>
                    </th>
                  ))}
                </tr>
              </thead>
              <Help
                as="tbody"
                id="history-rows"
                topic={readout?.topic ?? "history"}
                readout={readout ?? undefined}
              >
                {(data?.rows ?? []).map((item) => (
                  <tr key={item.ts} onMouseLeave={clear}>
                    {(
                      [
                        ["Time", "history", date(item.ts)],
                        ["CPU", "cpu", pct(item.cpu_pct)],
                        ["Run delay", "delay", pct(item.run_delay_pct)],
                        ["Read/s", "sysio", bytes(item.read_bps)],
                        ["Write/s", "sysio", bytes(item.write_bps)],
                        [
                          "Samples",
                          "samples",
                          `${String(item.samples)}/${item.expected_samples.toFixed(1)}${item.valid ? "" : " · insufficient"}`,
                        ],
                      ] as const
                    ).map(([column, topic, value], index) => (
                      <td
                        key={column}
                        className={index > 0 && index < 5 ? "num" : undefined}
                        onMouseMove={(event) => {
                          historyCell(event, item, column, topic, value);
                        }}
                      >
                        {value}
                      </td>
                    ))}
                    <td
                      onMouseMove={(event) => {
                        historyCell(event, item, "mix", "mix", "");
                      }}
                    >
                      <Mix counts={item.sample_counts} />
                    </td>
                  </tr>
                ))}
              </Help>
            </table>
          </div>
        </details>
      </div>
    </ObservationContext>
  );
}
function HistoryHeading({
  topic,
  children,
}: {
  topic: HelpTopicId;
  children: string;
}) {
  return (
    <Help topic={topic} as="div">
      <h3 style={{ marginTop: children === "CPU" ? 6 : 12 }}>{children}</h3>
    </Help>
  );
}

const TILES: readonly [
  string,
  HelpTopicId,
  (
    | "cpu_pct"
    | "run_delay_pct"
    | "switches_per_s"
    | "read_bps"
    | "write_bps"
    | "major_faults_per_s"
  ),
  (value: unknown) => string,
][] = [
  ["CPU", "cpu", "cpu_pct", pct],
  ["Run delay", "delay", "run_delay_pct", pct],
  ["Switches/s", "switches", "switches_per_s", num],
  ["Read/s", "sysio", "read_bps", bytes],
  ["Write/s", "sysio", "write_bps", bytes],
  ["Maj. faults/s", "faults", "major_faults_per_s", num],
];

/** `aside#drawer`: one thread's live state, recent CPU, and stored history. */
export function ThreadDrawer({
  view,
  recorded = false,
  context,
  series,
  selected,
  now,
  onClose,
}: {
  view: LiveResponse | undefined;
  recorded?: boolean;
  context?: string | null;
  series: Series;
  selected: SelectedThread | null;
  now: number;
  onClose: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  const open = !!selected;
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
    };
  }, [open, selected?.tid, onClose]);
  // The same thread: same session, TID, and generation.
  const thread =
    selected && view && view.health.session === selected.session
      ? view.threads.find(
          (item) =>
            item.tid === selected.tid &&
            item.generation === selected.generation,
        )
      : undefined;
  const watch = thread && view ? watchLine(thread, view.health) : null;
  const tiles: [string, HelpTopicId, string][] = thread
    ? [
        ...TILES.filter(([, , field]) => (thread[field] ?? 0) > 0).map(
          ([label, topic, field, format]): [string, HelpTopicId, string] => [
            label,
            topic,
            format(thread[field]),
          ],
        ),
        ...(isIdle(thread)
          ? [
              [
                "Activity",
                "active",
                (recorded ? null : idleFor(thread, series)) || "idle",
              ] as [string, HelpTopicId, string],
            ]
          : []),
        ["Last core", "cores", "#" + String(thread.cpu)],
        ["Last sample", "health", clock(thread.last_sample ?? 0)],
      ]
    : [];
  const points =
    selected &&
    selected.session === series.session &&
    series.seen.get(selected.tid)?.generation === selected.generation
      ? (series.cpu.get(selected.tid) ?? [])
      : [];
  return (
    <ObservationContext
      value={{
        key: `${context ?? ""}|thread|${String(selected?.session)}|${String(selected?.tid)}|${String(selected?.generation)}`,
        recorded,
      }}
    >
      <HelpEnabled value={open}>
        <div
          id="scrim"
          className={"scrim" + (open ? " open" : "")}
          onClick={onClose}
        />
        <aside
          id="drawer"
          className={"drawer" + (open ? " open" : "")}
          aria-label="Thread details"
          aria-hidden={!open}
          inert={!open}
        >
          <div className="drawer-head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <Help topic="thread" as="div">
                <h2 id="history-title">{selected?.name ?? "Thread"}</h2>
              </Help>
              <div id="drawer-meta" className="muted">
                {selected &&
                  `TID ${String(selected.tid)}` +
                    (thread
                      ? ` · group ${String(thread.group)} · family ${family(thread.name)}`
                      : "")}
              </div>
            </div>
            <Help topic="thread">
              <button
                ref={close}
                id="drawer-close"
                type="button"
                className="icon-btn"
                aria-label="Close thread details"
                onClick={onClose}
              >
                ✕
              </button>
            </Help>
          </div>
          <div className="drawer-body">
            <div id="drawer-state">
              {selected && !thread && (
                <p className="muted">
                  This thread is no longer reported; it may have exited. Its
                  stored history is still available below.
                </p>
              )}
              {thread && (
                <>
                  <Help
                    topic={
                      thread.state && isHelpTopicId(thread.state)
                        ? thread.state
                        : "states"
                    }
                    as="div"
                  >
                    <StatePill thread={thread} />
                    {thread.wchan && (
                      <>
                        <span className="muted"> in </span>
                        <code>{thread.wchan}</code>
                      </>
                    )}
                    <span className="muted"> · last 10 s: </span>
                    <Mix counts={thread.state_mix} inline />
                  </Help>
                  {watch && (
                    <Help topic="watched" as="div" className="muted">
                      {watch}
                    </Help>
                  )}
                </>
              )}
            </div>
            <div id="drawer-tiles" className="mini-tiles">
              {tiles.map(([label, topic, value]) => (
                <div key={label}>
                  <Help topic={topic} as="div" className="k">
                    {label}
                  </Help>
                  <div className="v">{value}</div>
                </div>
              ))}
            </div>
            <div className="card" hidden={recorded}>
              <div className="card-head">
                <div>
                  <Help topic="cpu" as="div">
                    <h3>Recent live CPU</h3>
                  </Help>
                  <p>Last two minutes from the live feed.</p>
                </div>
              </div>
              <TimeChart
                id="drawer-live"
                topic="cpu"
                points={points}
                series={[
                  {
                    label: "CPU",
                    color: "var(--series-1)",
                    get: (point: { t: number; v: number | null }) => point.v,
                  },
                ]}
                format={pct}
                height={120}
                minMax={5}
              />
            </div>
            <History selected={selected} now={now} />
          </div>
        </aside>
      </HelpEnabled>
    </ObservationContext>
  );
}
