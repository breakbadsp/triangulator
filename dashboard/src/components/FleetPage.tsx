import { useEffect, useRef, useState, type CSSProperties } from "react";
import { readTargetControl } from "../api/targetControl";
import { useTargetControl } from "../hooks/useTargetControl";
import { TargetDialog } from "./TargetDialog";
import { getJson } from "../api/client";
import type { LiveResponse, TargetsResponse } from "../api/types";
import { HelpGuideProvider, PageHelp } from "../help/HelpGuide";
import { Help } from "../help/Help";
import { usePoll } from "../hooks/usePoll";
import {
  FLEET_STATUSES,
  fleetCounts,
  fleetQuery,
  matchesFilter,
  rankTiles,
  targetHref,
  tileModel,
  type FleetFilter,
  type TileModel,
} from "../lib/fleet";
import { LEVEL_ICONS } from "../lib/findings";
import { ErrorBanner } from "./ErrorBanner";
import { TopBar } from "./TopBar";
import "./fleet.css";

async function loadFleet(signal: AbortSignal) {
  const [{ targets }, control] = await Promise.all([
    getJson<TargetsResponse>("/api/targets", signal),
    readTargetControl(signal),
  ]);
  const views = new Map<string, LiveResponse | null>();
  let next = 0;
  async function worker() {
    while (next < targets.length && !document.hidden && !signal.aborted) {
      const target = targets[next++];
      if (!target) return;
      try {
        views.set(
          target.key,
          await getJson<LiveResponse>(
            "/api/live?" +
              new URLSearchParams({ target: target.key }).toString(),
            signal,
          ),
        );
      } catch {
        views.set(target.key, null);
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(4, targets.length) }, worker),
  );
  return {
    control,
    targets,
    views: views as ReadonlyMap<string, LiveResponse | null>,
    now: Date.now() / 1000,
  };
}

function readFilter(): FleetFilter {
  const query = new URLSearchParams(location.search);
  const status =
    FLEET_STATUSES.find((value) => value === query.get("status")) ?? "";
  return { q: query.get("q") ?? "", status };
}
const DENSITY_KEY = "triangulator:fleet-density";
type Density = "comfortable" | "compact";
function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === "compact"
      ? "compact"
      : "comfortable";
  } catch {
    return "comfortable";
  }
}
const COUNT_GROUPS = [
  ["critical", "Critical", "var(--critical)"],
  ["serious", "Serious", "var(--serious)"],
  ["warning", "Warning", "var(--warning)"],
  ["good", "Healthy", "var(--good)"],
  ["unknown", "No data", "var(--s-other)"],
] as const;
const STATUS_LABELS = [
  "Needs attention",
  "Critical",
  "Serious",
  "Warning",
  "Healthy",
  "No data",
];

