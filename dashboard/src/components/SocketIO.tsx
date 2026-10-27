import { useContext } from "react";
import { ViewIdentityContext } from "../hooks/viewIdentityContext";
import type { ViewMode } from "../lib/assess";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";
import { ApiError, getJson } from "../api/client";
import type {
  AvailableSocketReport,
  LiveResponse,
  SocketMetric,
  SocketReport,
} from "../api/types";
import { Help } from "../help/Help";
import type { HelpTopicId } from "../help/topics";
import { useHeld, useHolding } from "../hooks/useHeld";
import { useReadout } from "../hooks/useReadout";
import { useScopedPoll } from "../hooks/useScopedPoll";
import { num } from "../lib/format";
import {
  SOCKET_TITLES,
  observerIdentity,
  socketChart,
  socketCoverage,
  socketKinds,
  socketRowIdentity,
  socketRows,
  socketStatus,
  socketValue,
} from "../lib/socketView";
import { TimeChart } from "./TimeChart";
import "./socket.css";

const NO_COLLECTOR: SocketReport = {
  available: false,
  reason:
    "This collector does not support socket observations. Use the C++ collector.",
};
const METRICS = [
  ["input", "↓ Received", "received"],
  ["output", "↑ Sent", "sent"],
  ["messages", "✓ Messages processed", "messages"],
] as const satisfies readonly [SocketMetric, string, HelpTopicId][];
const METRIC_TOPICS = {
  input: "received",
  output: "sent",
  messages: "messages",
} as const satisfies Record<SocketMetric, HelpTopicId>;
const METRIC_NOTES = {
  input:
    "Bytes reported by successful receive operations. Peeks do not count. A read is not a processed message.",
  output:
    "Bytes accepted by successful send operations, including partial writes. Acceptance does not prove peer delivery.",
  messages:
    "One marker call = one completed application message. Counts reflect the marker contract defined by your application.",
} as const;
type Show = ReturnType<typeof useReadout>["show"];
/** Clears a readout when the shown selection changes. */
function useClearOn(selection: string, clear: () => void) {
  const [seen, setSeen] = useState(selection);
  if (seen !== selection) {
    setSeen(selection);
    clear();
  }
}

/**
 * The optional socket observer's report for the live process. Requests are
 * scoped to the target, session and PID; the report body is keyed by them
 * and by the observer, so nothing of an earlier process or observer shows.
 */
