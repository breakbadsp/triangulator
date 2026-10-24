import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { LiveResponse, Thread } from "../api/types";
import { emptySeries } from "../lib/series";
import type { SelectedThread } from "../lib/threadView";
import { view as liveView } from "../lib/test-fixtures";
import { ThreadDrawer } from "./ThreadDrawer";

const one: Thread = {
  tid: 7,
  name: "worker-7",
  generation: 1,
  state: "sleep",
  cpu_pct: 0,
  last_sample: 1000,
};
const two: Thread = { ...one, tid: 8, name: "worker-8" };
const selected = (thread: Thread): SelectedThread => ({
  session: "s",
  tid: thread.tid,
  generation: thread.generation,
  name: thread.name,
});
const live = liveView({ threads: [one, two] });
const close = vi.fn();
function Drawer({
  thread,
  view = live,
}: {
  thread: SelectedThread | null;
  view?: LiveResponse;
}) {
  return (
    <ThreadDrawer
      view={view}
      series={emptySeries}
      selected={thread}
      now={1000}
      onClose={close}
    />
  );
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  close.mockClear();
});
const emptyHistory = () => Response.json({ rows: [], truncated: false });

// Old tests 356 and 378: ranges persist across close and another thread.
test("the custom history interval and open table survive closing and changing threads", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(emptyHistory()));
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(<Drawer thread={selected(one)} />);
  await screen.findByText(/0 summaries/);
  expect(
    document.querySelector('[data-range="3600"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
  const from = screen.getByLabelText<HTMLInputElement>("From"),
    to = screen.getByLabelText<HTMLInputElement>("To");
  const range = ["2026-10-23T10:00", "2026-10-23T10:15"];
  fireEvent.change(from, { target: { value: range[0] } });
  fireEvent.change(to, { target: { value: range[1] } });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  await screen.findByText(/2026-10-23 10:00/);
  const table = document.querySelector<HTMLDetailsElement>("#history details");
  if (!table) throw new Error("Missing history table");
  table.open = true;
  rerender(<Drawer thread={null} />);
  rerender(<Drawer thread={selected(two)} />);
  const lastQuery = () => {
    const input = fetcher.mock.calls.at(-1)?.[0];
    if (typeof input !== "string") throw new Error("Missing history URL");
    return new URL(input, "http://test").searchParams;
  };
  await waitFor(() => {
    expect(lastQuery().get("tid")).toBe("8");
  });
  expect([from.value, to.value]).toEqual(range);
  expect(table.open).toBe(true);
  const query = lastQuery();
  expect(query.get("start")).toBe(
    String(new Date(range[0] ?? "").getTime() / 1000),
  );
  expect(query.get("end")).toBe(
    String(new Date(range[1] ?? "").getTime() / 1000),
  );
  expect(
    [...document.querySelectorAll("[data-range]")].every(
      (button) => button.getAttribute("aria-pressed") === "false",
    ),
  ).toBe(true);
});

test("a 15 min preset replaces a custom history range and survives another thread", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(emptyHistory()));
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(<Drawer thread={selected(one)} />);
  await screen.findByText(/0 summaries/);
  fireEvent.change(screen.getByLabelText("From"), {
    target: { value: "2026-10-23T10:00" },
  });
  fireEvent.change(screen.getByLabelText("To"), {
    target: { value: "2026-10-23T11:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load" }));
  await screen.findByText(/2026-10-23 10:00/);
  fireEvent.click(screen.getByRole("button", { name: "15 min" }));
  rerender(<Drawer thread={null} />);
  rerender(<Drawer thread={selected(two)} />);
  await waitFor(() => {
    const urls = fetcher.mock.calls
      .map(([input]) => (typeof input === "string" ? input : ""))
      .filter((url) => url.startsWith("/api/history?"));
    const query = new URL(urls.at(-1) ?? "", "http://test").searchParams;
    expect(query.get("tid")).toBe("8");
    expect(Number(query.get("end")) - Number(query.get("start"))).toBe(900);
  });
  expect(
    document.querySelector('[data-range="900"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
});

test("Escape closes drawer help before it closes the drawer", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(emptyHistory())),
  );
  render(<Drawer thread={selected(one)} />);
  await screen.findByText(/0 summaries/);
  const initialHelp = document.querySelector<HTMLButtonElement>(
    ".help-card .help-close",
  );
  if (initialHelp) fireEvent.click(initialHelp);
  const historyHelp = document.querySelector<HTMLElement>(
    "#history [data-help='history']",
  );
  if (!historyHelp) throw new Error("Missing history help");
  fireEvent.focus(historyHelp);
  expect(document.querySelector(".help-card")).not.toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(document.querySelector(".help-card")).toBeNull();
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

