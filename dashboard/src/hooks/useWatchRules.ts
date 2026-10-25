import {
  useCallback,
  useEffect,
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
export function useWatchRules(threads: readonly Thread[] | undefined) {
  const [rules, setRules] = useState<readonly WatchRule[] | null>(null);
  const readAt = useRef(-Infinity);
  const loading = useRef(false);
  const refresh = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      setRules(
        parseWatchRules(
          await getJson<unknown>("/api/watches", new AbortController().signal),
        ),
      );
    } catch {
      setRules(null);
    } finally {
      readAt.current = Date.now();
      loading.current = false;
    }
  }, []);
  const tick = useEffectEvent((current: readonly Thread[]) => {
    const age = Date.now() - readAt.current;
    if (
      age >= EVERY_MS ||
      (age >= RETRY_MS && watchRulesOutdated(current, rules))
    )
      void refresh();
  });
  useEffect(() => {
    if (threads) tick(threads);
  }, [threads]);
  return { rules, refresh };
}
