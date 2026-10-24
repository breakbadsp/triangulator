import { useCallback, useState } from "react";
import { getJson } from "../api/client";
import type { LiveResponse, MemoryLayout } from "../api/types";
import {
  initialMemory,
  memoryReducer,
  memoryResources,
  type MemoryAction,
  type MemoryState,
} from "../lib/memoryView";
import { useScopedPoll } from "./useScopedPoll";

const loadLayout = (signal: AbortSignal) =>
  getJson<MemoryLayout>("/api/memory-map", signal);

interface Held {
  view?: LiveResponse;
  layout?: MemoryLayout;
  state: MemoryState;
}

/**
 * The memory map state of the target's current process. A new live view or
 * layout response is taken in during the render that receives it, so no
 * render shows the state of an earlier target, session, or PID. The layout
 * is fetched only while the held one is not the one the live summary names;
 * the poll retries each second until it is.
 */
export function useMemoryMap(target: string, view: LiveResponse | undefined) {
  const [held, setHeld] = useState<Held>({ state: initialMemory });
  let next = held;
  if (view && view !== held.view) {
    const m = view.memory,
      session = view.health.session;
    next = {
      ...next,
      view,
      state: memoryReducer(next.state, {
        type: "sample",
        key: `${target}|${String(session)}|${String(m?.pid ?? view.health.pid)}`,
        live: {
          summary: m,
          session,
          comm: view.threads.find((thread) => thread.tid === view.health.pid)
            ?.name,
          resources: memoryResources(m, view.resources, session),
        },
      }),
    };
  }
  const { key, layout: heldLayout, live } = next.state,
    m = live?.summary;
  const want =
    key && m?.available && m.layout_id && heldLayout?.id !== m.layout_id
      ? { key, context: `${key}|${m.layout_id}` }
      : null;
  const layout = useScopedPoll(want?.context ?? null, loadLayout, 1000)?.data;
  if (want && layout && layout !== next.layout)
    next = {
      ...next,
      layout,
      state: memoryReducer(next.state, {
        type: "layout",
        key: want.key,
        layout,
      }),
    };
  if (next !== held) setHeld(next);
  const dispatch = useCallback((action: MemoryAction) => {
    setHeld((current) => ({
      ...current,
      state: memoryReducer(current.state, action),
    }));
  }, []);
  return { state: next.state, dispatch };
}