test("Escape closes focused history help and cancels an earlier pending hover", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(emptyHistory())),
  );
  render(<Drawer thread={selected(one)} />);
  await screen.findByText(/0 summaries/);
  vi.useFakeTimers();
  const historyHelp = document.querySelector<HTMLElement>(
    "#history [data-help='history']",
  );
  const closeHelp = screen
    .getByRole("button", { name: "Close thread details" })
    .closest("[data-help]");
  if (!historyHelp || !closeHelp) throw new Error("Missing drawer help");
  act(() => {
    historyHelp.focus();
    vi.advanceTimersByTime(250);
  });
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  expect(screen.getByRole("dialog", { name: "History" })).toBeDefined();
  fireEvent.mouseLeave(historyHelp);
  fireEvent.mouseEnter(closeHelp);
  act(() => {
    vi.advanceTimersByTime(1199);
  });
  expect(document.activeElement).toBe(historyHelp);
  fireEvent.keyDown(historyHelp, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(close).not.toHaveBeenCalled();
  act(() => {
    vi.advanceTimersByTime(1200);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.keyDown(historyHelp, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
});

test("a late response for another thread cannot replace the current history", async () => {
  const pending: {
    resolve: (value: Response) => void;
    signal: AbortSignal | null | undefined;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(
      (_, options) =>
        new Promise((resolve) => {
          pending.push({ resolve, signal: options?.signal });
        }),
    ),
  );
  const { rerender } = render(<Drawer thread={selected(one)} />);
  rerender(<Drawer thread={selected(two)} />);
  expect(pending[0]?.signal?.aborted).toBe(true);
  await act(async () => {
    pending[1]?.resolve(emptyHistory());
    await Promise.resolve();
  });
  expect(screen.getByText(/0 summaries/)).toBeDefined();
  await act(async () => {
    pending[0]?.resolve(Response.json({ rows: [], truncated: true }));
    await Promise.resolve();
  });
  expect(screen.queryByText(/First 2,000/)).toBeNull();
  expect(screen.getByText(/0 summaries/)).toBeDefined();
});

// Old test 2515: the watch line uses the latest sample, including stale data.
test("the drawer explains watched thread activity and rejects reused thread identity", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(emptyHistory())),
  );
  const watched = { ...one, wake_ms: 500, last_ran: 990 };
  const { rerender } = render(
    <Drawer thread={selected(one)} view={liveView({ threads: [watched] })} />,
  );
  expect(
    screen.getByText(/Watched: wakes at least every 500 ms/).textContent,
  ).toContain("overdue");
  rerender(
    <Drawer
      thread={selected(one)}
      view={liveView({ threads: [{ ...watched, stale: true }] })}
    />,
  );
  expect(screen.getByText(/Watched:/).textContent).not.toContain("overdue");
  rerender(
    <Drawer
      thread={selected(one)}
      view={liveView({ threads: [{ ...watched, generation: 2 }] })}
    />,
  );
  expect(screen.getByText(/This thread is no longer reported/)).toBeDefined();
  expect(screen.queryByText(/Watched:/)).toBeNull();
  const helpClose = document.querySelector<HTMLButtonElement>(
    ".help-card .help-close",
  );
  if (helpClose) fireEvent.click(helpClose);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  await screen.findByText(/0 summaries/);
});

test("stored history cells keep their metric help and distinguish read from write", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(() =>
      Promise.resolve(
        Response.json({
          rows: [
            {
              ts: 990,
              cpu_pct: 10,
              run_delay_pct: 0,
              read_bps: 1024,
              write_bps: 2048,
              samples: 20,
              expected_samples: 20,
              valid: true,
              sample_counts: { futex: 10, running: 10 },
            },
            {
              ts: 1000,
              cpu_pct: 20,
              run_delay_pct: 0,
              read_bps: 2048,
              write_bps: 4096,
              samples: 20,
              expected_samples: 20,
              valid: true,
              sample_counts: { running: 20 },
            },
          ],
          truncated: false,
        }),
      ),
    ),
  );
  render(<Drawer thread={selected(one)} />);
  await screen.findByText(/2 summaries/);
  expect(document.querySelector("#history-cpu svg polygon")).not.toBeNull();
  expect(document.querySelector("#history-states svg polygon")).not.toBeNull();
  expect(document.querySelector("#legend")?.textContent).toContain(
    "Futex wait",
  );
  const table = document.querySelector<HTMLDetailsElement>("#history details");
  if (!table) throw new Error("Missing table");
  table.open = true;
  const cells = table.querySelectorAll("tbody td");
  vi.useFakeTimers();
  try {
    const read = cells[10],
      write = cells[11];
    if (!read || !write) throw new Error("Missing I/O cells");
    fireEvent.mouseMove(read, { clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(
      screen.getByRole("dialog", { name: "Disk & syscall I/O" }).textContent,
    ).toContain("2.0 KB");
    fireEvent.mouseMove(write, { clientX: 20, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    const card = screen.getByRole("dialog", { name: "Disk & syscall I/O" });
    expect(card.textContent).toContain("4.0 KB");
    expect(card.textContent).toContain("Write/s");
    expect(card.textContent).not.toContain("2.0 KB");
  } finally {
    vi.useRealTimers();
  }
});