export function SocketIO({
  view,
  context,
  mode = { kind: "live" },
  heldReport,
  heldError,
  external = false,
}: {
  view: LiveResponse | undefined;
  mode?: ViewMode;
  heldReport?: SocketReport;
  heldError?: Error;
  external?: boolean;
  /** The target, session and PID of the live view; null before it. */
  context: string | null;
}) {
  const viewIdentity = useContext(ViewIdentityContext);
  const pid = view?.health.pid ?? 0;
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        return await getJson<SocketReport>(
          `/api/socket-io?pid=${String(pid)}`,
          signal,
        );
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 404)
          return NO_COLLECTOR;
        throw cause;
      }
    },
    [pid],
  );
  const result = useScopedPoll(
    mode.kind === "live" && !external ? context : null,
    load,
    3000,
  );
  // The collector answers for the PID it was asked about; check anyway.
  const report: SocketReport | undefined =
    heldReport ??
    (mode.kind === "final"
      ? {
          available: false,
          reason: "No socket report was retained for this final view.",
        }
      : undefined) ??
    (result?.data && (!result.data.available || result.data.pid === pid)
      ? result.data
      : undefined);
  const [metric, setMetric] = useState<SocketMetric>("input");
  const [kind, setKind] = useState("");
  const [search, setSearch] = useState("");
  const kinds = report?.available ? socketKinds(report) : [];
  // A fresh report without the chosen kind clears it; one that still has it
  // keeps it for a return from Messages to bytes.
  if (report?.available && kind && !kinds.some(([id]) => id === kind))
    setKind("");
  const unconfigured =
    metric === "messages" && report?.available && !report.messages_enabled;
  let status = "Checking observer…",
    scope =
      "Measure traffic handled by each thread, and application messages completed.";
  const error = external ? heldError : result?.error;
  if (error) {
    status = "Report unavailable · stale";
    scope =
      "Unable to refresh socket observations. Previously displayed values may be stale.";
  } else if (report && !report.available) {
    status = "Not available";
    scope =
      "Socket traffic and message completion require the optional observer. Expand setup below to connect it.";
  } else if (report?.available) {
    status = socketStatus(report);
    scope = `PID ${String(report.pid)} · observed for ${num(report.duration)} seconds · totals since this observer started · observer ${report.observer}`;
  }
  return (
    <ViewIdentityContext
      value={{
        ...viewIdentity,
        key: JSON.stringify([
          viewIdentity.key,
          report?.available ? observerIdentity(report) : null,
        ]),
      }}
    >
      <section
        id="socket-panel"
        hidden={mode.kind === "recorded"}
        className="block card"
        aria-labelledby="socket-title"
      >
        <div className="socket-heading">
          <Help topic="socketio" as="div">
            <h2 id="socket-title">Socket I/O &amp; message processing</h2>
          </Help>
          <Help topic="socketio">
            <span
              id="socket-status"
              className={
                "socket-badge" +
                (report?.available && (report.stale || report.lower_bound)
                  ? " socket-warning"
                  : "")
              }
              role="status"
            >
              {status}
            </span>
          </Help>
        </div>
        <Help topic="socketio" as="div">
          <p id="socket-scope" className="socket-note">
            {scope}
          </p>
        </Help>
        {report && !report.available && (
          <Help topic="coverage" as="div">
            <div id="socket-empty" className="socket-empty">
              {report.reason || "Socket observer not connected"}
            </div>
          </Help>
        )}
        {report?.available && (
          <div id="socket-content">
            <div
              className="socket-controls"
              role="group"
              aria-label="Socket metric"
            >
              <div className="seg">
                {METRICS.map(([value, label, topic]) => (
                  <Help key={value} topic={topic}>
                    <button
                      type="button"
                      data-socket-metric={value}
                      aria-pressed={metric === value}
                      onClick={() => {
                        setMetric(value);
                      }}
                    >
                      {label}
                    </button>
                  </Help>
                ))}
              </div>
              <Help topic="endpoint">
                <label>
                  Socket kind{" "}
                  <select
                    id="socket-kind"
                    value={kind}
                    disabled={metric === "messages"}
                    onChange={(event) => {
                      setKind(event.target.value);
                    }}
                  >
                    <option value="">All kinds</option>
                    {kinds.map(([id, label]) => (
                      <option key={id} value={id}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </Help>
              <Help topic="thread">
                <label>
                  Thread{" "}
                  <input
                    id="socket-search"
                    placeholder="Name or TID"
                    aria-label="Find socket thread"
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                    }}
                  />
                </label>
              </Help>
            </div>
            <Help topic={METRIC_TOPICS[metric]} as="div">
              <p id="socket-metric-note" className="socket-note">
                {unconfigured
                  ? "Message completion is not configured. Add a completion marker to count messages after the application finishes processing them."
                  : METRIC_NOTES[metric]}
              </p>
            </Help>
            <SocketReportBody
              key={`${String(context)}|${observerIdentity(report)}`}
              report={report}
              metric={metric}
              kind={kind}
              search={search}
            />
          </div>
        )}
        <details>
          <summary>
            <Help topic="socketio">What is measured · setup</Help>
          </summary>
          <Help topic="socketio" as="div">
            <p>
              Received and sent bytes are the successful byte counts reported by
              observed kernel socket operations. Sent means accepted by the
              socket, not delivered to the peer. Peeks, failed operations and
              UDP are excluded. A receive operation can contain part of one
              message or many messages.
            </p>
            <p>
              Messages processed counts calls to an explicit application
              completion marker, one call per successfully processed message. It
              is never inferred from read calls or bytes.
            </p>
            <p>
              Start the optional source on the target host:{" "}
              <code>
                build/triangulator-socket-sampler PID COLLECTOR-IP:PORT
                build/socket.bpf.o
              </code>
              . Add <code>MARKER-BINARY MARKER-SYMBOL</code> for completion
              counts. The source needs kernel BTF, socket length tracepoints and
              BPF tracing privileges. The normal sampler continues without extra
              privileges. See <code>docs/socket-ingress-design.md</code> for
              coverage and setup.
            </p>
          </Help>
        </details>
      </section>
    </ViewIdentityContext>
  );
}

