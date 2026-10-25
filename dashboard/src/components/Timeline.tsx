import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { ReplayBounds } from "../api/replay";
import { timelineAtLive } from "../api/replay";
import type { Observation } from "../lib/observation";
import { date } from "../lib/format";
import { Help } from "../help/Help";

export function Timeline({
  bounds,
  observation,
  latestAt,
  note,
  onInspect,
  onLive,
}: {
  bounds?: ReplayBounds | null;
  observation?: Observation;
  latestAt: number;
  note: string;
  onInspect: (at: number, direction?: "at" | "previous" | "next") => void;
  onLive: () => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const recorded = observation?.mode.kind === "recorded";
  const first = bounds?.first ?? 0;
  const last = bounds?.last ?? 0;
  const end = Math.max(first + 1, last, latestAt, observation?.now ?? 0);
  const at = recorded ? observation.now : end;
  const available = bounds?.first != null && bounds.last != null;
  const input = useRef<HTMLInputElement>(null);
  const select = useEffectEvent((value: number) => {
    setPreview(null);
    if (timelineAtLive(value, end, 1)) onLive();
    else onInspect(value);
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
              onInspect(recorded ? at : last, recorded ? "previous" : "at");
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
        <input
          ref={input}
          id="timeline-range"
          type="range"
          aria-label="Recorded time"
          min={first}
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
          <span id="timeline-start">{available ? date(first) : ""}</span>
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
    </section>
  );
}
