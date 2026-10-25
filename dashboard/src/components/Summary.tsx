import { useState, type CSSProperties, type ReactNode } from "react";
import type {
  LiveResponse,
  MemoryLayout,
  PressureScope,
  WatchRule,
} from "../api/types";
import { Help } from "../help/Help";
import { isHelpTopicId } from "../help/topics";
import type { ViewMode } from "../lib/assess";
import { assess, assessRecorded } from "../lib/assess";
import type { ResourcePoint } from "../lib/assess/memory";
import type { MemoryPoint } from "../lib/memoryView";
import { axisBytes, niceBytes } from "../lib/chart";
import { clock, isNum, memoryBytes } from "../lib/format";
import {
  LEVEL_ICONS,
  LEVEL_ORDER,
  VERDICTS,
  type Finding,
} from "../lib/findings";
import { windowPoints, type Point, type Series } from "../lib/series";
import { loadFacts, profile, summaryTiles } from "../lib/summary";
import { viewTargetName } from "../lib/target";
import { Sparkline } from "./Sparkline";
import { TimeChart, type ChartSeries } from "./TimeChart";
import "./summary.css";

export const CHART_WINDOWS = [
  [60, "1 min"],
  [300, "5 min"],
  [900, "15 min"],
] as const;
export type ChartWindow = (typeof CHART_WINDOWS)[number][0];

const LOAD_BANDS: readonly (ChartSeries<Point> & {
  topic: "cpucores" | "load" | "kernel";
})[] = [
  {
    label: "On CPU",
    topic: "cpucores",
    color: "var(--series-1)",
    get: (point) => (point.cpu === null ? null : point.cpu / 100),
  },
  {
    label: "Waiting for CPU",
    topic: "load",
    color: "var(--series-2)",
    get: (point) => (point.cpu === null ? null : (point.rd || 0) / 100),
  },
  {
    label: "Blocked in kernel (D)",
    topic: "kernel",
    color: "var(--s-kernel)",
    get: (point) => (point.cpu === null ? null : point.s.kernel || 0),
  },
];
const loadFormat = (value: unknown) =>
  isNum(value) ? String(+value.toFixed(2)) : "—";

