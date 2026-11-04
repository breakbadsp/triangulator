import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  changeTargets,
  readTargetControl,
  type TargetControl,
} from "../api/targetControl";
import { useTargetControl } from "../hooks/useTargetControl";
import { TargetDialog } from "./TargetDialog";
import { getJson } from "../api/client";
import { readTileOrder, saveTileOrder } from "../api/fleetOrder";
import { lastTarget } from "../api/viewStorage";
import { appendToSavedSeries } from "../hooks/useObservation";
import { parseLive } from "../api/replay";
import type { FleetResponse, LiveResponse } from "../api/types";
import { HelpGuideProvider } from "../help/HelpGuide";
import { Help } from "../help/Help";
import { usePoll } from "../hooks/usePoll";
import {
  fleetCounts,
  fleetQuery,
  mergeOrder,
  moveKey,
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
    if (!target.archived && target.excluded)
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
    list.targets.filter((target) => !target.archived).length >= list.max_targets
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
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  if (!control.enabled || !tile.local) return null;
  const discovered = tile.discovered;
  if (!discovered) return null;
  const blocked =
    discovered.otherRule || !discovered.rule
      ? "Another rule selects this process (a process pattern, or another name after a rename), so Remove would not stop it. Edit sampler.toml on the host."
      : "";
  return (
    <div key={tile.key + "remove"} className="ft-foot">
      <button
        className="ft-remove"
        type="button"
        aria-label={"Remove target " + tile.id}
        disabled={editor.busy}
        onClick={() => {
          if (blocked) {
            clearTimeout(timer.current);
            setExplained(true);
            timer.current = setTimeout(() => {
              setExplained(false);
            }, 5000);
          } else if (discovered.rule)
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
    </div>
  );
}

function RemoveRetained({
  tile,
  refresh,
}: {
  tile: TileModel;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const session = tile.archivedSession;
  if (!tile.archived) return null;
  async function remove() {
    if (busy || !session) return;
    setBusy(true);
    setError("");
    const result = await changeTargets({
      action: "forget",
      key: tile.key,
      session,
    });
    if (result.kind === "done") refresh();
    else setError(result.message);
    setBusy(false);
  }
  return (
    <div className="ft-foot">
      <button
        type="button"
        className="ft-remove"
        disabled={busy || !session}
        aria-label={"Remove retained target " + tile.id}
        onClick={() => {
          void remove();
        }}
      >
        Remove from Targets
      </button>
      {error && (
        <small className="bad" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}

/** Alt plus an arrow key moves a tile: -1 is earlier, 1 is later. */
function moveStep(event: KeyboardEvent): -1 | 0 | 1 {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return 0;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") return -1;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") return 1;
  return 0;
}

const loadLastTarget = async (signal: AbortSignal) => {
  const target = lastTarget();
  if (!target) return null;
  const view = parseLive(
    await getJson<unknown>(
      `/api/live?${new URLSearchParams({ target })}`,
      signal,
    ),
  );
  appendToSavedSeries(target, view);
  return view;
};

export function FleetPage() {
  // The target page was left a moment ago. Keep its series growing, at its
  // own 1 Hz rate and also in a hidden tab, so its charts have no gap when the
  // page returns. Other targets still have a gap.
  usePoll(loadLastTarget, 1000);
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
  const [savedOrder, setSavedOrder] = useState(readTileOrder);
  const [dragging, setDragging] = useState<string | null>(null);
  const [inactiveOpen, setInactiveOpen] = useState(() => !!query.trim());
  const [announcement, setAnnouncement] = useState("");
  const refocus = useRef<string | null>(null);
  const modelled = (fleet.data?.targets ?? []).map((target) =>
    focused?.key === target.key
      ? focused.model
      : tileModel(
          target,
          fleet.data?.views.get(target.key),
          fleet.data?.now ?? 0,
        ),
  );
  const rank = new Map(
    mergeOrder(
      savedOrder,
      modelled.map((tile) => tile.key),
    ).map((key, index) => [key, index]),
  );
  const tiles = [...modelled].sort(
    (a, b) => (rank.get(a.key) ?? 0) - (rank.get(b.key) ?? 0),
  );
  const active = tiles.filter((tile) => !tile.inactive);
  const inactive = tiles.filter((tile) => tile.inactive);
  const counts = fleetCounts(active);
  const attention = counts.critical + counts.serious + counts.warning;
  const matchesSearch = (tile: TileModel) =>
    tile.search.includes(query.trim().toLowerCase());
  const shown = tiles.filter(matchesSearch).length;
  const filtered = !!query.trim();
  const inactiveShown = inactive.filter(matchesSearch).length;
  // A moved element can lose focus, so the moved tile takes it back.
  useEffect(() => {
    const key = refocus.current;
    refocus.current = null;
    if (key === null) return;
    const tile = [
      ...document.querySelectorAll<HTMLElement>(".fleet-grid > article"),
    ].find((element) => element.dataset.key === key);
    tile?.querySelector<HTMLElement>(".ft-name")?.focus();
  }, [savedOrder]);
  useEffect(() => {
    document.title =
      (attention ? `(${String(attention)}) ` : "") + "Targets · Thread monitor";
  }, [attention]);

  /** Puts a tile at the place of another. Hidden tiles keep their places. */
  function move(tile: TileModel, to: TileModel) {
    const next = moveKey(
      tiles.map((item) => item.key),
      tile.key,
      to.key,
    );
    const visible = next.filter((key) =>
      tiles.some(
        (item) =>
          item.key === key &&
          item.inactive === tile.inactive &&
          matchesSearch(item),
      ),
    );
    setSavedOrder(next);
    saveTileOrder(next);
    setAnnouncement(
      `Moved ${tile.name} to position ${String(visible.indexOf(tile.key) + 1)} of ${String(visible.length)}.`,
    );
  }
  function keyMove(event: KeyboardEvent, tile: TileModel) {
    const step = moveStep(event);
    if (!step) return;
    event.preventDefault();
    const visible = tiles.filter(
      (item) => item.inactive === tile.inactive && matchesSearch(item),
    );
    const at = visible.indexOf(tile) + step;
    const neighbour = at < 0 ? undefined : visible.at(at);
    if (neighbour) {
      refocus.current = tile.key;
      move(tile, neighbour);
    } else
      setAnnouncement(
        `${tile.name} is already ${step < 0 ? "first" : "last"}.`,
      );
  }
  function changeSearch(next: string) {
    setQuery(next);
    setInactiveOpen(!!next.trim());
    const query = fleetQuery(next).toString();
    history.replaceState(
      null,
      "",
      location.pathname + (query ? "?" + query : ""),
    );
  }
  const renderTile = (tile: TileModel) => (
    <article
      key={tile.key}
      className={"fleet-tile" + (dragging === tile.key ? " dragging" : "")}
      data-key={tile.key}
      data-level={tile.level}
      hidden={!matchesSearch(tile)}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", tile.key);
        setDragging(tile.key);
      }}
      onDragOver={(event) => {
        if (dragging !== null) event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        const from = tiles.find((item) => item.key === dragging);
        setDragging(null);
        if (from && from !== tile && from.inactive === tile.inactive)
          move(from, tile);
      }}
      onDragEnd={() => {
        setDragging(null);
      }}
      onKeyDown={(event) => {
        keyMove(event, tile);
      }}
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
          draggable={false}
          aria-describedby="fleet-order-hint"
          aria-label={`${tile.name}, ${tile.host} · ${tile.id}: ${tile.level === "unknown" && !tile.archived ? "no data" : tile.verdict}. Open its dashboard.`}
        >
          {tile.name}
        </a>
      </div>
      <div key={tile.key + "identity"} className="ft-key">
        {tile.host} · {tile.id}
      </div>
      {tile.archived && (
        <div className="ft-waiting muted">No longer monitored · Final data</div>
      )}
      {tile.waiting && (
        <div key={tile.key + "waiting"} className="ft-waiting muted">
          Waiting for a process named {tile.waiting}
        </div>
      )}
      <TileRemove tile={tile} control={control} editor={editor} />
      <RemoveRetained tile={tile} refresh={fleet.refresh} />
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
  );
  return (
    <HelpGuideProvider>
      <header className="topbar">
        <TopBar page={{ kind: "fleet" }} targets={fleet.data?.targets ?? []} />
      </header>
      <ErrorBanner error={fleet.error} />
      <main id="fleet" aria-labelledby="fleet-title">
        <Help topic="fleet" as="div" className="fleet-head">
          <div>
            <h2 id="fleet-title">Targets</h2>
            <p>
              Monitored processes and their current assessments. Select a tile
              to open its dashboard.
            </p>
          </div>
          {tiles.length > 0 && (
            <div id="fleet-counts" className="fleet-counts" aria-live="polite">
              <small>Totals for active targets</small>
              {COUNT_GROUPS.map(([level, label, color]) => {
                const count =
                  counts[level] + (level === "good" ? counts.info : 0);
                return count ? (
                  <span key={level} style={{ "--lvl": color } as CSSProperties}>
                    <b>{count}</b> {label}
                  </span>
                ) : null;
              })}
            </div>
          )}
        </Help>
        <div className="toolbar fleet-toolbar">
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

          {filtered && (
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
          )}
          {tiles.length > 0 && (
            <span id="fleet-shown" className="muted" aria-live="polite">
              {filtered ? "Matching" : "Listed"} {shown} of {tiles.length}{" "}
              targets
            </span>
          )}
        </div>

        {tiles.length > 1 && (
          <small id="fleet-order-hint" className="muted">
            Drag a tile to reorder it, or press Alt and an arrow key on a
            focused tile.
          </small>
        )}
        <p id="fleet-order-status" className="fleet-sr" aria-live="polite">
          {announcement}
        </p>
        <p
          id="fleet-status"
          role="status"
          className={(editor.form.bad ? "bad" : "muted") + " fleet-status"}
        >
          {editor.form.status}
        </p>

        {fleet.data?.capacity.map((notice) => (
          <div key={notice}>
            <p className="fleet-capacity warn">{notice}</p>
          </div>
        ))}
        <div id="fleet-grid" className="fleet-grid">
          {active.map(renderTile)}
          {(control.enabled || control.reason) && (
            <div key="fleet-add" className="fleet-add-help">
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
            </div>
          )}
        </div>
        {inactive.length > 0 && (
          <section
            className="fleet-inactive"
            aria-labelledby="fleet-inactive-toggle"
          >
            <button
              id="fleet-inactive-toggle"
              type="button"
              aria-expanded={inactiveOpen}
              aria-controls="fleet-inactive-grid"
              onClick={() => {
                setInactiveOpen(!inactiveOpen);
              }}
            >
              <span aria-hidden="true">{inactiveOpen ? "▾" : "▸"}</span>{" "}
              Inactive targets ({filtered ? `${String(inactiveShown)} of ` : ""}
              {inactive.length})
            </button>
            <div id="fleet-inactive-grid" hidden={!inactiveOpen}>
              <p className="muted">
                These processes ended or are no longer monitored. Open a tile
                for final data and recordings.
              </p>
              <div className="fleet-grid">{inactive.map(renderTile)}</div>
            </div>
          </section>
        )}
        {tiles.length > 0 && shown === 0 && (
          <p id="fleet-none" className="fleet-empty">
            No targets match this search. Clear filters shows every target.
          </p>
        )}
        {fleet.data && tiles.length === 0 && (
          <p id="fleet-empty" className="fleet-empty">
            No targets yet. A target appears here when its sampler sends its
            first data to this collector.
          </p>
        )}
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
