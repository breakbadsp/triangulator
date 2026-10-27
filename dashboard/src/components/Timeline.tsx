import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { ReplayBounds } from "../api/replay";
import { timelineAtLive } from "../api/replay";
import type { Observation } from "../lib/observation";
import { clock, date } from "../lib/format";
import { Help } from "../help/Help";
import type { Episode, Scan } from "../lib/pastAssessments";
import { PAST } from "../lib/pastAssessments";
import {
  initialFilter,
  PastAssessments,
  shownEpisodes,
} from "./PastAssessments";

export function Timeline({
  bounds,
  observation,
  latestAt,
  note,
  onInspect,
  onLive,
  past,
}: {
  bounds?: ReplayBounds | null;
  observation?: Observation;
  latestAt: number;
  note: string;
  onInspect: (
    at: number,
    direction?: "at" | "previous" | "next" | "latest",
  ) => void;
  onLive: () => void;
  past: {
    scan: Scan;
    episodes: readonly Episode[];
    loadOlder: () => void;
  };
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const [filter, setFilter] = useState(initialFilter);
  const [selected, setSelected] = useState<string | null>(null);
  const recorded = observation?.mode.kind === "recorded";
  const first = bounds?.first ?? 0;
  const last = bounds?.last ?? 0;
  const newest = Math.max(last, latestAt, observation?.now ?? 0);
  // The bar spans the checked period, at least the first period, and the
  // displayed recording.
  const start = Math.max(
    first,
    Math.min(
      past.scan.oldest ?? Infinity,
      newest - PAST.firstS,
      recorded ? observation.now : Infinity,
    ),
  );
  const end = Math.max(start + 1, newest);
  const at = recorded ? observation.now : end;
  const available = bounds?.first != null && bounds.last != null;
  const shown = shownEpisodes(past.episodes, filter);
  const input = useRef<HTMLInputElement>(null);
  const select = useEffectEvent((value: number) => {
    setPreview(null);
    if (timelineAtLive(value, end, 1)) onLive();
    else {
      onInspect(value);
      // The left end also checks an earlier period.
      if (value <= start + (end - start) / 100) past.loadOlder();
    }
  });
  useEffect(() => {
    const element = input.current;
    const change = () => {
      if (element) select(Number(element.value));
    };
    element?.addEventListener("change", change);
    return () => {
      element?.removeEventListener("change", change);
    };
  }, []);
  return (
    <section id="timeline" className="block card">
      <Help topic="timeline" as="div">
        <h2>Timeline</h2>
        <p>Inspect a recorded process view.</p>
      </Help>
      <Help topic="timeline" as="div">
        <div className="range">
          <button
            id="replay-previous"
            type="button"
            disabled={!available || (recorded && at <= first)}
            onClick={() => {
              onInspect(recorded ? at : last, recorded ? "previous" : "latest");
            }}
            aria-label="Previous recording"
          >
            ◀ Previous
          </button>
          <button
            id="replay-next"
            type="button"
            disabled={!recorded || at >= last}
            onClick={() => {
              onInspect(at, "next");
            }}
            aria-label="Next recording"
          >
            Next ▶
          </button>
          <button
            id="replay-live"
            type="button"
            aria-pressed={!recorded}
            onClick={onLive}
          >
            Live
          </button>
        </div>
        <p id="replay-bounds" className="muted">
          {available
            ? `Recordings from ${date(first)} to ${date(last)}, ${bounds.interval_s ? `one every ${String(bounds.interval_s)} s.` : "recording is now disabled."}`
            : "No recordings yet. Recording may be disabled; thread history still has older summaries."}
        </p>
        <Help topic="assesshistory" as="div">
          <div id="timeline-marks" className="timeline-marks">
            {available &&
              shown.map((episode) => (
                // One mark per shown past finding, in its severity colour,
                // from first to last seen.
                <span
                  key={episode.id}
                  style={
                    {
                      left: `${String(100 * Math.max(0, (episode.first - start) / (end - start)))}%`,
                      width: `${String(100 * Math.max(0, (episode.last - episode.first) / (end - start)))}%`,
                      "--lvl": `var(--${episode.level === "info" ? "muted" : episode.level})`,
                    } as CSSProperties
                  }
                >
                  <Help topic="assesshistory" className="mark-help">
                    <span
                      role="img"
                      aria-label={`${episode.item.title} · ${clock(episode.first)}`}
                    />
                  </Help>
                </span>
              ))}
          </div>
        </Help>
        <input
          ref={input}
          id="timeline-range"
          type="range"
          aria-label="Recorded time"
          min={start}
          max={end}
          step="1"
          disabled={!available}
          value={preview ?? at}
          onInput={(event) => {
            setPreview(Number(event.currentTarget.value));
          }}
          onChange={() => undefined}
          onPointerCancel={() => {
            setPreview(null);
          }}
          onBlur={() => {
            setPreview(null);
          }}
          style={{ width: "100%" }}
        />
        <div className="range">
          <span id="timeline-start">{available ? date(start) : ""}</span>
          <span id="timeline-end">
            {recorded ? `Now · ${date(end)}` : "Live"}
          </span>
        </div>
        <p id="timeline-cursor" className="muted">
          {preview !== null
            ? timelineAtLive(preview, end, 1)
              ? "Release for live"
              : `Release to view ${date(preview)}`
            : recorded
              ? `Viewing ${date(at)}`
              : ""}
        </p>
        <p id="replay-note" role="status">
          {note}
        </p>
      </Help>
      <PastAssessments
        scan={past.scan}
        episodes={past.episodes}
        filter={filter}
        onFilter={setFilter}
        recordings={available}
        viewingAt={recorded ? observation.now : null}
        selected={selected}
        onSelect={(episode) => {
          setSelected(episode.id);
          onInspect(episode.at);
        }}
        onLoadOlder={past.loadOlder}
      />
    </section>
  );
}
