import { useEffect, useRef, useState } from "react";
import type { LiveResponse } from "../api/types";
import {
  emptySeries,
  ingest,
  restoreSeries,
  threadsEntry,
  type Series,
} from "../lib/series";

const storageKey = (name: string, target: string) =>
  target ? `${name}:${target}` : name;
function read(name: string, target: string): unknown {
  try {
    return JSON.parse(
      sessionStorage.getItem(storageKey(name, target)) ?? "null",
    );
  } catch {
    return null;
  }
}
function save(series: Series, target: string) {
  try {
    sessionStorage.setItem(
      storageKey("triangulator:buffer", target),
      JSON.stringify({
        session: series.session,
        points: series.points,
        loadState: series.load,
      }),
    );
  } catch {
    /* The tab keeps its series in memory. */
  }
  try {
    sessionStorage.setItem(
      storageKey("triangulator:threads", target),
      JSON.stringify(threadsEntry(series)),
    );
  } catch {
    try {
      sessionStorage.removeItem(storageKey("triangulator:threads", target));
    } catch {
      /* Storage is blocked. */
    }
  }
}
/** Old entry names that a target switch clears for both targets. */
export const VIEW_CACHES = [
  "triangulator:buffer",
  "triangulator:threads",
  "triangulator:frozen",
] as const;
export function clearViewCaches(target: string) {
  for (const name of VIEW_CACHES)
    try {
      sessionStorage.removeItem(storageKey(name, target));
    } catch {
      /* Storage is blocked. */
    }
}

/**
 * The live series of one target, kept in this tab: each new live view is
 * ingested once. A new sampler session starts from what this tab saved for
 * that session. The tab saves after every 5th point and when the page hides.
 */
export function useSeries(target: string, view: LiveResponse | undefined) {
  const [state, setState] = useState<{
    view?: LiveResponse;
    series: Series;
  }>({ series: emptySeries });
  let series = state.series;
  if (view && view !== state.view) {
    const session = view.health.session;
    const start =
      session !== series.session
        ? restoreSeries(
            read("triangulator:buffer", target),
            read("triangulator:threads", target),
            session,
          )
        : series;
    series = ingest(start, view);
    setState({ view, series });
  }
  const latest = useRef(series);
  useEffect(() => {
    const previous = latest.current;
    latest.current = series;
    if (
      series !== previous &&
      series.points.length &&
      series.points.at(-1) !== previous.points.at(-1) &&
      series.points.length % 5 === 0
    )
      save(series, target);
  }, [series, target]);
  useEffect(() => {
    const hide = () => {
      if (latest.current.session !== null) save(latest.current, target);
    };
    addEventListener("pagehide", hide);
    return () => {
      removeEventListener("pagehide", hide);
    };
  }, [target]);
  return series;
}
