import type {
  LiveResponse,
  MemoryLayout,
  SocketReport,
  WatchRule,
} from "../api/types";
import type { ViewMode } from "./assess";
import type { ResourcePoint } from "./assess/memory";
import {
  initialMemory,
  memoryReducer,
  type MemoryAction,
  memoryResources,
  type MemoryState,
} from "./memoryView";
import { emptySeries, ingest, type Series } from "./series";

export interface Observation {
  key: string;
  mode: ViewMode;
  view: LiveResponse;
  now: number;
  series: Series;
  memory: MemoryState;
  resources: readonly ResourcePoint[];
  sockets?: SocketReport;
  socketError?: Error;
  watchRules: readonly WatchRule[] | null;
}
export interface Observations {
  target: string;
  latest?: { view: LiveResponse; now: number };
  live?: Observation;
  final?: Observation;
  recorded?: Observation;
  generation: number;
  settleSince: number | null;
  checked: readonly string[];
}
export const initialObservations = (target: string): Observations => ({
  target,
  generation: 0,
  settleSince: null,
  checked: [],
});
export const displayed = (state: Observations) =>
  state.recorded ?? state.final ?? state.live;
export const processKey = (target: string, view: LiveResponse) =>
  JSON.stringify([target, view.health.session, view.health.pid]);
export const observationKey = (
  target: string,
  view: LiveResponse,
  kind: ViewMode["kind"],
  at?: number,
) => JSON.stringify([processKey(target, view), kind, at]);

export function observe(
  target: string,
  view: LiveResponse,
  now: number,
  previous?: Observation,
  restored = emptySeries,
): Observation {
  const same =
    previous && processKey(target, previous.view) === processKey(target, view);
  const key = observationKey(target, view, "live");
  return {
    key,
    mode: { kind: "live" },
    view,
    now,
    series: ingest(same ? previous.series : restored, view),
    memory: memoryReducer(same ? previous.memory : initialMemory, {
      type: "sample",
      key,
      live: {
        summary: view.memory,
        session: view.health.session,
        comm: view.threads.find((t) => t.tid === view.health.pid)?.name,
        resources: memoryResources(
          view.memory,
          view.resources,
          view.health.session,
        ),
      },
    }),
    resources: same ? previous.resources : [],
    sockets: same ? previous.sockets : undefined,
    socketError: same ? previous.socketError : undefined,
    watchRules: same ? previous.watchRules : null,
  };
}
function freeze(state: Observations, observation: Observation): Observations {
  const at = observation.series.lastTick || observation.now;
  const exit = matchingExit(observation.view, state.latest?.view.exit) ?? null;
  const final = {
    ...observation,
    key: observationKey(state.target, observation.view, "final", at),
    now: at,
    memory: {
      ...observation.memory,
      key: observationKey(state.target, observation.view, "final", at),
    },
    mode: { kind: "final", exit } as const,
    view: { ...observation.view, exit },
  };
  return {
    ...state,
    final,
    checked: [...state.checked, String(observation.view.health.session)],
  };
}
export function matchingExit(view: LiveResponse, exit: LiveResponse["exit"]) {
  return exit?.session === view.health.session && exit?.pid === view.health.pid
    ? exit
    : null;
}
export function receiveLive(
  state: Observations,
  view: LiveResponse,
  now: number,
  restored = emptySeries,
): Observations {
  let next = { ...state, latest: { view, now } };
  if (next.final) {
    const ended = matchingExit(next.final.view, view.exit);
    if (next.final.mode.kind === "final" && !next.final.mode.exit && ended)
      next = {
        ...next,
        final: {
          ...next.final,
          mode: { kind: "final", exit: ended },
          view: { ...next.final.view, exit: ended },
        },
      };
    return next;
  }
  const kept = next.live;
  const changed =
    kept &&
    processKey(state.target, view) !== processKey(state.target, kept.view);
  const populated =
    kept && kept.view.threads.length > 0 && kept.series.points.length > 0;
  if (changed && populated && view.health.target_absent === true)
    return freeze(next, kept);
  if (
    changed &&
    populated &&
    !view.threads.length &&
    view.health.target_absent !== true
  ) {
    const since = next.settleSince ?? now;
    next = { ...next, settleSince: since };
    if (now - since < 10) return next;
  } else next.settleSince = null;
  if (next.recorded) return next;
  return { ...next, live: observe(state.target, view, now, kept, restored) };
}
/** The cached memory layout when it is of the recorded process, else null. */
export const compatibleLayout = (
  cached: MemoryLayout | null | undefined,
  view: LiveResponse,
) =>
  cached?.pid === view.health.pid &&
  cached.id?.split(":")[0] === view.health.session
    ? cached
    : null;
