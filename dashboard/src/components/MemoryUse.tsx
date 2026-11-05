import { useMemo, type ReactNode } from "react";
import type { Resources } from "../api/types";
import type { ResourcePoint } from "../lib/assess/memory";
import { axisBytes } from "../lib/chart";
import { duration, isNum, memoryBytes, pct, signed } from "../lib/format";
import {
  ARROWS,
  CHANGE_WINDOWS,
  autoSpan,
  classifyMemory,
  flatFor,
  hostAvailablePct,
  newestRun,
  rateText,
  restartTimes,
  risingInEveryWindow,
  windowChanges,
  type WindowChange,
} from "../lib/memoryTrend";
import { RESOURCE_RANGES, type ResourceRange } from "./Resources";
import { TimeChart } from "./TimeChart";

const CHIP_LABELS = ["15 m", "1 h", "6 h", "24 h"] as const;
type Get = (point: ResourcePoint) => number | null | undefined;
const rss: Get = (point) => point.rss_bytes,
  vm: Get = (point) => point.vm_size_bytes;
const points = (value: number) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toFixed(1)} pts`;

/**
 * The Memory use card: RSS and VmSize over the selected range on one time
 * axis, change chips over fixed windows of the last 24 h, and host memory
 * and swap as bars. In a recorded view only the current values show.
 */
export function MemoryUse({
  resources,
  rangePoints,
  dayPoints,
  liveRss,
  liveVm,
  range,
  onRange,
  recorded,
}: {
  resources: Resources | undefined;
  /** Stored samples of the selected range: the charts and the verdict. */
  rangePoints: readonly ResourcePoint[];
  /** Stored samples of the last 24 h: the chips. */
  dayPoints: readonly ResourcePoint[];
  /** The newest live values, before the stored ones. */
  liveRss: number | null | undefined;
  liveVm: number | null | undefined;
  range: ResourceRange;
  onRange: (seconds: ResourceRange) => void;
  recorded: boolean;
}) {
  const trend = useMemo(() => classifyMemory(rangePoints), [rangePoints]);
  const restarts = useMemo(() => restartTimes(rangePoints), [rangePoints]);
  const changes = useMemo(
    () => ({
      rss: windowChanges(dayPoints, rss),
      vm: windowChanges(dayPoints, vm),
      host: windowChanges(dayPoints, hostAvailablePct),
    }),
    [dayPoints],
  );
  const selected = CHANGE_WINDOWS.indexOf(range);
  // Time labels go below VmSize, or below RSS when VmSize has no history.
  const hasVm = rangePoints.some((point) => isNum(vm(point)));
  const rssTrend = useTrend(rangePoints, rss, changes.rss[selected] ?? null),
    vmTrend = useTrend(rangePoints, vm, changes.vm[selected] ?? null);
  const to = rangePoints.at(-1)?.t,
    from = to === undefined ? undefined : to - range;
  const current = resources?.available && !resources.stale ? resources : null;
  const host = current?.host_memory;
  const rssNow = liveRss ?? newestRun(rangePoints, rss).run.at(-1)?.v,
    vmNow = liveVm ?? newestRun(rangePoints, vm).run.at(-1)?.v;
  const hostTotal = isNum(host?.total) && host.total > 0 ? host.total : null,
    hostFree = hostTotal && isNum(host?.available) ? host.available : null,
    hostShare =
      hostTotal && hostFree !== null ? (100 * hostFree) / hostTotal : null;
  const swapTotal =
      isNum(host?.swap_total) && host.swap_total > 0 ? host.swap_total : null,
    swapUsed =
      swapTotal && isNum(host?.swap_free) ? swapTotal - host.swap_free : null;
  const empty = resources?.available
    ? "Waiting for resource samples…"
    : resources?.reason || "This collector does not report resource samples.";

  const vmFlat = changes.vm[selected]?.direction === "flat";
  const vmRate =
    vmFlat && range >= 3600
      ? `${ARROWS.flat} flat for ${duration(flatFor(newestRun(dayPoints, vm).run) ?? 0)}`
      : rateText(changes.vm[selected] ?? null, range, signed);
  const ratio =
    isNum(vmNow) && isNum(rssNow) && rssNow > 0
      ? `${(vmNow / rssNow).toFixed(1)}× RSS`
      : null;
  const hostDetail =
    hostFree !== null && hostTotal !== null
      ? `${memoryBytes(hostFree)} of ${memoryBytes(hostTotal)}`
      : null;

  return (
    <div id="overview-memory" className="card overview-memory">
      <div className="card-head">
        <div>
          {/* The Summary source button covers rss, vmsize, and hostmem. */}
          <h3>Memory use</h3>
          <p id="memory-verdict" data-kind={trend.kind}>
            {trend.text}
          </p>
        </div>
        <div
          className="seg"
          role="group"
          aria-label="Memory history range"
          hidden={recorded}
        >
          {RESOURCE_RANGES.map(([seconds, label]) => (
            <button
              key={seconds}
              type="button"
              aria-pressed={range === seconds}
              onClick={() => {
                onRange(seconds);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <Panel
        id="rss"
        name="Resident (RSS)"
        color="var(--series-1)"
        value={memoryBytes(rssNow)}
        rate={rateText(changes.rss[selected] ?? null, range, signed)}
        changes={changes.rss}
        selected={selected}
        format={signed}
        pill={risingInEveryWindow(changes.rss)}
        recorded={recorded}
      >
        <TimeChart
          id="chart-rss"
          topic="rss"
          points={rangePoints}
          series={[
            { label: "Resident (RSS)", color: "var(--series-1)", get: rss },
          ]}
          markers={restarts}
          format={axisBytes}
          height={120}
          from={from}
          to={to}
          trend={rssTrend}
          timeLabels={!hasVm}
          empty={empty}
        />
      </Panel>
      <Panel
        id="vm"
        name="Virtual (VmSize)"
        color="var(--series-2)"
        value={memoryBytes(vmNow)}
        rate={[vmRate, ratio].filter(Boolean).join(" · ") || null}
        changes={changes.vm}
        selected={selected}
        format={signed}
        pill={risingInEveryWindow(changes.vm)}
        recorded={recorded}
      >
        <TimeChart
          id="chart-vm"
          topic="vmsize"
          points={hasVm ? rangePoints : []}
          series={[
            { label: "Virtual (VmSize)", color: "var(--series-2)", get: vm },
          ]}
          markers={restarts}
          format={axisBytes}
          height={86}
          from={from}
          to={to}
          trend={vmTrend}
          empty={rangePoints.length ? "No stored VmSize history yet." : empty}
        />
      </Panel>
      <Panel
        id="host-mem"
        name="Host available"
        color="var(--series-3)"
        value={pct(hostShare)}
        rate={
          [rateText(changes.host[selected] ?? null, range, points), hostDetail]
            .filter(Boolean)
            .join(" · ") || "No host memory reading yet."
        }
        changes={changes.host}
        selected={selected}
        format={points}
        pill={false}
        recorded={recorded}
      />
      <div className="mem-bars">
        <Bar
          id="host-bar"
          name="Host memory"
          share={hostShare}
          fill="var(--series-3)"
          rest
          value={
            hostFree !== null && hostTotal !== null
              ? `${memoryBytes(hostFree)} / ${memoryBytes(hostTotal)} free`
              : "—"
          }
          sub={hostShare === null ? "" : `${pct(hostShare)} available`}
        />
        <Bar
          id="swap-bar"
          name="Swap"
          share={
            swapUsed !== null && swapTotal ? (100 * swapUsed) / swapTotal : null
          }
          fill="var(--accent)"
          value={
            swapUsed !== null && swapTotal !== null
              ? `${memoryBytes(swapUsed)} / ${memoryBytes(swapTotal)} used`
              : host
                ? "No swap"
                : "—"
          }
          sub={
            swapUsed !== null && swapTotal
              ? `${pct((100 * swapUsed) / swapTotal)} used`
              : ""
          }
        />
      </div>
    </div>
  );
}

/** The axis range and window-start level of one chart. */
function useTrend(
  points: readonly ResourcePoint[],
  get: Get,
  change: WindowChange,
) {
  return useMemo(() => {
    const span = autoSpan(points.map(get).filter(isNum));
    return span && { ...span, base: change?.start.v ?? null };
  }, [points, get, change]);
}

function Panel({
  id,
  name,
  color,
  value,
  rate,
  changes,
  selected,
  format,
  pill,
  recorded,
  children,
}: {
  id: string;
  name: string;
  color: string;
  value: string;
  rate: string | null;
  changes: readonly WindowChange[];
  selected: number;
  format: (delta: number) => string;
  pill: boolean;
  recorded: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="mem-panel" id={`${id}-panel`}>
      <div className="mem-head">
        <span className="mem-name">
          <i className="dot" style={{ background: color }} />
          {name}
        </span>
        <b id={`overview-${id}`}>{value}</b>
        {!recorded && rate && (
          <span id={`overview-${id}-detail`} className="mem-rate">
            {rate}
          </span>
        )}
        {!recorded && pill && (
          <span className="mem-pill">Rising in every window</span>
        )}
      </div>
      <ul className="mem-chips" id={`${id}-changes`} hidden={recorded}>
        {changes.map((change, index) => (
          <li
            key={CHIP_LABELS[index]}
            className={index === selected ? "on" : undefined}
            data-direction={change?.direction ?? "none"}
          >
            <span className="mem-chip-window">{CHIP_LABELS[index]}</span>{" "}
            {change
              ? `${ARROWS[change.direction]} ${format(change.delta)}`
              : "–"}
          </li>
        ))}
      </ul>
      {children && <div hidden={recorded}>{children}</div>}
    </div>
  );
}

function Bar({
  id,
  name,
  share,
  fill,
  rest = false,
  value,
  sub,
}: {
  id: string;
  name: string;
  share: number | null;
  fill: string;
  /** Draw the rest of the track as the used part, in a muted color. */
  rest?: boolean;
  value: string;
  sub: string;
}) {
  const width = share === null ? 0 : Math.min(100, Math.max(0, share));
  return (
    <div className="mem-bar" id={id}>
      <div className="mem-bar-head">
        <span>{name}</span>
        <b>{value}</b>
      </div>
      <div className={rest ? "track rest" : "track"}>
        {share !== null && (
          <i style={{ width: `${String(width)}%`, background: fill }} />
        )}
      </div>
      <small>{sub}</small>
    </div>
  );
}
