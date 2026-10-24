import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import type {
  LiveResponse,
  PressureScope,
  Resources as ResourceSample,
} from "../api/types";
import { Help } from "../help/Help";
import type { HelpTopicId } from "../help/topics";
import { useHeld, useHolding } from "../hooks/useHeld";
import { useReadout } from "../hooks/useReadout";
import type { ResourcePoint } from "../lib/assess/memory";
import { assessResources, hasCgroup, stall } from "../lib/assess/resources";
import { wantsFold } from "../lib/findings";
import { ago, bytes, isNum, num, pct } from "../lib/format";
import {
  PRESSURE_SERIES,
  fillLevel,
  fullestSockets,
  networkRows,
  resourceCoverage,
  resourceTiles,
  scopeOf,
  socketCells,
} from "../lib/resourceView";
import { Fold } from "./Fold";
import { Sparkline } from "./Sparkline";
import { TimeChart } from "./TimeChart";
import "./resources.css";

export const RESOURCE_RANGES = [
  [900, "15 min"],
  [3600, "1 h"],
  [21600, "6 h"],
  [86400, "24 h"],
] as const;
export type ResourceRange = (typeof RESOURCE_RANGES)[number][0];

/** The latest sample with the stored history drawn beside it. */
interface Observation {
  r: ResourceSample;
  points: readonly ResourcePoint[];
  now: number;
}
type Show = ReturnType<typeof useReadout>["show"];
const TILE_TOPICS: Readonly<Record<string, HelpTopicId>> = {
  "I/O pressure": "pressure",
  "Memory pressure": "pressure",
  "CPU pressure": "pressure",
  "Memory (RSS)": "rss",
  "Open files": "fds",
  "Disk I/O": "disk",
  "Queued in sockets": "queues",
  "Network drops": "netdrops",
  "TCP retransmits": "retrans",
  "CLOSE-WAIT": "closewait",
};
const EMPTY_HISTORY = "Collecting stored resource samples…";

/**
 * The Pressure, limits & sockets section. Each card holds its own
 * observation while it is inspected, and the cards are keyed by the live
 * session and PID, so a new process discards what an old one showed.
 */
