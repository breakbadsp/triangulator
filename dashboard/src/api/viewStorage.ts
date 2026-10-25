const storageKey = (name: string, target: string) =>
  target ? `${name}:${target}` : name;
/** Old entry names that a target switch clears for both targets. */
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