/** Cards and chart for the whole process, then the filtered breakdown. */
function SocketReportBody({
  report,
  metric,
  kind,
  search,
}: {
  report: AvailableSocketReport;
  metric: SocketMetric;
  kind: string;
  search: string;
}) {
  return (
    <>
      <Totals report={report} metric={metric} />
      <Breakdown report={report} metric={metric} kind={kind} search={search} />
    </>
  );
}

function Totals({
  report,
  metric,
}: {
  report: AvailableSocketReport;
  metric: SocketMetric;
}) {
  const { holding, handlers } = useHolding();
  const data = useHeld(report, holding);
  const { readout, show, clear } = useReadout();
  useClearOn(metric, clear);
  const totals = data.totals[metric];
  const chart = socketChart(data, metric);
  const cards = [
    [SOCKET_TITLES[metric], totals.total, false, METRIC_TOPICS[metric]],
    ["Current rate", totals.current, true, "rates"],
    ["Average since start", totals.average, true, "rates"],
    ["Recent minimum", totals.minimum, true, "rates"],
    ["Recent maximum", totals.maximum, true, "rates"],
  ] as const;
  return (
    <div {...handlers}>
      <Help
        as="div"
        id="socket-cards"
        className="tiles socket-cards"
        topic={readout?.topic ?? METRIC_TOPICS[metric]}
        readout={readout ?? undefined}
      >
        {cards.map(([title, value, rate, topic]) => (
          <div
            key={title}
            className="card tile"
            onMouseLeave={clear}
            onMouseMove={(event) => {
              readValue(show, event, {
                key: `${metric}|${title}`,
                title,
                value,
                rate,
                stamp: data.updated,
                topic,
              });
            }}
          >
            <div className="label">{title}</div>
            <div className="value">{socketValue(value, metric, rate)}</div>
          </div>
        ))}
      </Help>
      <TimeChart
        key={metric}
        id="socket-chart"
        topic="rates"
        points={chart.points}
        series={[
          {
            label: SOCKET_TITLES[metric] + " /s",
            color: "var(--series-1)",
            get: (point: { v: number | null }) => point.v,
          },
        ]}
        format={(value) =>
          socketValue(typeof value === "number" ? value : null, metric, true)
        }
        height={150}
        empty="No covered rate windows yet"
      />
      <Help topic="rates" as="div" className="socket-chart-caption">
        <span>Recent process rate · gaps mean unknown</span>
        <span id="socket-chart-scale">{chart.peak}</span>
      </Help>
    </div>
  );
}