export function selectRecording(
  state: Observations,
  view: LiveResponse & { recorded_at: number },
  resources: readonly ResourcePoint[],
): Observations {
  const at = view.recorded_at;
  const observation = observe(state.target, view, at);
  // A cached layout is latest evidence. It is never replay memory history.
  const memory = {
    ...observation.memory,
    key: observationKey(state.target, view, "recorded", at),
    layout: compatibleLayout(
      state.live?.memory.layout ?? state.final?.memory.layout,
      view,
    ),
    history: [],
    previous: null,
    heapSpan: null,
  };
  return {
    ...state,
    recorded: {
      ...observation,
      key: observationKey(state.target, view, "recorded", at),
      mode: { kind: "recorded" },
      memory,
      resources,
    },
  };
}
export function returnToLive(
  state: Observations,
  restored = emptySeries,
): Observations {
  const next = {
    ...state,
    recorded: undefined,
    generation: state.generation + 1,
  };
  return next.latest
    ? receiveLive(next, next.latest.view, next.latest.now, restored)
    : next;
}
export function dismissFinal(
  state: Observations,
  restored = emptySeries,
): Observations {
  const next = {
    ...state,
    final: undefined,
    live: undefined,
    generation: state.generation + 1,
  };
  if (next.recorded) return next;
  return next.latest
    ? receiveLive(next, next.latest.view, next.latest.now, restored)
    : next;
}
export function restoreFinal(
  state: Observations,
  view: LiveResponse,
  at: number,
  layout: MemoryLayout | null,
  series: Series,
): Observations {
  const observation = observe(state.target, view, at, undefined, series);
  const memory = layout
    ? memoryReducer(observation.memory, {
        type: "layout",
        key: observation.key,
        layout,
      })
    : observation.memory;
  return freeze(
    { ...state, live: { ...observation, memory } },
    { ...observation, memory },
  );
}

/** A frozen view kept in the tab, restored with the first live reply. */
export interface FrozenView {
  live: LiveResponse;
  at: number;
  layout: MemoryLayout | null;
  exit: LiveResponse["exit"];
  series: Series;
}
/** The newest reads of the displayed observation's scoped polls. */
export interface ScopedReads {
  resources?: readonly ResourcePoint[];
  layout?: MemoryLayout;
  sockets?: SocketReport;
  socketError?: Error;
  /** False before the socket poll starts, so its error is not cleared. */
  socketPolled: boolean;
}
// Storage reads happen in the hook. Each event carries what it read, so the
// reducer stays pure.
export type ObservationEvent =
  | {
      type: "live";
      view: LiveResponse;
      now: number;
      restored: Series;
      frozen?: FrozenView;
    }
  | { type: "reads"; reads: ScopedReads }
  | {
      type: "last-target";
      session: string;
      view: LiveResponse | null;
      restored: Series;
    }
  | {
      type: "recording";
      view: LiveResponse & { recorded_at: number };
      resources: readonly ResourcePoint[];
    }
  | { type: "return-to-live"; restored: Series }
  | { type: "dismiss-final"; restored: Series }
  | { type: "invalidate" }
  | { type: "memory"; action: MemoryAction }
  | { type: "watch-rules"; rules: readonly WatchRule[] | null };

const slot = (observation: Observation) =>
  observation.mode.kind === "recorded"
    ? "recorded"
    : observation.mode.kind === "final"
      ? "final"
      : "live";

function applyReads(state: Observations, reads: ScopedReads): Observations {
  const shown = displayed(state);
  if (!shown) return state;
  const live = shown.mode.kind === "live";
  let updated = shown;
  if (reads.resources) updated = { ...updated, resources: reads.resources };
  if (live && reads.layout)
    updated = {
      ...updated,
      memory: memoryReducer(updated.memory, {
        type: "layout",
        key: updated.memory.key ?? updated.key,
        layout: reads.layout,
      }),
    };
  if (
    live &&
    reads.sockets &&
    (!reads.sockets.available || reads.sockets.pid === shown.view.health.pid)
  )
    updated = { ...updated, sockets: reads.sockets };
  if (live && reads.socketPolled && updated.socketError !== reads.socketError)
    updated = { ...updated, socketError: reads.socketError };
  return updated === shown ? state : { ...state, [slot(shown)]: updated };
}

export function observationReducer(
  state: Observations,
  event: ObservationEvent,
): Observations {
  switch (event.type) {
    case "live": {
      if (event.view === state.latest?.view && event.now === state.latest.now)
        return state;
      let next = state;
      const frozen = event.frozen;
      if (frozen) {
        next = restoreFinal(
          next,
          frozen.live,
          frozen.at,
          frozen.layout,
          frozen.series,
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
      }
      return receiveLive(next, event.view, event.now, event.restored);
    }
    case "reads":
      return applyReads(state, event.reads);
    case "last-target": {
      if (state.checked.includes(event.session)) return state;
      const checked = {
        ...state,
        checked: [...state.checked, event.session],
      };
      const view = event.view;
      return view?.health.session === event.session && view.threads.length
        ? restoreFinal(
            checked,
            view,
            view.health.last_seen ?? 0,
            null,
            event.restored,
          )
        : checked;
    }
    case "recording":
      return selectRecording(state, event.view, event.resources);
    case "return-to-live":
      return returnToLive(state, event.restored);
    case "dismiss-final":
      return dismissFinal(state, event.restored);
    case "invalidate":
      return { ...state, generation: state.generation + 1 };
    case "memory": {
      const observation = displayed(state);
      if (!observation) return state;
      let memory = memoryReducer(observation.memory, event.action);
      if (observation.mode.kind === "recorded")
        memory = { ...memory, history: [], heapSpan: null, previous: null };
      return { ...state, [slot(observation)]: { ...observation, memory } };
    }
    case "watch-rules":
      return state.live &&
        !state.final &&
        !state.recorded &&
        state.live.watchRules !== event.rules
        ? { ...state, live: { ...state.live, watchRules: event.rules } }
        : state;
  }
}
