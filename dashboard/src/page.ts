export type Page = { kind: "fleet" } | { kind: "target"; key: string };

export function readPage(search = location.search): Page {
  const query = new URLSearchParams(search);
  return query.has("target")
    ? { kind: "target", key: query.get("target") ?? "" }
    : { kind: "fleet" };
}
