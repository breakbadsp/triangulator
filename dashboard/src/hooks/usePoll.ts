import { useEffect, useState } from "react";

export function usePoll<T>(
  load: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  { pauseWhenHidden = false }: { pauseWhenHidden?: boolean } = {},
): { data?: T; error?: Error } {
  const [result, setResult] = useState<{ data?: T; error?: Error }>({});
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        if (pauseWhenHidden && document.hidden) return;
        const data = await load(controller.signal);
        if (!controller.signal.aborted && !(pauseWhenHidden && document.hidden))
          setResult({ data });
      } catch (cause) {
        if (
          !controller.signal.aborted &&
          !(pauseWhenHidden && document.hidden)
        ) {
          const error =
            cause instanceof Error ? cause : new Error(String(cause));
          setResult((previous) => ({ ...previous, error }));
        }
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => {
            void poll();
          }, intervalMs);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [load, intervalMs, pauseWhenHidden]);
  return result;
}