export function FleetPage() {
  const fleet = usePoll(loadFleet, 5000, { pauseWhenHidden: true });
  const control = fleet.data?.control ?? { enabled: false as const };
  const editor = useTargetControl(control, fleet.refresh);
  const [filter, setFilter] = useState(readFilter);
  const [density, setDensity] = useState(readDensity);
  const [focused, setFocused] = useState<{
    key: string;
    model: TileModel;
  } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const tiles = rankTiles(
    (fleet.data?.targets ?? []).map((target) =>
      focused?.key === target.key
        ? focused.model
        : tileModel(
            target,
            fleet.data?.views.get(target.key),
            fleet.data?.now ?? 0,
          ),
    ),
  );
  const counts = fleetCounts(tiles);
  const attention = counts.critical + counts.serious + counts.warning;
  const shown = tiles.filter((tile) => matchesFilter(tile, filter)).length;
  const filtered = !!filter.q.trim() || !!filter.status;
  useEffect(() => {
    document.title =
      (attention ? `(${String(attention)}) ` : "") + "Targets · Thread monitor";
  }, [attention]);

  function changeFilter(next: FleetFilter) {
    setFilter(next);
    const query = fleetQuery(next).toString();
    history.replaceState(
      null,
      "",
      location.pathname + (query ? "?" + query : ""),
    );
  }
  return (
    <HelpGuideProvider>
      <header className="topbar">
        <TopBar page={{ kind: "fleet" }} targets={fleet.data?.targets ?? []} />
      </header>
      <ErrorBanner error={fleet.error} />
      <main id="fleet" aria-labelledby="fleet-title">
        <div className="fleet-head">
          <Help topic="fleet" as="div">
            <h2 id="fleet-title">Targets</h2>
            <p>
              Every monitored process and its current assessment. Select a tile
              to open its dashboard.
            </p>
          </Help>
          {tiles.length > 0 && (
            <Help topic="fleet" as="div">
              <div
                id="fleet-counts"
                className="fleet-counts"
                aria-live="polite"
              >
                <small>Totals for all targets</small>
                {COUNT_GROUPS.map(([level, label, color]) => {
                  const count =
                    counts[level] + (level === "good" ? counts.info : 0);
                  return count ? (
                    <span
                      key={level}
                      style={{ "--lvl": color } as CSSProperties}
                    >
                      <b>{count}</b> {label}
                    </span>
                  ) : null;
                })}
              </div>
            </Help>
          )}
        </div>
        <div className="toolbar fleet-toolbar">
          <Help topic="fleet-filter">
            <input
              ref={search}
              id="fleet-search"
              type="search"
              placeholder="Name, host or target ID"
              aria-label="Find target"
              value={filter.q}
              onChange={(event) => {
                changeFilter({ ...filter, q: event.currentTarget.value });
              }}
            />
          </Help>
          <Help topic="fleet-filter">
            <label>
              Status
              <select
                id="fleet-level"
                aria-label="Assessment status"
                value={filter.status}
                onChange={(event) => {
                  changeFilter({
                    ...filter,
                    status:
                      FLEET_STATUSES.find(
                        (value) => value === event.currentTarget.value,
                      ) ?? "",
                  });
                }}
              >
                <option value="">All</option>
                {FLEET_STATUSES.map((status, index) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[index]}
                  </option>
                ))}
              </select>
            </label>
          </Help>
          <Help topic="fleet-density">
            <label>
              Tiles
              <select
                id="fleet-density"
                aria-label="Tile density"
                value={density}
                onChange={(event) => {
                  const next =
                    event.currentTarget.value === "compact"
                      ? "compact"
                      : "comfortable";
                  setDensity(next);
                  try {
                    localStorage.setItem(DENSITY_KEY, next);
                  } catch {
                    /* Keep the selection until reload when storage is blocked. */
                  }
                }}
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </label>
          </Help>
          {filtered && (
            <Help topic="fleet-filter">
              <button
                id="fleet-clear"
                type="button"
                onClick={() => {
                  changeFilter({ q: "", status: "" });
                  search.current?.focus();
                }}
              >
                Clear filters
              </button>
            </Help>
          )}
          {tiles.length > 0 && (
            <Help topic="fleet-filter">
              <span id="fleet-shown" className="muted" aria-live="polite">
                Showing {shown} of {tiles.length} targets
              </span>
            </Help>
          )}
        </div>
        <Help topic="manage-targets" as="div">
          <p
            id="fleet-status"
            role="status"
            className={(editor.form.bad ? "bad" : "muted") + " fleet-status"}
          >
            {editor.form.status}
          </p>
        </Help>
        {/* React DOM puts focus back on a focused tile link that a reorder moves
            (restoreSelection after each commit); tests/prove_dashboard.mjs checks it in Chromium. */}
        <div id="fleet-grid" className="fleet-grid" data-density={density}>
          {tiles.map((tile) => (
            <article
              key={tile.key}
              className="fleet-tile"
              data-level={tile.level}
              data-search={tile.search}
              hidden={!matchesFilter(tile, filter)}
              onFocus={() => {
                setFocused({ key: tile.key, model: tile });
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget))
                  setFocused(null);
              }}
            >
              <div className="ft-top">
                <span
                  className="status-dot ft-assessment"
                  role="img"
                  aria-label={"Assessment: " + tile.verdict}
                  title={tile.verdict}
                />
                <a
                  className="ft-name"
                  href={targetHref(tile.key, filter)}
                  title={tile.name}
                  aria-label={`${tile.name}, ${tile.host} · ${tile.id}: ${tile.level === "unknown" ? "no data" : tile.verdict}. Open its dashboard.`}
                >
                  {tile.name}
                </a>
              </div>
              <Help
                key={tile.key + "identity"}
                topic="fleet-tile"
                as="div"
                className="ft-key"
              >
                {tile.host} · {tile.id}
              </Help>
              {control.enabled &&
                tile.host === control.host &&
                control.targets?.find((entry) => entry.id === tile.id) && (
                  <Help
                    key={tile.key + "remove"}
                    topic="manage-targets"
                    as="div"
                    className="ft-foot"
                  >
                    <button
                      className="ft-remove"
                      type="button"
                      aria-label={"Remove target " + tile.id}
                      disabled={editor.busy || control.targets.length <= 1}
                      onClick={() => {
                        const managed = control.targets?.find(
                          (entry) => entry.id === tile.id,
                        );
                        if (managed)
                          void editor.change({ action: "remove", ...managed });
                      }}
                    >
                      Remove
                    </button>
                  </Help>
                )}
              {tile.card && (
                <div className="ft-card">
                  <div className="ft-proc">{tile.card.proc}</div>
                  <ul>
                    {tile.card.findings.map((item, index) => (
                      <li key={index} className={"lvl-" + item.level}>
                        <span className="ic">{LEVEL_ICONS[item.level]}</span>
                        <div>
                          {item.title}
                          {item.detail && <small>{item.detail}</small>}
                        </div>
                      </li>
                    ))}
                  </ul>
                  {tile.card.more > 0 && (
                    <div className="ft-more">
                      {tile.card.more} more finding
                      {tile.card.more > 1 ? "s" : ""} on the dashboard
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}
          {control.enabled && (
            <Help
              key="fleet-add"
              topic="manage-targets"
              as="div"
              className="fleet-add-help"
            >
              <button
                id="fleet-add"
                className="fleet-add"
                type="button"
                aria-haspopup="dialog"
                disabled={editor.busy}
                onClick={() => {
                  editor.open();
                }}
              >
                <span aria-hidden="true">+</span>Add target
              </button>
            </Help>
          )}
        </div>
        {tiles.length > 0 && shown === 0 && (
          <Help topic="fleet-filter" as="div">
            <p id="fleet-none" className="fleet-empty">
              No targets match this search and status. Clear filters shows every
              target.
            </p>
          </Help>
        )}
        {fleet.data && tiles.length === 0 && (
          <Help topic="fleet" as="div">
            <p id="fleet-empty" className="fleet-empty">
              No targets yet. A target appears here when its sampler sends its
              first data to this collector.
            </p>
          </Help>
        )}
        <PageHelp />
      </main>
      {editor.form.open && (
        <TargetDialog
          key={editor.form.generation}
          editor={editor}
          enabled={control.enabled}
        />
      )}
    </HelpGuideProvider>
  );
}
