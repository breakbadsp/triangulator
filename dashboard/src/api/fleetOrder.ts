const ORDER_KEY = "triangulator:fleet-order";
export function readTileOrder(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
    return Array.isArray(saved)
      ? saved.filter((key): key is string => typeof key === "string")
      : [];
  } catch {
    return [];
  }
}
export function saveTileOrder(order: readonly string[]) {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    /* Storage is blocked: the order lasts until the page closes. */
  }
}
