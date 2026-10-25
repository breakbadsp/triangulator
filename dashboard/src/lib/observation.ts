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
export function selectRecording(
  state: Observations,
  view: LiveResponse & { recorded_at: number },
  resources: readonly ResourcePoint[],
): Observations {
  const at = view.recorded_at;
  const observation = observe(state.target, view, at);
  const cached = state.live?.memory.layout ?? state.final?.memory.layout;
  const compatible =
    cached?.pid === view.health.pid &&
    cached.id?.split(":")[0] === view.health.session;
  // A cached layout is latest evidence. It is never replay memory history.
  const memory = {
    ...observation.memory,
    layout: compatible ? cached : null,
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
