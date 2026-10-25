import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { getJson, ApiError } from "../api/client";
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
  SocketReport,
  WatchRule,
} from "../api/types";
import { asResourcePoints } from "../lib/assess/memory";
import { memoryReducer, type MemoryAction } from "../lib/memoryView";
import {
  displayed,
  initialObservations,
  receiveLive,
  selectRecording,
  returnToLive,
  dismissFinal,
  restoreFinal,
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
async function resources(
  signal: AbortSignal,
  end: number,
  range: number,
  pid: number,
) {
  const data = await getJson<ResourceHistory>(
    `/api/resources?${new URLSearchParams({ start: String(end - range), end: String(end) })}`,
    signal,
  );
  return asResourcePoints(
    data.rows.filter((row) => row.ts <= end && row.pid === pid),
  );
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
  const [state, setState] = useState(() => {
    // Before any cache read: a switch from another target clears them here.
    settleArrival(target);
    return initialObservations(target);
  });
  const [restoredOnce, setRestoredOnce] = useState(false);
  let next = state;
  if (
    latest &&
    (latest.view !== state.latest?.view || latest.now !== state.latest.now)
  ) {
    if (!restoredOnce) {
      setRestoredOnce(true);
      const frozen = parseFrozen(
        read("triangulator:frozen", target),
        latest.view.health.session,
      );
      if (frozen) {
        next = restoreFinal(
          next,
          frozen.live,
          frozen.at,
          frozen.layout,
          restored(target, frozen.live.health.session),
        );
        if (frozen.exit && next.final)
          next = {
            ...next,
            final: {
              ...next.final,
              mode: { kind: "final", exit: frozen.exit },
              view: { ...next.final.view, exit: frozen.exit },
            },
          };
      } else
        try {
          sessionStorage.removeItem(storageKey("triangulator:frozen", target));
        } catch {
          /* Storage is blocked. */
        }
    }
    next = receiveLive(
      next,
      latest.view,
      latest.now,
      restored(target, latest.view.health.session),
    );
  }
  if (next !== state) setState(next);
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
  const historicalEnd = mode === "live" ? null : (shown?.now ?? 0);
  const resourceLoader = useCallback(
    (signal: AbortSignal) =>
      resources(
        signal,
        historicalEnd ?? Date.now() / 1000,
        Math.max(range, 180),
        shown?.view.health.pid ?? 0,
      ),
    [historicalEnd, shown?.view.health.pid, range],
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
  const pid = shown?.view.health.pid ?? 0;
  const loadSockets = useCallback(
    async (signal: AbortSignal): Promise<SocketReport> => {
      try {
        return await getJson<SocketReport>(
          `/api/socket-io?pid=${String(pid)}`,
          signal,
        );
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 404)
          return {
            available: false,
            reason:
              "This collector does not support socket observations. Use the C++ collector.",
          };
        throw cause;
      }
    },
    [pid],
  );
  const socketResult = useScopedPoll(
    mode === "live" && pid ? scope : null,
    loadSockets,
    3000,
  );
  const [seenReads, setSeenReads] = useState({
    resources: resourceResult?.data,
    layout: layoutResult?.data,
    sockets: socketResult?.data,
    socketError: socketResult?.error,
  });
  if (
    seenReads.resources !== resourceResult?.data ||
    seenReads.layout !== layoutResult?.data ||
    seenReads.sockets !== socketResult?.data ||
    seenReads.socketError !== socketResult?.error
  ) {
    setSeenReads({
      resources: resourceResult?.data,
      layout: layoutResult?.data,
      sockets: socketResult?.data,
      socketError: socketResult?.error,
    });
    if (shown) {
      let updated = shown;
      if (resourceResult?.data)
        updated = { ...updated, resources: resourceResult.data };
      if (mode === "live" && layoutResult?.data)
        updated = {
          ...updated,
          memory: memoryReducer(updated.memory, {
            type: "layout",
            key: updated.memory.key ?? updated.key,
            layout: layoutResult.data,
          }),
        };
      if (
        mode === "live" &&
        socketResult?.data &&
        (!socketResult.data.available || socketResult.data.pid === pid)
      )
        updated = { ...updated, sockets: socketResult.data };
      if (mode === "live" && socketResult)
        updated = { ...updated, socketError: socketResult.error };
      if (updated !== shown)
        setState({
          ...next,
          [mode === "recorded"
            ? "recorded"
            : mode === "final"
              ? "final"
              : "live"]: updated,
        });
    }
  }
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
  if (keptResult?.data !== undefined && wantFinal) {
    const view = keptResult.data;
    const checked = { ...next, checked: [...next.checked, wantFinal] };
    setState(
      view?.health.session === wantFinal && view.threads.length
        ? restoreFinal(
            checked,
            view,
            view.health.last_seen ?? 0,
            null,
            restored(target, wantFinal),
          )
        : checked,
    );
  }
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
    setState((previous) => ({
      ...previous,
      generation: previous.generation + 1,
    }));
    return controller;
  }
  async function inspect(
    at: number,
    direction: "at" | "previous" | "next" = "at",
  ) {
    if (!Number.isFinite(at) || at < 0) {
      setNote("Choose a valid time.");
      return false;
    }
    const controller = invalidate();
    setNote("Loading recorded process view…");
    try {
      const reply = parseReplay(
        await getJson<unknown>(
          `/api/replay?${new URLSearchParams({ at: String(at), direction })}`,
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
            snapshot.health.pid,
          )
        : [];
      controller.signal.throwIfAborted();
      if (!current.current.recorded)
        save(target, current.current.final ?? current.current.live);
      setState((previous) => selectRecording(previous, snapshot, points));
      const gap =
        at - snapshot.recorded_at >
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
    setState((previous) =>
      returnToLive(
        previous,
        restored(target, previous.latest?.view.health.session),
      ),
    );
    setNote(LIVE_NOTE);
  }
  function dismiss() {
    invalidate();
    setState((previous) =>
      dismissFinal(
        previous,
        restored(target, previous.latest?.view.health.session),
      ),
    );
    setUnsaved(false);
    try {
      sessionStorage.removeItem(storageKey("triangulator:frozen", target));
    } catch {
      /* Storage is blocked. */
    }
  }
  function memory(action: MemoryAction) {
    setState((previous) => {
      const observation = displayed(previous);
      if (!observation) return previous;
      let value = memoryReducer(observation.memory, action);
      if (observation.mode.kind === "recorded")
        value = { ...value, history: [], heapSpan: null, previous: null };
      return {
        ...previous,
        [observation.mode.kind === "recorded"
          ? "recorded"
          : observation.mode.kind === "final"
            ? "final"
            : "live"]: { ...observation, memory: value },
      };
    });
  }
  const rules = useCallback((value: readonly WatchRule[] | null) => {
    setState((previous) =>
      previous.live &&
      !previous.final &&
      !previous.recorded &&
      previous.live.watchRules !== value
        ? { ...previous, live: { ...previous.live, watchRules: value } }
        : previous,
    );
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
