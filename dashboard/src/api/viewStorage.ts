const storageKey = (name: string, target: string) =>
  target ? `${name}:${target}` : name;
const DEPARTURE = "triangulator:departure";
/** Entry names that a target switch clears for both targets. */
export const VIEW_CACHES = [
  "triangulator:buffer",
  "triangulator:threads",
  "triangulator:frozen",
] as const;
export function clearViewCaches(target: string) {
  for (const name of VIEW_CACHES)
    try {
      sessionStorage.removeItem(storageKey(name, target));
    } catch {
      /* Storage is blocked. */
    }
}
/**
 * A click cannot know whether the navigation completes, and a page that stays
 * gets no event. The click only records where the tab is heading.
 */
export function markDeparture(from: string, to: string) {
  try {
    sessionStorage.setItem(DEPARTURE, JSON.stringify([from, to]));
  } catch {
    /* Storage is blocked: the caches stay. */
  }
}
/**
 * Runs when a page loads. The caches go only when this page is the recorded
 * destination, so a reload of the source or a visit elsewhere keeps them.
 * Any page load consumes the intent.
 */
export function settleArrival(target: string) {
  try {
    const raw = sessionStorage.getItem(DEPARTURE);
    if (raw === null) return;
    sessionStorage.removeItem(DEPARTURE);
    const intent: unknown = JSON.parse(raw);
    if (
      Array.isArray(intent) &&
      intent.length === 2 &&
      intent.every((key) => typeof key === "string") &&
      intent[1] === target &&
      intent[0] !== target
    )
      intent.forEach(clearViewCaches);
  } catch {
    /* Storage is blocked or the intent is unreadable: the caches stay. */
  }
}
