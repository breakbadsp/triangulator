import { useEffect, useRef, useState, type CSSProperties } from "react";
import { readTargetControl, type TargetControl } from "../api/targetControl";
import { useTargetControl } from "../hooks/useTargetControl";
import { TargetDialog } from "./TargetDialog";
import { getJson } from "../api/client";
import { parseLive } from "../api/replay";
import type { FleetResponse, LiveResponse } from "../api/types";
import { HelpGuideProvider, PageHelp } from "../help/HelpGuide";
import { Help } from "../help/Help";
import { usePoll } from "../hooks/usePoll";
import {
  fleetCounts,
  fleetQuery,
  targetHref,
  tileModel,
  type TileModel,
} from "../lib/fleet";
import { LEVEL_ICONS } from "../lib/findings";
import { ErrorBanner } from "./ErrorBanner";
import { TopBar } from "./TopBar";
import "./fleet.css";

async function loadFleet(signal: AbortSignal) {
  const [{ list, live }, control] = await Promise.all([
    getJson<FleetResponse>("/api/fleet", signal),
    readTargetControl(signal),
  ]);
  const views = new Map<string, LiveResponse | null>();
  for (const target of list.targets) {
    try {
      views.set(target.key, parseLive(live[target.key]));
    } catch {
      views.set(target.key, null);
    }
  }
  return {
    control,
    targets: list.targets,
    capacity: capacityNotices(list),
    views: views as ReadonlyMap<string, LiveResponse | null>,
    now: Date.now() / 1000,
  };
}

/** Matching processes that a sampler, or the collector, could not admit. */
function capacityNotices(list: FleetResponse["list"]): string[] {
  const excluded = new Map<string, number>();
  for (const target of list.targets)
    if (target.excluded)
      excluded.set(
        target.host,
        Math.max(excluded.get(target.host) ?? 0, target.excluded),
      );
  const notices = [...excluded].map(
    ([host, count]) =>
      `${count >= 255 ? "255 or more" : String(count)} matching processes on ${host} are not monitored: all of its sampler's max_targets slots are in use.`,
  );
  if (
    list.capacity_drops &&
    list.max_targets &&
    list.targets.length >= list.max_targets
  )
    notices.push(
      `The collector is at its limit of ${String(list.max_targets)} targets (max_targets in the collector configuration). Data from further targets is dropped.`,
    );
  return notices;
}

const COUNT_GROUPS = [
  ["critical", "Critical", "var(--critical)"],
  ["serious", "Serious", "var(--serious)"],
  ["warning", "Warning", "var(--warning)"],
  ["good", "Healthy", "var(--good)"],
  ["unknown", "No data", "var(--s-other)"],
] as const;
/** Remove on a tile of the local sampler; never on a remote sampler's. */
function TileRemove({
  tile,
  control,
  editor,
}: {
  tile: TileModel;
  control: TargetControl;
  editor: ReturnType<typeof useTargetControl>;
}) {
  // A blocked Remove explains itself only after a click, not on every tile.
  const [explained, setExplained] = useState(false);
  if (!control.enabled || !tile.local) return null;
  const discovered = tile.discovered;
  if (!discovered) return null;
  const blocked =
    discovered.otherRule || !discovered.rule
      ? "Another rule selects this process (a process pattern, another name after a rename, or the rule that selects its parent), so Remove would not stop it. Edit sampler.toml on the host."
      : "";
  return (
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
        disabled={editor.busy}
        onClick={() => {
          if (blocked) setExplained(true);
          else if (discovered.rule)
            void editor.change({
              action: "remove",
              key: tile.key,
              id: tile.id,
              rule: discovered.rule,
            });
        }}
      >
        Remove
      </button>
      {explained && blocked && (
        <small className="muted" role="status">
          {blocked}
        </small>
      )}
    </Help>
  );
}

export function FleetPage() {
  // The overview is a snapshot, so it may pause in a hidden tab. The target
  // page must not: its charts and findings are built from every 1 Hz reply,
  // and a pause would leave a gap in them.
  const fleet = usePoll(loadFleet, 5000, { pauseWhenHidden: true });
  const control = fleet.data?.control ?? {
    enabled: false as const,
    reason: "",
  };
  const editor = useTargetControl(control, fleet.refresh);
  const [query, setQuery] = useState(
    () => new URLSearchParams(location.search).get("q") ?? "",
  );
  const [focused, setFocused] = useState<{
    key: string;
    model: TileModel;
  } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const tiles = (fleet.data?.targets ?? []).map((target) =>
    focused?.key === target.key
      ? focused.model
      : tileModel(
          target,
          fleet.data?.views.get(target.key),
          fleet.data?.now ?? 0,
        ),
  );
  const counts = fleetCounts(tiles);
  const attention = counts.critical + counts.serious + counts.warning;
  const matchesSearch = (tile: TileModel) =>
    tile.search.includes(query.trim().toLowerCase());
  const shown = tiles.filter(matchesSearch).length;
  const filtered = !!query.trim();
  useEffect(() => {
    document.title =
      (attention ? `(${String(attention)}) ` : "") + "Targets · Thread monitor";
  }, [attention]);

  function changeSearch(next: string) {
    setQuery(next);
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
              value={query}
              onChange={(event) => {
                changeSearch(event.currentTarget.value);
              }}
            />
          </Help>
          {filtered && (
            <Help topic="fleet-filter">
              <button
                id="fleet-clear"
                type="button"
                onClick={() => {
                  changeSearch("");
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
        {fleet.data?.capacity.map((notice) => (
          <Help key={notice} topic="fleet-capacity" as="div">
            <p className="fleet-capacity warn">{notice}</p>
          </Help>
        ))}
        <div id="fleet-grid" className="fleet-grid">
          {tiles.map((tile) => (
            <article
              key={tile.key}
              className="fleet-tile"
              data-level={tile.level}
              data-search={tile.search}
              hidden={!matchesSearch(tile)}
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
                  href={targetHref(tile.key, query)}
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
              {tile.waiting && (
                <Help
                  key={tile.key + "waiting"}
                  topic="fleet-waiting"
                  as="div"
                  className="ft-waiting muted"
                >
                  Waiting for a process named {tile.waiting}
                </Help>
              )}
              <TileRemove tile={tile} control={control} editor={editor} />
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
          {(control.enabled || control.reason) && (
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
                aria-describedby={control.enabled ? undefined : "fleet-add-off"}
                disabled={editor.busy || !control.enabled}
                onClick={() => {
                  editor.open();
                }}
              >
                <span aria-hidden="true">+</span>Add target
              </button>
              {!control.enabled && (
                <small id="fleet-add-off" className="muted">
                  {control.reason} To change a remote sampler, edit sampler.toml
                  on its host.
                </small>
              )}
            </Help>
          )}
        </div>
        {tiles.length > 0 && shown === 0 && (
          <Help topic="fleet-filter" as="div">
            <p id="fleet-none" className="fleet-empty">
              No targets match this search. Clear filters shows every target.
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