export function Resources({
  view,
  now,
  points,
  range,
  onRange,
  scope,
  onScope,
}: {
  view: LiveResponse | undefined;
  now: number;
  /** Stored samples of the selected range for this target and session. */
  points: readonly ResourcePoint[];
  range: ResourceRange;
  onRange: (range: ResourceRange) => void;
  scope: PressureScope;
  onScope: (scope: PressureScope) => void;
}) {
  const [busyOnly, setBusyOnly] = useState(true);
  const r = view?.resources;
  // A sample of an earlier process can arrive before the first sample of
  // the current one. It never shows under the current identity.
  const current =
    r?.available &&
    r.session === view?.health.session &&
    r.pid === view?.health.pid
      ? r
      : null;
  const observation = current && { r: current, points, now };
  return (
    <section id="resources" className="block">
      <div className="section-head">
        <div>
          <Help topic="pressure" as="div">
            <h2>Pressure, limits &amp; sockets</h2>
          </Help>
          <p id="resources-sub">
            Resource stalls, remaining capacity, and socket queues.
            {current &&
              (current.stale
                ? ` Stale: no sample since ${ago(now - (current.updated ?? 0))}.`
                : ` Updated ${ago(now - (current.updated ?? 0))}.`)}
          </p>
        </div>
        <Help topic="pressure" as="div">
          <div className="seg" role="group" aria-label="Resource history range">
            {RESOURCE_RANGES.map(([seconds, label]) => (
              <button
                key={seconds}
                type="button"
                data-res-range={seconds}
                aria-pressed={range === seconds}
                onClick={() => {
                  onRange(seconds);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </Help>
      </div>
      {!observation ? (
        <Help topic="coverage" as="div">
          <p id="resources-empty" className="socket-empty">
            {r?.available
              ? "Waiting for a resource sample of the current process."
              : r?.reason || "This collector does not report resource samples."}
          </p>
        </Help>
      ) : (
        <div
          id="resources-content"
          key={`${String(view?.health.session)}|${String(view?.health.pid)}`}
        >
          <Tiles observation={observation} scope={scope} />
          <div className="grid g-2-1" style={{ marginTop: 14 }}>
            <div className="card">
              <div className="card-head">
                <div>
                  <Help topic="pressure" as="div">
                    <h3>Pressure stalls (PSI)</h3>
                  </Help>
                  <p>
                    Time lost waiting for CPU, memory, or I/O. Peaks per
                    interval.
                  </p>
                </div>
                <Help topic="pressure">
                  <select
                    id="pressure-scope"
                    aria-label="Pressure scope"
                    value={scopeOf(observation.r, scope)}
                    onChange={(event) => {
                      onScope(
                        event.target.value === "host" ? "host" : "cgroup",
                      );
                    }}
                  >
                    <option value="cgroup" disabled={!hasCgroup(observation.r)}>
                      Target&apos;s cgroup
                    </option>
                    <option value="host">Whole host</option>
                  </select>
                </Help>
              </div>
              <Pressure observation={observation} scope={scope} range={range} />
            </div>
            <div className="card">
              <div className="card-head">
                <div>
                  <Help topic="limits" as="div">
                    <h3>Limits &amp; headroom</h3>
                  </Help>
                  <p>
                    How close the process and the kernel are to limits that make
                    calls fail (EMFILE) or shrink buffers.
                  </p>
                </div>
              </div>
              <Limits observation={observation} />
            </div>
          </div>
          <div className="grid g-2-1" style={{ marginTop: 14 }}>
            <div className="card">
              <div className="card-head">
                <div>
                  <Help topic="queues" as="div">
                    <h3>Bytes waiting in the target&apos;s sockets</h3>
                  </Help>
                  <p>
                    Receive: waiting for the app. Send: waiting for the peer or
                    network.
                  </p>
                </div>
              </div>
              <Queues observation={observation} range={range} />
            </div>
            <div className="card" style={{ alignSelf: "start" }}>
              <Fold
                name="netstack"
                autoOpen={wantsFold(
                  assessResources(observation.r, now),
                  "resources",
                )}
                summary={
                  <Help topic="netdrops">
                    <h3>Network stack drops &amp; errors</h3>
                  </Help>
                }
              >
                {/* The In range column changes with the range, so its
                    readouts and hold start again. */}
                <Network key={range} observation={observation} />
              </Fold>
            </div>
          </div>
          <FullestSockets
            observation={observation}
            busyOnly={busyOnly}
            onBusyOnly={setBusyOnly}
          />
        </div>
      )}
    </section>
  );
}

function Tiles({
  observation,
  scope,
}: {
  observation: Observation;
  scope: PressureScope;
}) {
  const { holding, handlers } = useHolding();
  const { r, points } = useHeld(observation, holding);
  return (
    <div id="resource-tiles" className="tiles resource-tiles" {...handlers}>
      {resourceTiles(r, points, scope).map(([label, value, sub, values]) => (
        <div key={label} className="card tile">
          <Help
            topic={TILE_TOPICS[label] ?? "pressure"}
            as="div"
            className="label"
          >
            {label}
          </Help>
          <div className="value">{value}</div>
          <div className="sub">{sub}</div>
          <Sparkline
            values={values.map((item) => item ?? null)}
            color="var(--series-1)"
          />
        </div>
      ))}
    </div>
  );
}

const PRESSURE_COLUMNS = [
  ["cgroup", "some", "Cgroup some"],
  ["cgroup", "full", "Cgroup full"],
  ["host", "some", "Host some"],
  ["host", "full", "Host full"],
] as const;
function Pressure({
  observation,
  scope,
  range,
}: {
  observation: Observation;
  scope: PressureScope;
  range: ResourceRange;
}) {
  const { holding, handlers } = useHolding();
  const { r, points, now } = useHeld(observation, holding);
  const { readout, show, clear } = useReadout();
  const shown = scopeOf(r, scope);
  return (
    <div {...handlers}>
      {/* A range or scope change starts a new chart, without a readout. */}
      <TimeChart
        key={`${String(range)}|${shown}`}
        id="chart-pressure"
        topic="pressure"
        points={points}
        series={PRESSURE_SERIES.map(([key, label, color]) => ({
          label: label + " some",
          color,
          get: (point: ResourcePoint) => point[`${shown}_${key}_some_pct`],
        }))}
        format={pct}
        height={170}
        minMax={5}
        from={now - range}
        to={now}
        empty={EMPTY_HISTORY}
      />
      <div id="pressure-legend" className="legend">
        {PRESSURE_SERIES.map(([key, label, color]) => (
          <Help key={key} topic="pressure">
            <i className="sw line" style={{ background: color }} />
            {label} some
            <b>{pct(stall(r.pressure?.[shown]?.[key]?.some))}</b>
          </Help>
        ))}
      </div>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table>
          <thead>
            <tr>
              <th>
                <Help topic="pressure">Resource</Help>
              </th>
              {PRESSURE_COLUMNS.map(([where, kind, label]) => (
                <th key={where + kind} className="num">
                  <Help topic="pressure">{label}</Help>
                </th>
              ))}
            </tr>
          </thead>
          <Help
            as="tbody"
            id="pressure-rows"
            topic="pressure"
            readout={readout ?? undefined}
          >
            {PRESSURE_SERIES.map(([key, label]) => (
              <tr key={key} onMouseLeave={clear}>
                <td>{label}</td>
                {PRESSURE_COLUMNS.map(([where, kind, column]) => {
                  const entry = r.pressure?.[where]?.[key]?.[kind];
                  const value = pct(stall(entry));
                  return (
                    <td
                      key={where + kind}
                      className="num"
                      onMouseMove={(event) => {
                        show(
                          event,
                          `${key}|${where}|${kind}`,
                          label,
                          [
                            { color: "", value, label: column },
                            ...(entry
                              ? [
                                  {
                                    color: "",
                                    value: `avg10 ${pct(entry.avg10)} · total ${num((entry.total_us || 0) / 1e6, 0)} s stalled`,
                                    label: "Detail",
                                  },
                                ]
                              : []),
                          ],
                          r.updated ?? now,
                        );
                      }}
                    >
                      {value}
                    </td>
                  );
                })}
              </tr>
            ))}
          </Help>
        </table>
      </div>
    </div>
  );
}

function Meter({
  label,
  topic,
  sub,
  value,
  max,
  text,
}: {
  label: string;
  topic: HelpTopicId;
  sub: string;
  value: number | null | undefined;
  max: number | null | undefined;
  text: string;
}) {
  const share =
    isNum(value) && isNum(max) && max > 0 ? (100 * value) / max : null;
  return (
    <Help topic={topic} as="div" className="meter">
      <div>
        {label}
        {sub && <small>{sub}</small>}
      </div>
      <div className="track">
        {share !== null && (
          <div
            className={`fill ${fillLevel(share)}`}
            style={{ width: `${String(Math.min(100, share))}%` }}
          />
        )}
      </div>
      <div className="val">{text}</div>
    </Help>
  );
}
function Limits({ observation }: { observation: Observation }) {
  const { holding, handlers } = useHolding();
  const { r } = useHeld(observation, holding);
  const fds = r.fds || {},
    limits = r.limits || {},
    sockstat = r.sockstat || {},
    page = limits.page_size || 4096;
  const cg = r.cgroup_limits || {},
    mem = cg.memory || {},
    cpu = cg.cpu || {},
    pids = cg.pids || {};
  const worst = (r.sockets?.top || [])
    .filter((item) => item.listener)
    .sort((a, b) => (b.accept_fill_pct || 0) - (a.accept_fill_pct || 0))[0];
  const memoryUse = (
    [
      ["TCP memory", sockstat.tcp_mem, limits.tcp_mem],
      ["UDP memory", sockstat.udp_mem, limits.udp_mem],
    ] as const
  ).flatMap(([label, used, thresholds]) => {
    const pressureAt = thresholds?.[1];
    return isNum(used) && isNum(pressureAt)
      ? [{ label, used, pressureAt, limit: thresholds?.[2] }]
      : [];
  });
  return (
    <div {...handlers}>
      <div id="limits">
        <Meter
          label="Open files"
          topic="fds"
          sub={
            isNum(fds.hard_limit) ? `hard limit ${String(fds.hard_limit)}` : ""
          }
          value={fds.open}
          max={fds.soft_limit}
          text={
            isNum(fds.open) && isNum(fds.soft_limit)
              ? `${String(fds.open)} / ${String(fds.soft_limit)}`
              : "—"
          }
        />
        {isNum(mem.current) &&
          (isNum(mem.max) ? (
            <Meter
              label="Cgroup memory"
              topic="cgroupmem"
              sub={`incl. page cache${isNum(mem.high) ? " · high " + bytes(mem.high) : ""}`}
              value={mem.current}
              max={mem.max}
              text={`${bytes(mem.current)} / ${bytes(mem.max)}`}
            />
          ) : (
            <Meter
              label="Cgroup memory"
              topic="cgroupmem"
              sub="no memory.max limit"
              value={null}
              max={0}
              text={bytes(mem.current)}
            />
          ))}
        {isNum(cpu.quota_us) && isNum(cpu.period_us) && (
          <Meter
            label="CPU throttling"
            topic="throttle"
            sub={`quota ${num(cpu.quota_us / cpu.period_us, 2)} cores`}
            value={cpu.throttled_pct}
            max={100}
            text={
              isNum(cpu.throttled_pct)
                ? pct(cpu.throttled_pct) + " of periods"
                : "—"
            }
          />
        )}
        {isNum(pids.current) && (
          <Meter
            label="Processes & threads"
            topic="pids"
            sub={isNum(pids.max) ? "cgroup pids.max" : "no pids.max limit"}
            value={isNum(pids.max) ? pids.current : null}
            max={isNum(pids.max) ? pids.max : 0}
            text={
              isNum(pids.max)
                ? `${String(pids.current)} / ${String(pids.max)}`
                : String(pids.current)
            }
          />
        )}
        {worst && (
          <Meter
            label="Accept backlog"
            topic="backlog"
            sub={worst.local || worst.path || ""}
            value={worst.rx_queue}
            max={worst.tx_queue}
            text={`${String(worst.rx_queue)} / ${String(worst.tx_queue)}`}
          />
        )}
        {memoryUse.map(({ label, used, pressureAt, limit }) => (
          <Meter
            key={label}
            label={label}
            topic="sockmem"
            sub={`pressure at ${bytes(pressureAt * page)}, limit ${bytes(Number(limit) * page)} · host-wide`}
            value={used}
            max={pressureAt}
            text={bytes(used * page)}
          />
        ))}
      </div>
      <dl id="limit-facts" className="facts">
        {(
          [
            ["Max SO_RCVBUF (rmem_max)", bytes(limits.rmem_max), "sockmem"],
            ["Max SO_SNDBUF (wmem_max)", bytes(limits.wmem_max), "sockmem"],
            [
              "Max listen backlog (somaxconn)",
              String(limits.somaxconn ?? "—"),
              "backlog",
            ],
            [
              "TCP sockets in namespace",
              isNum(sockstat.tcp_inuse)
                ? `${String(sockstat.tcp_inuse)} · ${String(sockstat.tcp_orphan)} orphaned · ${String(sockstat.tcp_tw)} time-wait`
                : "—",
              "endpoint",
            ],
          ] as const
        ).map(([label, value, topic]) => (
          <Help key={label} topic={topic} as="div">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Help>
        ))}
      </dl>
    </div>
  );
}

const QUEUE_SERIES = [
  ["rx_queue", "rx_queue_bytes", "Receive queue (unread)", "var(--series-1)"],
  ["tx_queue", "tx_queue_bytes", "Send queue (unsent)", "var(--series-2)"],
] as const;
function Queues({
  observation,
  range,
}: {
  observation: Observation;
  range: ResourceRange;
}) {
  const { holding, handlers } = useHolding();
  const { r, points, now } = useHeld(observation, holding);
  const kinds = r.sockets || {},
    states = kinds.tcp_states || {};
  const all = ["tcp", "udp", "unix"] as const;
  return (
    <div {...handlers}>
      <TimeChart
        key={range}
        id="chart-queues"
        topic="queues"
        points={points}
        series={QUEUE_SERIES.map(([, column, label, color]) => ({
          label,
          color,
          get: (point: ResourcePoint) => point[column],
        }))}
        format={bytes}
        height={150}
        minMax={1024}
        from={now - range}
        to={now}
        empty={EMPTY_HISTORY}
      />
      <div id="queues-legend" className="legend">
        {QUEUE_SERIES.map(([key, , label, color]) => (
          <Help key={key} topic="queues">
            <i className="sw line" style={{ background: color }} />
            {label}
            <b>
              {bytes(
                all.reduce((sum, kind) => sum + (kinds[kind]?.[key] || 0), 0),
              )}
            </b>
          </Help>
        ))}
        <Help topic="queues" className="muted">
          {`${all.map((kind) => `${String(kinds[kind]?.sockets ?? 0)} ${kind.toUpperCase()}`).join(" · ")} · ${String(states.established ?? 0)} established · ${String(states.close_wait ?? 0)} close-wait · ${String(states.listen ?? 0)} listening`}
        </Help>
      </div>
    </div>
  );
}

const NETWORK_COLUMNS = ["Counter", "Rate (/s)", "In range", "Total"] as const;
function Network({ observation }: { observation: Observation }) {
  const { holding, handlers } = useHolding();
  const { r, points, now } = useHeld(observation, holding);
  const { readout, show, clear } = useReadout();
  const { rows, zero } = networkRows(r, points);
  return (
    <div {...handlers}>
      <p id="netstack-sub" className="fold-note">
        Counters for the target’s network namespace, shared by every process in
        it. Rows that grew recently are highlighted; hover a row for what it
        means.
      </p>
      <div className="table-wrap" style={{ maxHeight: 330 }}>
        <table>
          <thead>
            <tr>
              {NETWORK_COLUMNS.map((label, column) => (
                <th key={label} className={column ? "num" : undefined}>
                  <Help topic="netdrops">{label}</Help>
                </th>
              ))}
            </tr>
          </thead>
          <Help
            as="tbody"
            id="netstack"
            topic={readout?.topic ?? "netdrops"}
            readout={readout ?? undefined}
          >
            {rows.map((row) => {
              const topic: HelpTopicId = `net-${row.key}`;
              const cell = (
                column: (typeof NETWORK_COLUMNS)[number],
                value: string,
                content: ReactNode,
                className?: string,
              ) => (
                <td
                  className={className}
                  onMouseMove={(event: MouseEvent) => {
                    show(
                      event,
                      `${row.key}|${column}`,
                      row.label,
                      column === "Counter"
                        ? []
                        : [{ color: "", value, label: column }],
                      r.updated ?? now,
                      topic,
                    );
                  }}
                >
                  {content}
                </td>
              );
              return (
                <tr
                  key={row.key}
                  className={row.active ? undefined : "zero"}
                  data-counter={row.key}
                  onMouseLeave={clear}
                >
                  {cell(
                    "Counter",
                    row.label,
                    <>
                      <span>{row.label}</span>
                      <small>{row.meaning}</small>
                    </>,
                  )}
                  {cell(
                    "Rate (/s)",
                    row.now,
                    row.now,
                    "num" + (row.nowBad ? " bad" : ""),
                  )}
                  {cell(
                    "In range",
                    row.inRange,
                    row.inRange,
                    "num" + ((row.range ?? 0) > 0 ? " bad" : ""),
                  )}
                  {cell("Total", row.total, row.total, "num")}
                </tr>
              );
            })}
            {zero && (
              <tr className="zero">
                <td colSpan={4}>{zero}</td>
              </tr>
            )}
          </Help>
        </table>
      </div>
    </div>
  );
}

const SOCKET_COLUMNS: readonly {
  label: string;
  topic: HelpTopicId;
  num?: boolean;
}[] = [
  { label: "Socket", topic: "endpoint" },
  { label: "Local → peer", topic: "endpoint" },
  { label: "Recv-Q", topic: "recvq", num: true },
  { label: "Receive buffer", topic: "recvq" },
  { label: "Send-Q", topic: "sendq", num: true },
  { label: "Send buffer", topic: "sendq" },
  { label: "Drops", topic: "sockdrops", num: true },
  { label: "RTT", topic: "rtt", num: true },
  { label: "Retrans", topic: "retrans", num: true },
  { label: "What it means", topic: "assessment" },
];
function FillCell({ fill }: { fill: { value: number; text: string } | null }) {
  if (!fill) return <>—</>;
  return (
    <div className="fillcell">
      <div className="track">
        <div
          className={`fill ${fillLevel(fill.value)}`}
          style={{ width: `${String(Math.min(100, fill.value))}%` }}
        />
      </div>
      <span>{fill.text}</span>
    </div>
  );
}
function FullestSockets({
  observation,
  busyOnly,
  onBusyOnly,
}: {
  observation: Observation;
  busyOnly: boolean;
  onBusyOnly: (busyOnly: boolean) => void;
}) {
  const { holding, handlers } = useHolding();
  const { r, now } = useHeld(observation, holding);
  const { readout, show, clear } = useReadout();
  const wrap = useRef<HTMLDivElement>(null);
  const { rows, count, empty } = fullestSockets(r, busyOnly);
  return (
    <div className="card" style={{ marginTop: 14 }} {...handlers}>
      <div className="card-head">
        <div>
          <Help topic="queues" as="div">
            <h3>
              Fullest sockets{" "}
              <span
                id="resource-socket-count"
                className="muted"
                style={{ fontWeight: 400 }}
              >
                {count}
              </span>
            </h3>
          </Help>
          <p>Sockets ranked by buffer use in the latest sample.</p>
        </div>
        <Help topic="queues">
          <label className="muted" style={{ fontSize: 13 }}>
            <input
              id="sockets-busy-only"
              type="checkbox"
              checked={busyOnly}
              onChange={(event) => {
                // The filter applies to the held sample at once; the old
                // readout and scroll position belong to other rows.
                clear();
                if (wrap.current) wrap.current.scrollTop = 0;
                onBusyOnly(event.target.checked);
              }}
            />{" "}
            Only sockets with data, drops or retransmits
          </label>
        </Help>
      </div>
      <div ref={wrap} className="table-wrap" style={{ maxHeight: 440 }}>
        <table>
          <thead>
            <tr>
              {SOCKET_COLUMNS.map((column) => (
                <th
                  key={column.label}
                  className={column.num ? "num" : undefined}
                >
                  <Help topic={column.topic}>{column.label}</Help>
                </th>
              ))}
            </tr>
          </thead>
          <Help
            as="tbody"
            id="resource-sockets"
            topic={readout?.topic ?? "queues"}
            readout={readout ?? undefined}
          >
            {rows.map((item) => {
              const c = socketCells(item);
              // A socket is one inode and descriptor of one process session.
              const id = `${String(r.session)}|${String(r.pid)}|${String(item.inode)}|${String(item.fd)}|${item.kind}`;
              const cells: [string, ReactNode, string?, string?][] = [
                [
                  c.label,
                  <>
                    <span>{c.label}</span>
                    {item.listener && <small>listener</small>}
                  </>,
                ],
                [c.peer, c.peer, "mono"],
                [c.recvQ, c.recvQ, "num"],
                [
                  c.receiveBuffer?.text ?? "—",
                  <FillCell fill={c.receiveBuffer} />,
                  undefined,
                  c.receiveBuffer?.hint,
                ],
                [c.sendQ, c.sendQ, "num"],
                [
                  c.sendBuffer?.text ?? "—",
                  <FillCell fill={c.sendBuffer} />,
                  undefined,
                  c.sendBuffer?.hint,
                ],
                [c.drops, c.drops, "num" + (c.dropsBad ? " bad" : "")],
                [c.rtt, c.rtt, "num"],
                [c.retrans, c.retrans, "num"],
                [
                  c.notes.map((note) => note[0]).join(" · "),
                  c.notes.map(([text, kind]) => (
                    <span
                      key={text}
                      className={"note" + (kind ? " " + kind : "")}
                    >
                      {text}
                    </span>
                  )),
                ],
              ];
              return (
                <tr key={id} data-socket={id} onMouseLeave={clear}>
                  {cells.map(([value, content, className, hint], index) => {
                    const column = SOCKET_COLUMNS[index];
                    return (
                      <td
                        key={column?.label}
                        className={className}
                        onMouseMove={(event) => {
                          if (column)
                            readSocket(show, event, {
                              key: `${id}|${column.label}`,
                              title: c.label,
                              value,
                              column: column.label,
                              hint,
                              stamp: r.updated ?? now,
                              topic: column.topic,
                            });
                        }}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={10}>{empty}</td>
              </tr>
            )}
          </Help>
        </table>
      </div>
      <Help topic="coverage" as="div">
        <p id="resource-coverage" className="socket-note">
          {resourceCoverage(r)}
        </p>
      </Help>
    </div>
  );
}
function readSocket(
  show: Show,
  event: MouseEvent,
  cell: {
    key: string;
    title: string;
    value: string;
    column: string;
    hint: string | undefined;
    stamp: number;
    topic: HelpTopicId;
  },
) {
  show(
    event,
    cell.key,
    cell.title,
    [
      { color: "", value: cell.value || "—", label: cell.column },
      ...(cell.hint ? [{ color: "", value: cell.hint, label: "Detail" }] : []),
    ],
    cell.stamp,
    cell.topic,
  );
}
