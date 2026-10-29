import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { getJson } from "../api/client";
import { settleArrival } from "../api/viewStorage";
import {
  parseBounds,
  parseFrozen,
  parseReplay,
  parseView,
  type ReplayBounds,
} from "../api/replay";
import type {
  LiveResponse,
  MemoryLayout,
  ResourceHistory,
  WatchRule,
} from "../api/types";
import { asResourcePoints } from "../lib/assess/memory";
import type { MemoryAction } from "../lib/memoryView";
import {
  displayed,
  initialObservations,
  observationReducer,
  type FrozenView,
  type Observation,
} from "../lib/observation";
import { restoreSeries, threadsEntry } from "../lib/series";
import { useScopedPoll } from "./useScopedPoll";

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
function restored(target: string, session: string | null | undefined) {
  return restoreSeries(
    read("triangulator:buffer", target),
    read("triangulator:threads", target),
    session,
  );
}
function save(target: string, observation: Observation | undefined) {
  if (!observation || observation.series.session == null) return;
  const series = observation.series;
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
    /* Keep analysis in memory. */
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
async function resources(signal: AbortSignal, end: number, range: number) {
  const data = await getJson<ResourceHistory>(
    `/api/resources?${new URLSearchParams({ start: String(end - range), end: String(end) })}`,
    signal,
  );
  // RSS assessment needs every process boundary, including unavailable rows.
  return asResourcePoints(data.rows.filter((row) => row.ts <= end));
}
const loadBounds = async (signal: AbortSignal) =>
  parseBounds(await getJson<unknown>("/api/replay", signal));
export const LIVE_NOTE =
  "Live view. Drag the Timeline back to inspect a recording.";

export function useObservation(
  target: string,
  latest: { view: LiveResponse; now: number } | undefined,
  range: number,
) {
  const [next, dispatch] = useReducer(
    observationReducer,
    target,
    initialObservations,
  );
  // Before any cache read: a switch from another target clears them here.
  // The live event below reads the caches in a later effect of this commit.
  useLayoutEffect(() => {
    settleArrival(target);
  }, [target]);
  const restoredOnce = useRef(false);
  useLayoutEffect(() => {
    if (!latest) return;
    let frozen: FrozenView | undefined;
    if (!restoredOnce.current) {
      restoredOnce.current = true;
      const kept = parseFrozen(
        read("triangulator:frozen", target),
        latest.view.health.session,
      );
      if (kept)
        frozen = {
          ...kept,
          exit: kept.exit ?? null,
          series: restored(target, kept.live.health.session),
        };
      else
        try {
          sessionStorage.removeItem(storageKey("triangulator:frozen", target));
        } catch {
          /* Storage is blocked. */
        }
    }
    dispatch({
      type: "live",
      view: latest.view,
      now: latest.now,
      restored: restored(target, latest.view.health.session),
      frozen,
    });
  }, [target, latest]);
  const current = useRef(next);
  useLayoutEffect(() => {
    current.current = next;
  }, [next]);
  const shown = displayed(next);
  const mode = shown?.mode.kind ?? "live";
  const scope = shown ? `${shown.key}|${String(next.generation)}` : null;
  const boundsPoll = useScopedPoll("bounds", loadBounds, 15000);
  const [selectedBounds, setSelectedBounds] = useState<ReplayBounds | null>(
    null,
  );
  const bounds = selectedBounds ?? boundsPoll?.data;
  const [note, setNote] = useState(LIVE_NOTE);
  const selection = useRef<AbortController | null>(null);
  const [unsaved, setUnsaved] = useState(false);
  useEffect(
    () => () => {
      selection.current?.abort();
    },
    [],
  );
  const [seenBounds, setSeenBounds] = useState(boundsPoll?.data);
  if (boundsPoll?.data !== seenBounds) {
    setSeenBounds(boundsPoll?.data);
    if (boundsPoll?.data) setSelectedBounds(boundsPoll.data);
  }
  // Live receipt time changes every second, but the resource reader stays on
  // its five-second cadence. Historical requests end at the selected time.
  // Copy the scalar out of the observation alias for React Compiler. The
  // observation itself is replaced below when scoped reads arrive.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion
  const historicalEnd = mode === "live" ? null : Number(shown?.now ?? 0);
  const resourceLoader = useCallback(
    (signal: AbortSignal) =>
      resources(
        signal,
        historicalEnd ?? Date.now() / 1000,
        Math.max(range, 180),
      ),
    [historicalEnd, range],
  );
  const resourceResult = useScopedPoll(
    scope ? `${scope}|resources|${String(range)}` : null,
    resourceLoader,
    mode === "live" ? 5000 : null,
  );
  const layoutId =
    mode === "live" &&
    shown?.view.memory?.available &&
    shown.view.memory.layout_id !== shown.memory.layout?.id
      ? shown.view.memory.layout_id
      : null;
  const loadLayout = useCallback(
    (signal: AbortSignal) => getJson<MemoryLayout>("/api/memory-map", signal),
    [],
  );
  const layoutResult = useScopedPoll(
    layoutId && scope ? `${scope}|layout|${layoutId}` : null,
    loadLayout,
    1000,
  );
  const resourceData = resourceResult?.data;
  const layoutData = layoutResult?.data;
  useLayoutEffect(() => {
    dispatch({
      type: "reads",
      reads: {
        resources: resourceData,
        layout: layoutData,
      },
    });
  }, [resourceData, layoutData]);
  const expected =
    next.latest?.view.health.target_absent === true
      ? next.latest.view.health.last_target?.session
      : undefined;
  const wantFinal =
    expected &&
    !next.final &&
    !next.recorded &&
    !next.checked.includes(expected)
      ? expected
      : null;
  const lastTarget = useCallback(async (signal: AbortSignal) => {
    const raw = await getJson<unknown>("/api/last-target", signal);
    try {
      return parseView(raw);
    } catch {
      return null;
    }
  }, []);
  const keptResult = useScopedPoll(
    wantFinal ? `${target}|last|${wantFinal}|${String(next.generation)}` : null,
    lastTarget,
    1000,
  );
  const kept = keptResult?.data;
  useLayoutEffect(() => {
    if (kept === undefined || !wantFinal) return;
    dispatch({
      type: "last-target",
      session: wantFinal,
      view: kept,
      restored: restored(target, wantFinal),
    });
  }, [target, kept, wantFinal]);
  const final = next.final;
  useEffect(() => {
    if (!final) return;
    save(target, final);
    try {
      sessionStorage.setItem(
        storageKey("triangulator:frozen", target),
        JSON.stringify({
          at: final.now,
          live: final.view,
          layout: final.memory.layout,
          exit: final.view.exit,
        }),
      );
      // Storage success changes the reload warning.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUnsaved(false);
    } catch {
      try {
        sessionStorage.removeItem(storageKey("triangulator:frozen", target));
      } catch {
        /* Storage is blocked. */
      }
      setUnsaved(true);
    }
  }, [target, final]);
  useEffect(() => {
    if (
      !next.recorded &&
      !next.final &&
      next.live?.series.points.length &&
      next.live.series.points.length % 5 === 0
    )
      save(target, next.live);
  }, [target, next.live, next.recorded, next.final]);
  useEffect(() => {
    const hide = () => {
      const held = current.current;
      if (!held.recorded) save(target, held.final ?? held.live);
    };
    addEventListener("pagehide", hide);
    return () => {
      removeEventListener("pagehide", hide);
    };
  }, [target]);
  function invalidate() {
    selection.current?.abort();
    const controller = new AbortController();
    selection.current = controller;
    dispatch({ type: "invalidate" });
    return controller;
  }
  async function inspect(
    at: number,
    direction: "at" | "previous" | "next" | "latest" = "at",
  ) {
    if (!Number.isFinite(at) || at < 0) {
      setNote("Choose a valid time.");
      return false;
    }
    const controller = invalidate();
    setNote("Loading recorded process view…");
    try {
      const requestedAt =
        direction === "latest"
          ? (await loadBounds(controller.signal)).last
          : at;
      controller.signal.throwIfAborted();
      if (requestedAt === null) {
        setNote("No recordings available.");
        return false;
      }
      const reply = parseReplay(
        await getJson<unknown>(
          `/api/replay?${new URLSearchParams({ at: String(requestedAt), direction: direction === "latest" ? "at" : direction })}`,
          controller.signal,
        ),
      );
      if (controller.signal.aborted) return false;
      setSelectedBounds(reply);
      const snapshot = reply.snapshot;
      if (!snapshot) {
        setNote(
          direction === "at"
            ? "No recording at or before this time. Choose a later time on the Timeline."
            : "No more recorded snapshots in this direction.",
        );
        return false;
      }
      const points = snapshot.resources?.available
        ? await resources(
            controller.signal,
            snapshot.recorded_at,
            Math.max(range, 180),
          )
        : [];
      controller.signal.throwIfAborted();
      if (!current.current.recorded)
        save(target, current.current.final ?? current.current.live);
      dispatch({ type: "recording", view: snapshot, resources: points });
      const gap =
        requestedAt - snapshot.recorded_at >
        Math.max(2, (snapshot.recording_interval_s ?? reply.interval_s) * 2);
      setNote(
        `Recorded view · ${new Date(snapshot.recorded_at * 1000).toLocaleString()} · session ${String(snapshot.health.session)}.${direction === "at" && gap ? " There is a recording gap before the requested time." : ""} State is the latest sampled observation; rates cover the preceding ~10 seconds.`,
      );
      return true;
    } catch (cause) {
      if (!controller.signal.aborted)
        setNote(
          cause instanceof Error ? cause.message : "Unable to read recordings.",
        );
      return false;
    }
  }
  function live() {
    invalidate();
    dispatch({
      type: "return-to-live",
      restored: restored(target, current.current.latest?.view.health.session),
    });
    setNote(LIVE_NOTE);
  }
  function dismiss() {
    invalidate();
    dispatch({
      type: "dismiss-final",
      restored: restored(target, current.current.latest?.view.health.session),
    });
    setUnsaved(false);
    try {
      sessionStorage.removeItem(storageKey("triangulator:frozen", target));
    } catch {
      /* Storage is blocked. */
    }
  }
  function memory(action: MemoryAction) {
    dispatch({ type: "memory", action });
  }
  const rules = useCallback((value: readonly WatchRule[] | null) => {
    dispatch({ type: "watch-rules", rules: value });
  }, []);
  return {
    observation: shown,
    state: next,
    mode,
    scope,
    bounds,
    note,
    unsaved,
    inspect,
    live,
    dismiss,
    memory,
    rules,
  };
}
