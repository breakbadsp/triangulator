import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { getJson } from "../api/client";
import type { Thread, WatchRule } from "../api/types";
import { parseWatchRules } from "../api/watches";
import { watchRulesOutdated } from "../lib/assess/watch";

const EVERY_MS = 10000,
  RETRY_MS = 3000;

/**
 * The assessment's copy of the watch rules (old `refreshWatchRules`).
 * Each live poll checks its age: one request every 10 s, or sooner (but not
 * more often than every 3 s) when a thread's wake_ms disagrees with the
 * rules, for example just after another editor saved. A failed read gives
 * null, so no unmatched-rule finding comes from stale rules. `refresh`
 * reads again at once, after a change that the collector applied.
 */
export function useWatchRules(
  threads: readonly Thread[] | undefined,
  enabled = true,
  context: string | null = "live",
) {
  const request = useRef<AbortController | null>(null);
  const active = useRef(enabled);
  // The rules carry the context they were read for. Another context, or a
  // disabled hook, reads as no rules at once, not after an effect.
  const scope = useRef(context);
  const [read, setRead] = useState<{
    context: string | null;
    rules: readonly WatchRule[] | null;
  }>({ context, rules: null });
  const rules = enabled && read.context === context ? read.rules : null;
  const readAt = useRef(-Infinity);
  const loading = useRef(false);
  const refresh = useCallback(async () => {
    if (!active.current || loading.current) return;
    const controller = new AbortController();
    request.current = controller;
    loading.current = true;
    try {
      const value = parseWatchRules(
        await getJson<unknown>("/api/watches", controller.signal),
      );
      if (!controller.signal.aborted)
        setRead({ context: scope.current, rules: value });
    } catch {
      if (!controller.signal.aborted)
        setRead({ context: scope.current, rules: null });
    } finally {
      if (!controller.signal.aborted) {
        readAt.current = Date.now();
        loading.current = false;
      }
    }
  }, []);
  useLayoutEffect(() => {
    active.current = enabled;
    scope.current = context;
    // A rule list read for an earlier use of this hook must not return.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRead((previous) =>
      previous.rules === null ? previous : { context, rules: null },
    );
    readAt.current = -Infinity;
    loading.current = false;
    return () => {
      active.current = false;
      request.current?.abort();
      loading.current = false;
    };
  }, [enabled, context]);
  const tick = useEffectEvent((current: readonly Thread[]) => {
    const age = Date.now() - readAt.current;
    if (
      age >= EVERY_MS ||
      (age >= RETRY_MS && watchRulesOutdated(current, rules))
    )
      void refresh();
  });
  useEffect(() => {
    if (enabled && threads) tick(threads);
  }, [threads, enabled, context]);
  return { rules, refresh };
}
