import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  AvailableSocketReport,
  LiveResponse,
  SocketRow,
  SocketValues,
} from "../api/types";
import { helpTopics } from "../help/topics";
import { SocketIO } from "./SocketIO";

beforeEach(() => {
  history.replaceState(null, "", "/?target=host%2Fworker");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

const values = (total: string, current: number | null = 5): SocketValues => ({
  total,
  current,
  average: 2,
  minimum: 0,
  maximum: 9,
});
const row = (
  tid: number,
  name: string,
  kindId: number,
  total: string,
  start = "1",
): SocketRow => ({
  tid,
  name,
  thread_start: start,
  kind:
    kindId === 6
      ? "Application marker"
      : kindId === 1
        ? "TCP IPv4"
        : "Unix stream",
  kind_id: kindId,
  metrics: {
    input: values(total),
    output: values("0", 0),
    messages: values(kindId === 6 ? total : "0"),
  },
});
const report = (
  extra: Partial<AvailableSocketReport> = {},
): AvailableSocketReport => ({
  available: true,
  observer: "900",
  pid: 42,
  process_start: "800",
  messages_enabled: true,
  stale: false,
  stopped: false,
  losses: "0",
  lower_bound: false,
  duration: 60,
  updated: 100,
  gaps: 0,
  truncated: false,
  rate_windows: 10,
  coverage: "Observed socket paths only.",
  totals: {
    input: values("4096", null),
    output: values("0", 0),
    messages: values("3"),
  },
  rows: [
    row(43, "reader", 1, "1024"),
    // The same TID in a later thread generation is a separate row.
    row(43, "reader", 1, "3072", "2"),
    row(44, "unix-io", 3, "10"),
    row(45, "worker", 6, "3"),
  ],
  history: [
    { ts: 1, input: 10, output: 0, messages: null },
    { ts: 2, input: null, output: 0, messages: null },
  ],
  ...extra,
});
const view = (session = "s1", pid = 42): LiveResponse => ({
  health: {
    session,
    pid,
    last_seen: 100,
    sampler_silent: false,
    target_absent: false,
  },
  threads: [],
});
const panel = (session = "s1", pid = 42) => (
  <SocketIO
    view={view(session, pid)}
    context={`host/worker|${session}|${String(pid)}`}
  />
);
function serve(reply: () => Promise<Response>) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(reply);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const rowIds = () =>
  [...document.querySelectorAll<HTMLElement>("#socket-rows tr[data-row]")].map(
    (item) => item.dataset.row,
  );

// Restores phase 1's socket entrypoint check as component behavior.
test("the panel asks the selected target's PID and offers Messages processed", async () => {
  const fetchMock = serve(() => Promise.resolve(Response.json(report())));
  render(panel());
  expect(document.getElementById("socket-panel")).not.toBeNull();
  await screen.findByRole("button", { name: "✓ Messages processed" });
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "/api/socket-io?pid=42&target=host%2Fworker",
  );
  expect(screen.getByRole("status").textContent).toBe(
    "Observing supported paths",
  );
  expect(document.getElementById("socket-scope")?.textContent).toBe(
    "PID 42 · observed for 60.0 seconds · totals since this observer started · observer 900",
  );
  // Unknown current rate and measured zero stay apart.
  const card = (title: string) =>
    [...document.querySelectorAll("#socket-cards .tile")]
      .find((item) => item.querySelector(".label")?.textContent === title)
      ?.querySelector(".value")?.textContent;
  expect(card("Received bytes")).toBe("4.0 KB");
  expect(card("Current rate")).toBe("—");
  fireEvent.click(screen.getByRole("button", { name: "↑ Sent" }));
  expect(card("Current rate")).toBe("0 B /s");
  for (const element of document.querySelectorAll<HTMLElement>(
    "#socket-panel [data-help]",
  ))
    expect(Object.hasOwn(helpTopics, element.dataset.help ?? "")).toBe(true);
});

test("a collector without the endpoint, an unavailable observer and a failed refresh are told apart", async () => {
  let reply: () => Promise<Response> = () =>
    Promise.resolve(Response.json({ error: "not found" }, { status: 404 }));
  vi.useFakeTimers();
  serve(() => reply());
  render(panel());
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(document.getElementById("socket-empty")?.textContent).toBe(
    "This collector does not support socket observations. Use the C++ collector.",
  );
  expect(screen.getByRole("status").textContent).toBe("Not available");
  reply = () =>
    Promise.resolve(
      Response.json({ available: false, reason: "No socket observations." }),
    );
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(document.getElementById("socket-empty")?.textContent).toBe(
    "No socket observations.",
  );
  reply = () =>
    Promise.resolve(Response.json(report({ stale: true, lower_bound: true })));
  await act(() => vi.advanceTimersByTimeAsync(3000));
  const badge = screen.getByRole("status");
  expect(badge.textContent).toBe("Observer silent");
  expect(badge.className).toContain("socket-warning");
  reply = () => Promise.reject(new Error("Connection lost"));
  await act(() => vi.advanceTimersByTimeAsync(3000));
  // The last good report stays, marked stale.
  expect(screen.getByRole("status").textContent).toBe(
    "Report unavailable · stale",
  );
  expect(rowIds()).toHaveLength(3);
});

test("filters change only the breakdown and keep their focus", async () => {
  serve(() => Promise.resolve(Response.json(report())));
  render(panel());
  await screen.findByRole("button", { name: "✓ Messages processed" });
  // Totals sort by exact decimal size; retired generations stay separate.
  expect(rowIds()).toEqual([
    "900|800|43|2|1",
    "900|800|43|1|1",
    "900|800|44|1|3",
  ]);
  const kind = screen.getByRole<HTMLSelectElement>("combobox");
  fireEvent.change(kind, { target: { value: "3" } });
  expect(rowIds()).toEqual(["900|800|44|1|3"]);
  fireEvent.click(screen.getByRole("button", { name: "✓ Messages processed" }));
  expect(kind.disabled).toBe(true);
  expect(rowIds()).toEqual(["900|800|45|1|6"]);
  fireEvent.click(screen.getByRole("button", { name: "↓ Received" }));
  expect(kind.value).toBe("3");
  expect(rowIds()).toEqual(["900|800|44|1|3"]);
  const search = screen.getByRole<HTMLInputElement>("textbox", {
    name: "Find socket thread",
  });
  search.focus();
  fireEvent.change(kind, { target: { value: "" } });
  const wrap = document.getElementById("socket-rows")?.closest(".table-wrap");
  if (!wrap) throw new Error("Missing breakdown table");
  wrap.scrollTop = 50;
  fireEvent.change(search, { target: { value: "READ" } });
  expect(wrap.scrollTop).toBe(0);
  expect(document.activeElement).toBe(search);
  expect(rowIds()).toEqual(["900|800|43|2|1", "900|800|43|1|1"]);
  expect(document.getElementById("socket-row-count")?.textContent).toBe("(2)");
  expect(document.getElementById("socket-cards")?.textContent).toContain(
    "4.0 KB",
  );
  fireEvent.change(search, { target: { value: "nothing" } });
  expect(document.querySelector("#socket-rows td")?.textContent).toBe(
    "No matching threads.",
  );
});

test("a kind absent from a fresh report is cleared", async () => {
  vi.useFakeTimers();
  let current = report();
  serve(() => Promise.resolve(Response.json(current)));
  render(panel());
  await act(() => vi.advanceTimersByTimeAsync(10));
  const kind = screen.getByRole<HTMLSelectElement>("combobox");
  fireEvent.change(kind, { target: { value: "3" } });
  current = report({ rows: [row(43, "reader", 1, "1024")] });
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(kind.value).toBe("");
  expect(rowIds()).toEqual(["900|800|43|1|1"]);
});

test("a held breakdown keeps its rows; a new session discards them at once", async () => {
  vi.useFakeTimers();
  let current = report();
  const fetchMock = serve(() => Promise.resolve(Response.json(current)));
  const { rerender } = render(panel());
  await act(() => vi.advanceTimersByTimeAsync(10));
  const table = document.getElementById("socket-rows")?.closest(".table-wrap")
    ?.parentElement as HTMLElement;
  fireEvent.mouseEnter(table);
  current = report({ rows: [row(46, "new", 1, "99999")] });
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(rowIds(), "held under the pointer").toHaveLength(3);
  // The cards are not held, so they show the newest report.
  fireEvent.mouseLeave(table);
  expect(rowIds()).toEqual(["900|800|46|1|1"]);
  fireEvent.mouseEnter(table);
  // A new observer in the same session ends the hold of the old one's rows.
  current = report({ observer: "905", rows: [row(46, "new", 1, "99999")] });
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(rowIds()).toEqual(["905|800|46|1|1"]);
  const remounted = document
    .getElementById("socket-rows")
    ?.closest(".table-wrap")?.parentElement;
  if (!remounted) throw new Error("Missing breakdown");
  fireEvent.mouseEnter(remounted);
  // A restart while held: the request for the old session answers last.
  let late: (response: Response) => void = () => undefined;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        late = resolve;
      }),
  );
  await act(() => vi.advanceTimersByTimeAsync(3000));
  current = report({
    observer: "901",
    process_start: "801",
    rows: [row(47, "restarted", 1, "1")],
  });
  rerender(panel("s2"));
  expect(rowIds(), "nothing of the old session while waiting").toEqual([]);
  await act(() => vi.advanceTimersByTimeAsync(10));
  late(Response.json(report()));
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(rowIds()).toEqual(["901|801|47|1|1"]);
});

test("the setup details stay open across polls", async () => {
  vi.useFakeTimers();
  serve(() => Promise.resolve(Response.json(report())));
  render(panel());
  await act(() => vi.advanceTimersByTimeAsync(10));
  const details = document.querySelector<HTMLDetailsElement>(
    "#socket-panel details",
  );
  if (!details) throw new Error("Missing setup details");
  details.open = true;
  await act(() => vi.advanceTimersByTimeAsync(6000));
  expect(details.open).toBe(true);
  expect(details.isConnected).toBe(true);
});
