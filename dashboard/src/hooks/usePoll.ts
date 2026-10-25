import { useCallback, useEffect, useRef, useState } from "react";

export function usePoll<T>(
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  { pauseWhenHidden = false }: { pauseWhenHidden?: boolean } = {},
): { data?: T; error?: Error; refresh: () => void } {
  const [result, setResult] = useState<{ data?: T; error?: Error }>({});
  const restart = useRef<() => void>(() => undefined);
  const refresh = useCallback(() => {
    restart.current();
  }, []);
  useEffect(() => {
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      controller?.abort();
      clearTimeout(timer);
      const request = new AbortController();
      controller = request;
      try {
        if (pauseWhenHidden && document.hidden) return;
        const data = await load(request.signal);
        if (!request.signal.aborted && !(pauseWhenHidden && document.hidden))
          setResult({ data });
      } catch (cause) {
        if (!request.signal.aborted && !(pauseWhenHidden && document.hidden)) {
          const error =
            cause instanceof Error ? cause : new Error(String(cause));
          setResult((previous) => ({ ...previous, error }));
        }
      } finally {
        if (!request.signal.aborted)
          timer = setTimeout(() => {
            void poll();
          }, intervalMs);
      }
    }
    restart.current = () => {
      void poll();
    };
    void poll();
    return () => {
      restart.current = () => undefined;
      controller?.abort();
      clearTimeout(timer);
    };
  }, [load, intervalMs, pauseWhenHidden]);
  return { ...result, refresh };
}