const ROW_COLUMNS = [
  ["Total", "sockettotal", "total", false],
  ["Now /s", "rates", "current", true],
  ["Average /s", "rates", "average", true],
  ["Recent min /s", "rates", "minimum", true],
  ["Recent max /s", "rates", "maximum", true],
] as const;
function Breakdown({
  report,
  metric,
  kind,
  search,
}: {
  report: AvailableSocketReport;
  metric: SocketMetric;
  kind: string;
  search: string;
}) {
  const { holding, handlers } = useHolding();
  const data = useHeld(report, holding);
  const { readout, show, clear } = useReadout();
  const selection = `${metric}|${kind}|${search}`;
  useClearOn(selection, clear);
  const wrap = useRef<HTMLDivElement>(null);
  // A filter or metric change starts the breakdown at its top.
  useLayoutEffect(() => {
    if (wrap.current) wrap.current.scrollTop = 0;
  }, [selection]);
  const rows = socketRows(data, metric, kind, search);
  const unconfigured = metric === "messages" && !data.messages_enabled;
  return (
    <div {...handlers}>
      <Help topic="socketio" as="div">
        <h3 style={{ marginTop: 20 }}>
          By thread and socket kind{" "}
          <span id="socket-row-count" className="muted">
            ({rows.length})
          </span>
        </h3>
      </Help>
      <Help topic="socketio" as="div">
        <p className="socket-note">
          Includes retired threads. Filters apply to this breakdown; cards and
          chart show the whole process.
        </p>
      </Help>
      <div ref={wrap} className="table-wrap" style={{ maxHeight: 380 }}>
        <table>
          <thead>
            <tr>
              <th>
                <Help topic="thread">Thread / TID</Help>
              </th>
              <th>
                <Help topic="endpoint">Socket kind</Help>
              </th>
              {ROW_COLUMNS.map(([label, topic]) => (
                <th key={label} className="num">
                  <Help topic={topic}>{label}</Help>
                </th>
              ))}
            </tr>
          </thead>
          <Help
            as="tbody"
            id="socket-rows"
            topic={readout?.topic ?? "socketio"}
            readout={readout ?? undefined}
          >
            {rows.map((row) => {
              const id = socketRowIdentity(data, row);
              const values = row.metrics[metric];
              const title = `${row.name || "Thread"} · TID ${String(row.tid)}`;
              return (
                <tr key={id} data-row={id} onMouseLeave={clear}>
                  <td
                    onMouseMove={(event) => {
                      show(
                        event,
                        `${id}|thread|${metric}`,
                        title,
                        [
                          {
                            color: "",
                            value: row.thread_start,
                            label: "Thread generation",
                          },
                        ],
                        data.updated,
                        "thread",
                      );
                    }}
                  >
                    <span>{row.name || "Thread"}</span>
                    <small>TID {row.tid}</small>
                  </td>
                  <td
                    onMouseMove={(event) => {
                      show(
                        event,
                        `${id}|kind|${metric}`,
                        title,
                        [{ color: "", value: row.kind, label: "Socket kind" }],
                        data.updated,
                        "endpoint",
                      );
                    }}
                  >
                    {row.kind}
                  </td>
                  {ROW_COLUMNS.map(([label, topic, key, rate]) => (
                    <td
                      key={label}
                      className="num"
                      onMouseMove={(event) => {
                        readValue(show, event, {
                          key: `${id}|${label}|${metric}`,
                          title,
                          value: values[key],
                          rate,
                          stamp: data.updated,
                          topic,
                          label,
                        });
                      }}
                    >
                      {socketValue(values[key], metric, rate)}
                    </td>
                  ))}
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={7}>
                  {unconfigured
                    ? "Completion marker not configured."
                    : search || kind
                      ? "No matching threads."
                      : "No observed activity yet."}
                </td>
              </tr>
            )}
          </Help>
        </table>
      </div>
      <Help topic="coverage" as="div">
        <p id="socket-coverage" className="socket-note">
          {socketCoverage(data)}
        </p>
      </Help>
    </div>
  );
}

/** A readout with the exact value, as the old page's hint showed it. */
function readValue(
  show: Show,
  event: MouseEvent,
  cell: {
    key: string;
    title: string;
    value: string | number | null;
    rate: boolean;
    stamp: number;
    topic: HelpTopicId;
    label?: string;
  },
) {
  show(
    event,
    cell.key,
    cell.title,
    [
      {
        color: "",
        value:
          cell.value === null
            ? "—"
            : String(cell.value) + (cell.rate ? " per second" : ""),
        label: cell.label ?? cell.title,
      },
    ],
    cell.stamp,
    cell.topic,
  );
}