/** The Summary section: how the whole target process is behaving. */
export function Summary({
  view,
  mode = { kind: "live" },
  series,
  now,
  windowSecs,
  onWindow,
  onFindingAction,
  resourcePoints,
  pressureScope,
  memoryLayout = null,
  memoryHistory = [],
  watchRules = null,
  children,
}: {
  view: LiveResponse | undefined;
  mode?: ViewMode;
  series: Series;
  now: number;
  /** Stored resource samples of the Resources range, as the old page used. */
  resourcePoints: readonly ResourcePoint[];
  pressureScope: PressureScope;
  /** The held memory-map layout and live memory history (Memory map). */
  memoryLayout?: MemoryLayout | null;
  memoryHistory?: readonly MemoryPoint[];
  /** The rules in force from /api/watches, or null before a good read. */
  watchRules?: readonly WatchRule[] | null;
  windowSecs: ChartWindow;
  onWindow: (seconds: ChartWindow) => void;
  /** A finding row opens its thread or filters the thread table. */
  onFindingAction?: (action: NonNullable<Finding["action"]>) => void;
  children?: ReactNode;
}) {
  const threads = view?.threads ?? [];
  const all = series.points,
    { points, from } = windowPoints(series, windowSecs),
    last = points.at(-1);
  const findings = view
    ? mode.kind === "recorded"
      ? assessRecorded(view, now, resourcePoints, {
          memoryLayout,
          pressureScope,
        })
      : assess({
          view,
          mode,
          now,
          series,
          watchRules,
          resourcePoints,
          memoryLayout,
          memoryHistory,
          pressureScope,
        })
    : null;
  const bands = LOAD_BANDS.filter(
    (band) =>
      band.label !== "Blocked in kernel (D)" ||
      points.some((point) => point.s.kernel),
  );
  const facts = loadFacts(threads, series, mode.kind !== "recorded");
  const memoryChart = (
    id: string,
    key: "rss" | "vm",
    topic: "rss" | "vmsize",
    label: string,
    color: string,
    source: { available: boolean; reason?: string } | undefined,
    missing: string,
    waiting: string,
  ) => (
    // The load chart supplies the points, so with sampling off or every
    // sample stale the memory charts would draw empty axes. Show why instead.
    <div hidden={mode.kind === "recorded"}>
      <TimeChart
        id={id}
        topic={topic}
        points={points.some((point) => isNum(point[key])) ? points : []}
        series={[{ label, color, get: (point) => point[key] }]}
        format={axisBytes}
        nice={niceBytes}
        height={100}
        minMax={2 ** 20}
        from={from}
        empty={source?.available ? waiting : source?.reason || missing}
      />
    </div>
  );
  return (
    <section id="overview" className="block overview">
      <div className="section-head">
        <div>
          <Help topic="overview" as="div">
            <h2>Summary</h2>
          </Help>
          <p id="overview-sub">
            {!view
              ? "How the whole target process is behaving, summed over all of its threads."
              : threads.length
                ? `${viewTargetName(view)} · ${String(threads.length)} threads.${all[0] ? ` Trends kept in this tab since ${clock(all[0].t)}.` : ""}`
                : "Waiting for the sampler to report the target process."}
          </p>
        </div>
        <Help topic="overview" as="div">
          <div className="seg" role="group" aria-label="Chart time window">
            {CHART_WINDOWS.map(([seconds, label]) => (
              <button
                key={seconds}
                type="button"
                disabled={mode.kind === "recorded"}
                data-window={seconds}
                aria-pressed={windowSecs === seconds}
                onClick={() => {
                  onWindow(seconds);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </Help>
      </div>

      <Assessment
        findings={findings}
        profile={profile(threads)}
        lastTick={series.lastTick}
        onAction={onFindingAction}
      />

      <div id="tiles" className="tiles">
        {view &&
          summaryTiles(threads, points, all).map((tile) => (
            <div key={tile.label} className="card tile">
              <Help topic={tile.topic} as="div" className="label">
                {tile.label}
              </Help>
              <div className="value">{tile.value}</div>
              <div className="sub">{tile.sub}</div>
              <Sparkline values={tile.values} color="var(--series-1)" />
            </div>
          ))}
      </div>

      {/* Load and memory use share the selected time window. */}
      <div className="grid g-hero">
        <div className="card">
          <div className="card-head">
            <div>
              <Help topic="load" as="div">
                <h3>Process load</h3>
              </Help>
              <p>
                Running, waiting for CPU, or blocked in kernel. 1.00 is one core
                of demand.
              </p>
            </div>
          </div>
          <div className="hero-row">
            <Help topic="load" as="div">
              <span id="hero-load" className="hero">
                {facts.load1}
              </span>
              <div className="muted" style={{ fontSize: 12 }}>
                1-minute load
              </div>
            </Help>
            <div className="hero-side">
              <Fact id="hero-load5" label="5 min" topic="load">
                {facts.load5}
              </Fact>
              <Fact
                id="hero-load15"
                labelId="hero-load15-label"
                label={facts.load15Label}
                topic="load"
              >
                {facts.load15}
              </Fact>
              <Fact id="hero-cpu" label="On CPU now" topic="cpucores">
                {facts.cpu}
              </Fact>
              <Fact id="hero-wait" label="Waiting for CPU" topic="demand">
                {facts.wait}
              </Fact>
              <Fact id="hero-top" label="Busiest thread" topic="thread">
                {facts.busiest}
              </Fact>
            </div>
          </div>
          <div hidden={mode.kind === "recorded"}>
            <TimeChart
              id="chart-load"
              topic="load"
              points={points}
              stacked
              series={bands}
              overlay={{
                label: "1-min load average",
                color: "var(--ink-2)",
                get: (point) => point.l1,
              }}
              format={loadFormat}
              height={210}
              minMax={0.05}
              from={from}
            />
          </div>
          <div
            id="load-legend"
            hidden={mode.kind === "recorded"}
            className="legend"
          >
            {bands.map((band) => {
              const value = last ? band.get(last) : null;
              return (
                <Help key={band.label} topic={band.topic}>
                  <i className="sw" style={{ background: band.color }} />
                  {band.label}
                  <b>{isNum(value) ? value.toFixed(2) : "—"}</b>
                </Help>
              );
            })}
            <Help topic="load">
              <i className="sw line" style={{ background: "var(--ink-2)" }} />
              1-min average
            </Help>
            {/* Fallback mode has CPU but no run delay; a tick with no rates
                at all is a stall, not fallback. */}
            {threads.some((thread) => isNum(thread.cpu_pct)) &&
              !threads.some((thread) => isNum(thread.run_delay_pct)) && (
                <Help topic="load" className="muted">
                  Waiting for CPU is unavailable in status-fallback mode.
                </Help>
              )}
          </div>
        </div>
        <div id="overview-memory" className="card overview-memory">
          <div className="card-head">
            <div>
              <Help topic="memory-use" as="div">
                <h3>Memory use</h3>
              </Help>
              <p>Physical memory and mapped address space.</p>
            </div>
          </div>
          <div>
            <div className="mini-cap">
              <Help topic="rss" className="help-label">
                Resident memory (RSS)
              </Help>
              <b id="overview-rss">{memoryBytes(last?.rss)}</b>
            </div>
            {memoryChart(
              "chart-rss",
              "rss",
              "rss",
              "Resident (RSS)",
              "var(--series-1)",
              view?.resources,
              "This collector does not report resource samples.",
              "Waiting for resource samples…",
            )}
            <div className="mini-cap">
              <Help topic="vmsize" className="help-label">
                Virtual size (VmSize)
              </Help>
              <b id="overview-vm">{memoryBytes(last?.vm)}</b>
            </div>
            {memoryChart(
              "chart-vm",
              "vm",
              "vmsize",
              "Virtual size (VmSize)",
              "var(--series-2)",
              view?.memory,
              "This collector does not report memory-map samples.",
              "Waiting for memory samples…",
            )}
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}

function Fact({
  id,
  labelId,
  label,
  topic,
  children,
}: {
  id: string;
  labelId?: string;
  label: string;
  topic: "load" | "cpucores" | "demand" | "thread";
  children: ReactNode;
}) {
  return (
    <Help topic={topic} as="div" className="kv">
      <div className="k" id={labelId}>
        {label}
      </div>
      <div id={id} className="v">
        {children}
      </div>
    </Help>
  );
}

// The card lists the most severe findings first; the rest open on request.
const FINDINGS_SHOWN = 8;
function Assessment({
  findings,
  profile,
  lastTick,
  onAction,
}: {
  findings: readonly Finding[] | null;
  profile: string;
  lastTick: number;
  onAction: ((action: NonNullable<Finding["action"]>) => void) | undefined;
}) {
  const [all, setAll] = useState(false);
  const ranked = (findings ?? [])
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        LEVEL_ORDER.indexOf(a.item.level) - LEVEL_ORDER.indexOf(b.item.level) ||
        a.index - b.index,
    )
    .map((entry) => entry.item);
  const worst = ranked[0]?.level;
  const hidden = ranked.length - FINDINGS_SHOWN;
  return (
    <div
      id="assessment-card"
      className="card assessment-card"
      data-level={worst}
    >
      <div className="assessment-heading">
        <Help topic="assessment" as="div">
          <h3>Assessment</h3>
        </Help>
        <Help topic="assessment" as="div" className="verdict">
          <span
            id="verdict"
            className="badge"
            style={
              worst
                ? ({
                    "--lvl": `var(--${worst === "info" ? "good" : worst})`,
                  } as CSSProperties)
                : undefined
            }
          >
            {worst ? VERDICTS[worst] : "Waiting for data"}
          </span>
        </Help>
        <span id="assess-time" className="muted">
          {lastTick ? "as of " + clock(lastTick) : ""}
        </span>
      </div>
      <div className="assessment-body">
        <p id="profile" className="profile">
          {profile}
        </p>
        <ul id="findings" className="findings">
          {(all ? ranked : ranked.slice(0, FINDINGS_SHOWN)).map(
            (item, index) => (
              <li
                key={`${String(index)}:${item.title}`}
                className={`finding lvl-${item.level}`}
                {...(item.action && onAction
                  ? {
                      "data-action": "1",
                      tabIndex: 0,
                      onClick: () => {
                        if (item.action) onAction(item.action);
                      },
                      onKeyDown: (event: { key: string }) => {
                        if (event.key === "Enter" && item.action)
                          onAction(item.action);
                      },
                    }
                  : {})}
              >
                <span className="ic" aria-label={item.level}>
                  {LEVEL_ICONS[item.level]}
                </span>
                <Help
                  topic={
                    item.help && isHelpTopicId(item.help)
                      ? item.help
                      : "assessment"
                  }
                  as="div"
                >
                  <div className="t">{item.title}</div>
                  <div className="d">{item.detail}</div>
                </Help>
              </li>
            ),
          )}
        </ul>
        {/* The button stays in place across polls, so it keeps keyboard focus. */}
        {hidden > 0 && (
          <Help topic="assessment">
            <button
              id="findings-more"
              className="findings-more"
              type="button"
              aria-controls="findings"
              aria-expanded={all}
              onClick={() => {
                setAll(!all);
              }}
            >
              {all
                ? "Show fewer findings"
                : `Show ${String(hidden)} more finding${hidden === 1 ? "" : "s"}`}
            </button>
          </Help>
        )}
      </div>
    </div>
  );
}
