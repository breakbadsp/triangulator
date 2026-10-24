import { useMemo, useState, type CSSProperties, type MouseEvent } from "react";
import type { LiveResponse, MemorySummary, PressureScope } from "../api/types";
import { Help } from "../help/Help";
import type { HelpTopicId } from "../help/topics";
import { useHeld, useHolding } from "../hooks/useHeld";
import { useReadout } from "../hooks/useReadout";
import { memoryFaultRate } from "../lib/assess/index";
import {
  assessMemory,
  rssTrend,
  type ResourcePoint,
} from "../lib/assess/memory";
import { wantsFold, type Finding } from "../lib/findings";
import {
  displaySpan,
  hex,
  kindColor,
  memoryCharts,
  memoryFacts,
  memoryGrid,
  memoryLimits,
  memoryMapItems,
  memoryModel,
  memoryNotes,
  memoryPerms,
  memoryGrows,
  memoryRegionCount,
  memoryRegionRows,
  memoryRowName,
  memorySubtitle,
  memoryTiles,
  memoryZoomFacts,
  type MemoryAction,
  type MemoryChart,
  type MemoryState,
} from "../lib/memoryView";
import type { Series } from "../lib/series";
import { Fold } from "./Fold";
import { Meter } from "./Resources";
import "./memory.css";

const DEFAULT_SUB =
  "The target's virtual address space: how much is mapped, how close it is to its limits, and what each region holds.";
const TOPICS: Readonly<Record<string, HelpTopicId>> = {
  "Virtual size (VmSize)": "vmsize",
  "Resident (RSS)": "rss",
  "Anonymous / file / shared": "memkinds",
  "Mappings (VMAs)": "vmas",
  "Major faults": "faults",
  "Memory pressure (PSI some)": "pressure",
  Mappings: "vmas",
  "Address space": "aslimit",
  "Main stack": "stack",
  "Peak virtual size": "vmsize",
  "Data + heap (VmData)": "vmdata",
  "Page faults since start": "faulttotals",
  "Regions / VMAs": "vmas",
  "Share of VmSize": "vmsize",
  "Largest unmapped gap": "memgap",
  "Heap mapping size change": "heap",
  "Stack mapping size change": "stack",
  "Heap mapping end ↑": "heapend",
  "Main stack start ↓": "stackstart",
  "Resident anonymous": "anonres",
};
// Labels with no topic of their own fall back to the card's topic, as the
// old page did.
const topicOf = (label: string, card: HelpTopicId) => TOPICS[label] ?? card;
const LEVEL_NAMES = {
  critical: "critical",
  serious: "serious",
  warning: "warning",
  info: "notice",
  good: "ok",
} as const;

/**
 * The Memory map section. The parts that hold values of one process (hover
 * snapshots, readouts, and their help cards) are keyed by the state's key,
 * so a new target, session, or PID remounts them. The fold and the member
 * regions disclosure are owned here, above that key, so they stay open.
 */
export function MemoryMap({
  view,
  now,
  memory,
  dispatch,
  series,
  resourcePoints,
  scope,
}: {
  view: LiveResponse | undefined;
  now: number;
  memory: MemoryState;
  dispatch: (action: MemoryAction) => void;
  series: Series;
  resourcePoints: readonly ResourcePoint[];
  scope: PressureScope;
}) {
  const [regionsOpen, setRegionsOpen] = useState(false);
  const model = useMemo(() => memoryModel(memory), [memory]);
  const m = view?.memory,
    available = !!m?.available;
  const faults = memoryFaultRate({
    series,
    mode: { kind: "live" },
    memoryHistory: memory.history,
  });
  const trend = view ? rssTrend(view, resourcePoints, now) : null;
  const findings =
    view && m?.available
      ? assessMemory(
          m,
          model.regions,
          view.resources?.available ? view.resources : null,
          faults,
          trend,
          scope,
        )
      : [];
  return (
    <section id="memory-map" className="block">
      <div className="section-head">
        <div>
          <Help topic="memmap" as="div">
            <h2>Memory map</h2>
          </Help>
          <p id="memory-sub">
            {m?.available ? memorySubtitle(m, now) : DEFAULT_SUB}
          </p>
        </div>
      </div>
      <p id="memory-empty" className="socket-empty" hidden={available}>
        {available
          ? ""
          : m?.reason || "This collector does not report memory-map samples."}
      </p>
      <div id="memory-content" hidden={!available}>
        {view && m?.available && (
          <MemoryOverview
            key={memory.key}
            m={m}
            tiles={memoryTiles(
              m,
              view.resources,
              trend,
              faults,
              series.points,
              scope,
            )}
            findings={findings}
            stack={model.regions.find((region) => region.cat === "stack")}
            notes={memoryNotes(m, model.layout, model.regions.length)}
          />
        )}
        <Fold
          name="memory"
          className="fold memory-fold"
          summaryClassName="fold-summary fold-bar"
          autoOpen={wantsFold(findings, "memory")}
          summary={
            <Help topic="amap">
              <h3>Address space &amp; zoom</h3>
              <span className="muted">Every mapping, and a zoom into one</span>
            </Help>
          }
        >
          {m?.available && (
            <MemoryZoomArea
              key={memory.key}
              m={m}
              now={now}
              memory={memory}
              model={model}
              dispatch={dispatch}
              regionsOpen={regionsOpen}
              onRegionsOpen={setRegionsOpen}
            />
          )}
        </Fold>
      </div>
    </section>
  );
}

