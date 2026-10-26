export const HELP_DELAY = 3000;
const HELP_CLOSE_DELAY = 250;
type Point = { x: number; y: number };
type Request<T> = { key: string; payload: T; point: Point | null };

// Keep timing outside the component so redraws cannot shorten the dwell period.
export function createHelpTimer<T>(
  open: ((payload: T) => boolean) | ((payload: T) => void),
  close: () => void,
) {
  let pending: Request<T> | null = null;
  let current: Request<T> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing: ReturnType<typeof setTimeout> | undefined;
  let suppressed: Request<T> | null = null;
  function cancel(block = false) {
    if (block) suppressed = current ?? pending ?? suppressed;
    clearTimeout(timer);
    clearTimeout(closing);
    timer = closing = undefined;
    pending = null;
    if (current) {
      current = null;
      close();
    }
  }
  return {
    get active() {
      return current ?? pending;
    },
    get visible() {
      return current;
    },
    get blocked() {
      return suppressed;
    },
    show(key: string, payload: T) {
      cancel();
      suppressed = null;
      if (open(payload) !== false) current = { key, payload, point: null };
    },
    request(key: string, payload: T, point: Point | null = null) {
      clearTimeout(closing);
      closing = undefined;
      if (key === suppressed?.key) return;
      if (suppressed?.key !== key) suppressed = null;
      if (current?.key === key) return;
      if (
        pending?.key === key &&
        (!point ||
          (pending.point &&
            Math.hypot(point.x - pending.point.x, point.y - pending.point.y) <=
              8))
      ) {
        pending.payload = payload;
        return;
      }
      cancel();
      pending = { key, payload, point };
      timer = setTimeout(() => {
        const next = pending;
        pending = null;
        timer = undefined;
        if (next && open(next.payload) !== false) current = next;
      }, HELP_DELAY);
    },
    leave(keep = () => false) {
      clearTimeout(closing);
      if (keep()) return;
      clearTimeout(timer);
      timer = undefined;
      pending = null;
      if (!current) {
        suppressed = null;
        return;
      }
      closing = setTimeout(() => {
        if (!keep()) {
          cancel();
          suppressed = null;
        }
      }, HELP_CLOSE_DELAY);
    },
    cancel,
    release() {
      suppressed = null;
    },
  };
}
