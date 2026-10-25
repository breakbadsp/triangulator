import { useCallback, useRef } from "react";
import { usePoll } from "./usePoll";

/**
 * `usePoll` for one request context, such as target, session, PID and range.
 * `usePoll` keeps its last result when its loader changes, so each result
 * names its context, and a result of another context is never returned. A
 * failed poll keeps the last good data of the same context beside the error.
 * `load` must change only with the context. A null context sends nothing.
 */
export function useScopedPoll<T>(
  context: string | null,
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs: number | null,
): { data?: T; error?: Error } | undefined {
  const last = useRef<{ context: string; data: T } | null>(null);
  const scoped = useCallback(
    async (signal: AbortSignal) => {
      if (context === null) return null;
      try {
        const data = await load(signal);
        if (!signal.aborted) last.current = { context, data };
        return { context, data };
      } catch (cause) {
        const error = cause instanceof Error ? cause : new Error(String(cause));
        const data =
          last.current?.context === context ? last.current.data : undefined;
        return { context, data, error };
      }
    },
    [context, load],
  );
  const result = usePoll(scoped, intervalMs).data;
  return context !== null && result?.context === context ? result : undefined;
}