function MemoryOverview({
  m,
  tiles,
  findings,
  stack,
  notes,
}: {
  m: MemorySummary;
  tiles: ReturnType<typeof memoryTiles>;
  findings: readonly Finding[];
  stack: Parameters<typeof memoryLimits>[1];
  notes: string;
}) {
  const tileHold = useHolding(),
    findingHold = useHolding(),
    limitHold = useHolding();
  const shownTiles = useHeld(tiles, tileHold.holding);
  const shownFindings = useHeld(findings, findingHold.holding);
  const limits = useHeld(
    { meters: memoryLimits(m, stack), facts: memoryFacts(m) },
    limitHold.holding,
  );
  return (
    <>
      <div
        id="memory-tiles"
        className="tiles memory-tiles"
        {...tileHold.handlers}
      >
        {shownTiles.map(([label, value, sub, bad]) => (
          <div key={label} className="card tile">
            <Help topic={topicOf(label, "memmap")} as="div" className="label">
              {label}
            </Help>
            <div className="value">{value}</div>
            <div className={bad ? "sub bad" : "sub"}>{sub}</div>
          </div>
        ))}
      </div>
      <div className="grid g-1-1 memory-cards">
        <div className="card">
          <div className="card-head">
            <div>
              <Help topic="memfindings" as="div">
                <h3>Findings</h3>
              </Help>
              <p>
                Worked out in the browser from the latest memory-map, resource
                and thread samples.
              </p>
            </div>
          </div>
          <div {...findingHold.handlers}>
            <Help topic="memfindings" as="div">
              <ul id="memory-findings" className="mem-findings">
                {shownFindings.map((item) => (
                  <li
                    key={`${item.level}|${item.title}`}
                    className="mem-finding"
                    style={
                      {
                        "--lvl": `var(--${item.level === "info" ? "accent" : item.level})`,
                      } as CSSProperties
                    }
                  >
                    <span
                      className={
                        item.level === "warning" || item.level === "serious"
                          ? "sev dark"
                          : "sev"
                      }
                    >
                      {LEVEL_NAMES[item.level]}
                    </span>
                    <div>
                      <div className="t">{item.title}</div>
                      <div className="d">{item.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Help>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <Help topic="memlimits" as="div">
                <h3>Limits &amp; headroom</h3>
              </Help>
              <p>
                Limits that make mmap, malloc or thread creation fail, or stop
                the main stack from growing.
              </p>
            </div>
          </div>
          <div {...limitHold.handlers}>
            <div id="memory-limits">
              {limits.meters.map((meter) => (
                <Meter
                  key={meter.label}
                  label={meter.label}
                  topic={topicOf(meter.label, "memlimits")}
                  sub={meter.sub}
                  value={meter.value}
                  max={meter.max}
                  text={meter.text}
                />
              ))}
            </div>
            <dl id="memory-facts" className="facts">
              {limits.facts.map(([label, value]) => (
                <Help key={label} topic={topicOf(label, "memlimits")} as="div">
                  <dt className="help-fact">{label}</dt>
                  <dd>{value}</dd>
                </Help>
              ))}
            </dl>
          </div>
          <p id="memory-notes" className="socket-note">
            {notes}
          </p>
        </div>
      </div>
    </>
  );
}

type Model = ReturnType<typeof memoryModel>;
const LEGEND = [
  ["var(--k-code)", "program / library code"],
  ["var(--k-heap)", "heap (brk)"],
  ["var(--k-anon)", "anonymous (arenas, mmap)"],
  ["var(--k-stack)", "stack"],
  ["var(--k-file)", "file mapping"],
  ["var(--k-guard)", "guard (no access)"],
  ["var(--k-kernel)", "kernel"],
] as const;

function MemoryZoomArea({
  m,
  now,
  memory,
  model,
  dispatch,
  regionsOpen,
  onRegionsOpen,
}: {
  m: MemorySummary;
  now: number;
  memory: MemoryState;
  model: Model;
  dispatch: (action: MemoryAction) => void;
  regionsOpen: boolean;
  onRegionsOpen: (open: boolean) => void;
}) {
  const stamp = m.updated ?? now;
  return (
    <div className="grid g-mem">
      <AddressMap
        model={model}
        selected={memory.selected}
        now={now}
        stamp={stamp}
        onSelect={(row) => {
          dispatch({ type: "select", row });
        }}
      />
      <Zoom
        m={m}
        memory={memory}
        model={model}
        stamp={stamp}
        regionsOpen={regionsOpen}
        onRegionsOpen={onRegionsOpen}
      />
    </div>
  );
}

function AddressMap({
  model,
  selected,
  now,
  stamp,
  onSelect,
}: {
  model: Model;
  selected: string | null;
  now: number;
  stamp: number;
  onSelect: (row: string) => void;
}) {
  const hold = useHolding();
  const { readout, show, clear } = useReadout();
  // The map holds still under the pointer, as the old page skipped its
  // rebuild while hovered. The selection is live, so a click still selects.
  // An empty map has nothing to hold: the first layout shows at once.
  const shown = useHeld(
    {
      items: model.rows.length ? memoryMapItems(model.rows) : null,
      layoutId: model.layout?.id ?? "",
      count: memoryRegionCount(model.layout, model.regions.length, now),
    },
    hold.holding && model.rows.length > 0,
  );
  return (
    <div className="card" {...hold.handlers}>
      <div className="card-head">
        <div>
          <Help topic="amap" as="div">
            <h3>
              Address space{" "}
              <span
                id="memory-region-count"
                className="muted"
                style={{ fontWeight: 400 }}
              >
                {shown.count}
              </span>
            </h3>
          </Help>
          <p>
            High addresses at the top. Unmapped spaces between mappings are
            shortened.
          </p>
        </div>
      </div>
      <Help topic="amap" as="div" readout={readout ?? undefined}>
        <div id="memory-amap" className="amap">
          {shown.items ? (
            shown.items.map((item, index) =>
              item.gap ? (
                <GapRow key={`gap|${String(index)}`} text={item.text} />
              ) : (
                <BarRow
                  key={item.bar.key}
                  item={item}
                  pressed={item.bar.key === selected}
                  onSelect={onSelect}
                  onMove={(event) => {
                    show(
                      event,
                      `bar|${shown.layoutId}|${item.bar.key}`,
                      item.name,
                      [
                        {
                          color: item.color,
                          value: item.range,
                          label: "Addresses",
                        },
                        {
                          color: item.color,
                          value: item.members,
                          label: "Mappings",
                        },
                      ],
                      stamp,
                    );
                  }}
                  onLeave={clear}
                />
              ),
            )
          ) : (
            <p className="muted">
              No layout yet. It arrives with the next memory-map sample.
            </p>
          )}
        </div>
      </Help>
      <Help topic="amap" as="div">
        <div className="legend">
          {LEGEND.map(([color, label]) => (
            <span key={label}>
              <i className="sw" style={{ background: color }} />
              {label}
            </span>
          ))}
        </div>
      </Help>
      <p className="mem-hint">
        The darker part of a bar is its size on a log scale, from 4 KB to the
        largest bar. Adjacent mappings of the same kind are joined into one bar.
        Mapped is not resident: a bar can be large and use little RAM. Click a
        bar to zoom.
      </p>
    </div>
  );
}
function GapRow({ text }: { text: string }) {
  return (
    <>
      <div className="addr">⋮</div>
      <div className="agap">{text}</div>
    </>
  );
}
function BarRow({
  item,
  pressed,
  onSelect,
  onMove,
  onLeave,
}: {
  item: Extract<ReturnType<typeof memoryMapItems>[number], { gap: false }>;
  pressed: boolean;
  onSelect: (row: string) => void;
  onMove: (event: MouseEvent) => void;
  onLeave: () => void;
}) {
  return (
    <>
      <div className="addr">{item.address}</div>
      <button
        type="button"
        className={item.onDark ? "arow on-dark" : "arow"}
        style={
          {
            "--kind": item.color,
            height: `${String(item.height)}px`,
          } as CSSProperties
        }
        aria-pressed={pressed}
        onClick={() => {
          onSelect(item.bar.key);
        }}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      >
        <div className="band" style={{ width: item.band }} />
        <span className="name">{item.name}</span>
        <span className="meta">{item.meta}</span>
      </button>
    </>
  );
}

function Zoom({
  m,
  memory,
  model,
  stamp,
  regionsOpen,
  onRegionsOpen,
}: {
  m: MemorySummary;
  memory: MemoryState;
  model: Model;
  stamp: number;
  regionsOpen: boolean;
  onRegionsOpen: (open: boolean) => void;
}) {
  const hold = useHolding();
  const grid = useReadout(),
    regions = useReadout();
  const row = model.selected;
  const display = row
    ? displaySpan(row, memory.heapSpan, model.complete)
    : null;
  // The zoom holds still while the pointer or focus is in it, as the old page
  // skipped the zoom rebuild while its help was open. With no selection it
  // has nothing to hold.
  const shown = useHeld(
    {
      row,
      layoutId: model.layout?.id ?? "",
      facts: row
        ? memoryZoomFacts(row, m, model.complete, memory.history, memory.page)
        : [],
      grid:
        row && display
          ? memoryGrid(
              row,
              display,
              model.regions,
              memory.previous,
              model.complete,
              memory.page,
            )
          : null,
      displayLo: display?.lo ?? 0n,
      charts: memoryCharts(memory.history, model.complete),
      members: row ? memoryRegionRows(row) : [],
    },
    hold.holding && !!row,
  );
  const shownRow = shown.row;
  return (
    <div className="grid">
      <div className="card" {...hold.handlers}>
        <div className="card-head">
          <div>
            <Help topic="memzoom" as="div">
              <h3>
                Zoom:{" "}
                <code id="memory-zoom-name">
                  {shownRow ? memoryRowName(shownRow) : "—"}
                </code>
              </h3>
            </Help>
            <p id="memory-zoom-sub" className="mono">
              {shownRow
                ? `${hex(shownRow.lo)} – ${hex(shownRow.hi)} · ${memoryPerms(shownRow)}${memoryGrows(shownRow.cat)}`
                : ""}
            </p>
          </div>
        </div>
        <dl id="memory-zoom-facts" className="facts four">
          {shown.facts.map(([label, value]) => (
            <Help key={label} topic={topicOf(label, "memzoom")} as="div">
              <dt className="help-fact">{label}</dt>
              <dd>{value}</dd>
            </Help>
          ))}
        </dl>
        <p
          id="memory-grid-caption"
          className="muted"
          style={{ fontSize: 12, margin: "14px 0 6px" }}
        >
          {shown.grid ? shown.grid.caption : "No layout yet."}
          {shown.grid?.margin && (
            <>
              <br />
              <Help topic="heapmargin">Heap display margin</Help>
              <span>{shown.grid.margin}</span>
            </>
          )}
        </p>
        {shown.grid && shownRow && (
          <Help topic="memzoom" as="div" readout={grid.readout ?? undefined}>
            <div
              id="memory-grid"
              className="pagegrid"
              onMouseLeave={grid.clear}
            >
              {shown.grid.cells.map((cell, index) => {
                const key = String(index);
                if (cell.kind === "pad") return <i key={key} className="pad" />;
                const region = cell.kind === "region";
                return (
                  <i
                    key={key}
                    className={
                      region
                        ? [
                            cell.cat === "guard" ? "cell-guard" : "",
                            cell.isNew ? "cell-new" : "",
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined
                        : `cell-${cell.kind}`
                    }
                    style={
                      region
                        ? ({ "--kind": kindColor(cell.cat) } as CSSProperties)
                        : undefined
                    }
                    onMouseMove={(event) => {
                      grid.show(
                        event,
                        `cell|${shown.layoutId}|${shownRow.key}|${String(shown.displayLo)}|${key}`,
                        region ? cell.name : cell.label,
                        region
                          ? [
                              {
                                color: kindColor(cell.cat),
                                value: cell.address,
                                label: "Address",
                              },
                            ]
                          : [],
                        stamp,
                      );
                    }}
                  />
                );
              })}
            </div>
          </Help>
        )}
        <Help topic="memzoom" as="div">
          <div id="memory-grid-legend" className="legend">
            {shown.grid?.legend.map((item) => (
              <span key={item.label}>
                <i
                  className={`sw ${item.className}`}
                  style={item.color ? { background: item.color } : undefined}
                />
                {item.label}
              </span>
            ))}
          </div>
        </Help>
        <p className="mem-hint">Cells show mappings, not resident pages.</p>
        <div id="memory-charts" className="mem-charts">
          {shown.charts.map((chart) => (
            <ZoomChart key={chart.title} chart={chart} />
          ))}
        </div>
        <p className="mem-hint">
          Boundary offsets start at the first available sample. History covers
          up to 15 minutes.
        </p>
        <p className="mem-hint">
          <Help topic="threadstacks">Thread stacks</Help> can keep a fixed
          reserved size while residency changes.
        </p>
        <details
          id="memory-region-details"
          open={regionsOpen}
          onToggle={(event) => {
            onRegionsOpen(event.currentTarget.open);
          }}
        >
          <summary id="memory-regions-summary" className="help-label">
            <Help topic="memregions">Member regions</Help>
          </summary>
          <div className="table-wrap" style={{ maxHeight: 260, marginTop: 12 }}>
            <table>
              <thead>
                <tr>
                  <th>
                    <Help topic="memregions">Region</Help>
                  </th>
                  <th>
                    <Help topic="memregions">Start</Help>
                  </th>
                  <th className="num">
                    <Help topic="memregions">Size</Help>
                  </th>
                  <th>
                    <Help topic="memregions">Perms</Help>
                  </th>
                  <th className="num">
                    <Help topic="vmas">VMAs</Help>
                  </th>
                </tr>
              </thead>
              <Help
                topic="memregions"
                as="tbody"
                id="memory-regions"
                readout={regions.readout ?? undefined}
              >
                {shown.members.map((item) => (
                  <tr key={item.key}>
                    <td
                      onMouseMove={(event) => {
                        if (shownRow && item.path)
                          regions.show(
                            event,
                            `region|${shownRow.key}|${item.start}|name`,
                            item.path,
                            [],
                            stamp,
                          );
                      }}
                      onMouseLeave={regions.clear}
                    >
                      {item.name}
                    </td>
                    <td className="mono">{item.start}</td>
                    <td className="num">{item.size}</td>
                    <td className="mono">{item.permissions}</td>
                    <td className="num">{item.vmas}</td>
                  </tr>
                ))}
              </Help>
            </table>
          </div>
        </details>
      </div>
    </div>
  );
}

const CHART_WIDTH = 300,
  CHART_HEIGHT = 84;
function ZoomChart({ chart }: { chart: MemoryChart }) {
  return (
    <div className="mem-chart">
      <div className="cap">
        <Help topic={topicOf(chart.title, "memzoom")} as="div">
          <h3>{chart.title}</h3>
        </Help>
        <span>{chart.trend}</span>
      </div>
      {"empty" in chart ? (
        <div className="chart-empty" style={{ height: CHART_HEIGHT }}>
          {chart.empty}
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${chart.title}: ${chart.range}`}
          >
            {chart.lines.map((line) => (
              <polyline
                key={line.points}
                points={line.points}
                fill="none"
                stroke={chart.color}
                strokeWidth={line.dot ? 5 : 2}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </svg>
          <div className="range">{chart.range}</div>
        </>
      )}
    </div>
  );
}
