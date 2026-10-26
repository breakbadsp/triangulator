import { HELP_DELAY } from "../help/createHelpTimer";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { LiveResponse, Thread } from "../api/types";
import { emptySeries, ingest, type Point, type Series } from "../lib/series";
import { view as liveView } from "../lib/test-fixtures";
import { initialThreadView, threadView } from "../lib/threadView";
import { Threads } from "./Threads";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

const thread = (tid: number, extra: Partial<Thread> = {}): Thread => ({
  tid,
  name: `worker-${String(tid)}`,
  generation: 1,
  group: "main",
  state: "running",
  wchan: "",
  state_mix: { running: 20 },
  cpu_pct: 5,
  run_delay_pct: 0,
  switches_per_s: 10,
  read_bps: 0,
  write_bps: 0,
  major_faults_per_s: 0,
  cpu: 0,
  last_sample: 1000,
  ...extra,
});
function Page({ view, series }: { view: LiveResponse; series: Series }) {
  const [shown, dispatch] = useReducer(threadView, initialThreadView);
  return (
    <Threads
      view={view}
      series={series}
      windowSecs={300}
      threadView={shown}
      dispatch={dispatch}
      onOpen={() => undefined}
    />
  );
}
const point = (t: number, s: Record<string, number>): Point => ({
  t,
  cpu: 0,
  rd: 0,
  sw: 0,
  rb: 0,
  wb: 0,
  mf: 0,
  n: 0,
  busy: 0,
  active: 0,
  s,
  born: 0,
  died: 0,
  rss: null,
  vm: null,
});
const advance = (ms: number) => {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

// Old test 258.
test("thread state charts keep Other and No access separate, including earlier samples", () => {
  const series: Series = {
    ...emptySeries,
    lastTick: 2,
    points: [
      point(1, { running: 1, sleep: 4, other: 2, no_access: 3 }),
      point(2, { running: 1, sleep: 4 }),
    ],
  };
  const { container } = render(
    <Page view={liveView({ threads: [] })} series={series} />,
  );
  const fills = [...container.querySelectorAll("#chart-states polygon")].map(
    (polygon) => polygon.getAttribute("fill"),
  );
  const legend = [
    ...container.querySelectorAll("#states-legend [data-help]"),
  ].map((item) => [
    item.querySelector(".sw")?.className,
    item.textContent,
    item.getAttribute("data-help"),
  ]);
  for (const [state, label, count] of [
    ["running", "Running", 1],
    ["sleep", "Sleep", 4],
    ["other", "Other", 0],
    ["no_access", "No access", 0],
  ] as const) {
    expect(fills).toContain(`var(--s-${state})`);
    // Each state remains in the legend when only an earlier sample has it.
    expect(legend).toContainEqual([
      `sw ${state}`,
      label + String(count),
      state,
    ]);
  }
});

// Old test 276.
test("wait channels use thread state colors and neutral colors for mixed groups", () => {
  const bars = (threads: Thread[]) => {
    const { container, unmount } = render(
      <Page view={liveView({ threads })} series={emptySeries} />,
    );
    const rows = [...container.querySelectorAll("#wchan-bars .bar-row")].map(
      (row) => ({
        label: row.querySelector(".name")?.textContent,
        color: row.querySelector<HTMLElement>(".fill")?.style.background,
      }),
    );
    unmount();
    return rows;
  };
  const states = [
    "futex",
    "poll",
    "socket",
    "pipe",
    "sleep",
    "stopped",
    "kernel",
    "other",
    "no_access",
  ];
  const all = bars([
    ...states.map((state, index) =>
      thread(index + 1, { state, wchan: state + "-wait" }),
    ),
    thread(99, { state: "running", wchan: "" }),
  ]);
  expect(all, "running threads are not waiting").toHaveLength(states.length);
  for (const state of states)
    expect(all.find((bar) => bar.label === state + "-wait")?.color).toBe(
      `var(--s-${state})`,
    );
  expect(
    bars([
      thread(1, { state: "sleep", wchan: "shared" }),
      thread(2, { state: "kernel", wchan: "shared" }),
    ])[0]?.color,
  ).toBe("var(--s-other)");
  const collapsed = bars(
    Array.from({ length: 12 }, (_, index) =>
      thread(index + 1, { state: "sleep", wchan: `timer-${String(index)}` }),
    ),
  );
  expect(collapsed).toHaveLength(10);
  expect(collapsed.at(-1)?.label).toBe("3 others");
  expect(
    collapsed.at(-1)?.color,
    "combined channels do not imply one state",
  ).toBe("var(--s-other)");
});

// D3: the 5 min order comes from the held series too.
test("a poll that reverses the 5 min averages does not move the hovered tile", () => {
  // Thread 1 was busy first, then thread 2: the averages cross over.
  let series = emptySeries;
  const views: LiveResponse[] = [];
  for (let step = 0; step < 12; step++) {
    const t = 1000 + step * 10;
    const busyFirst = step < 6;
    views.push(
      liveView({
        threads: [
          thread(1, { cpu_pct: busyFirst ? 90 : 0, last_sample: t }),
          thread(2, { cpu_pct: busyFirst ? 0 : 99, last_sample: t }),
        ],
      }),
    );
  }
  const seriesAt = (count: number) => {
    series = emptySeries;
    for (const item of views.slice(0, count)) series = ingest(series, item);
    return series;
  };
  const order = () =>
    [...document.querySelectorAll("#mosaic .cell")].map((cell) =>
      cell.getAttribute("data-tid"),
    );
  // The latest view has both threads at the same CPU, so only the window
  // average decides the order.
  const latest = (count: number) =>
    liveView({
      threads: [
        thread(1, { cpu_pct: 1, last_sample: 1000 + (count - 1) * 10 }),
        thread(2, { cpu_pct: 1, last_sample: 1000 + (count - 1) * 10 }),
      ],
    });
  const { rerender } = render(<Page view={latest(7)} series={seriesAt(7)} />);
  fireEvent.click(screen.getByRole("button", { name: "5 min" }));
  // A click on a control opens its help at once; close it first.
  fireEvent.keyDown(document, { key: "Escape" });
  expect(order()).toEqual(["1", "2"]);
  const tile = document.querySelector<HTMLElement>('#mosaic [data-tid="1"]');
  if (!tile) throw new Error("no tile");
  fireEvent.mouseEnter(tile);
  fireEvent.mouseMove(tile, { clientX: 20, clientY: 20 });
  advance(HELP_DELAY);
  const card = screen.getByRole("dialog", { name: "Thread map" });
  expect(card.textContent).toContain("worker-1 (1)");
  // The pointer moves into the card; the next polls arrive.
  fireEvent.mouseLeave(tile, { relatedTarget: card });
  fireEvent.mouseEnter(card, { relatedTarget: tile });
  rerender(<Page view={latest(12)} series={seriesAt(12)} />);
  expect(order()).toEqual(["1", "2"]);
  expect(screen.getByRole("dialog").textContent).toContain("worker-1 (1)");
  // When the pointer leaves, the map shows the latest averages.
  fireEvent.mouseLeave(card);
  rerender(<Page view={latest(12)} series={seriesAt(12)} />);
  expect(order()).toEqual(["2", "1"]);
});

// D1: Read/s and Write/s share the topic, not the readout.
test("moving from Read/s to Write/s on one row shows the Write/s value", () => {
  render(
    <Page
      view={liveView({
        threads: [thread(7, { read_bps: 2048, write_bps: 4096 })],
      })}
      series={emptySeries}
    />,
  );
  const row = document.querySelector('#threads [data-tid="7"]');
  const [read, write] = [7, 8].map((index) => row?.children[index]);
  if (!read || !write) throw new Error("no cells");
  fireEvent.mouseMove(read, { clientX: 10, clientY: 10 });
  advance(HELP_DELAY);
  const card = () => screen.getByRole("dialog", { name: "Disk & syscall I/O" });
  expect(card().textContent).toContain("Read/s");
  expect(card().textContent).toContain("2.0 KB");
  fireEvent.mouseMove(write, { clientX: 60, clientY: 10 });
  advance(HELP_DELAY);
  expect(card().textContent).toContain("Write/s");
  expect(card().textContent).toContain("4.0 KB");
  expect(card().textContent).not.toContain("2.0 KB");
});

test("a focused row keeps the focus when the sort moves it, and the table holds during polls", () => {
  const view = (cpu: number) =>
    liveView({
      threads: [
        thread(1, { cpu_pct: 50 }),
        thread(2, { cpu_pct: cpu, name: "alpha" }),
      ],
    });
  const { rerender } = render(<Page view={view(10)} series={emptySeries} />);
  const rows = () =>
    [...document.querySelectorAll("#threads tr[data-tid]")].map((row) =>
      row.getAttribute("data-tid"),
    );
  const header = (label: string) =>
    screen.getByText(label, { selector: "th > span" });
  const row = document.querySelector<HTMLElement>('#threads [data-tid="1"]');
  if (!row) throw new Error("no row");
  act(() => {
    row.focus();
  });
  expect(rows()).toEqual(["1", "2"]);
  // Focus in the table holds it: a poll that would reorder the rows waits.
  rerender(<Page view={view(90)} series={emptySeries} />);
  expect(rows()).toEqual(["1", "2"]);
  // A sort is the reader's choice, so it applies to the held rows at once,
  // and the moved row keeps the focus.
  fireEvent.click(header("Thread"));
  expect(rows()).toEqual(["2", "1"]);
  expect(document.activeElement).toBe(row);
  fireEvent.click(header("CPU"));
  expect(rows(), "the held poll").toEqual(["1", "2"]);
  // After the focus leaves, the latest poll shows.
  fireEvent.blur(row);
  expect(rows()).toEqual(["2", "1"]);
});

test("a missing CPU rate stays unavailable in the held cell and its card during polls", () => {
  const make = (cpu: number | null) =>
    liveView({ threads: [thread(7, { cpu_pct: cpu })] });
  const { rerender } = render(<Page view={make(null)} series={emptySeries} />);
  const row = document.querySelector<HTMLElement>('#threads [data-tid="7"]');
  const cell = row?.children[4];
  if (!cell) throw new Error("Missing CPU cell");
  fireEvent.mouseEnter(cell);
  fireEvent.mouseMove(cell, { clientX: 10, clientY: 10 });
  advance(HELP_DELAY);
  const card = screen.getByRole("dialog", { name: "CPU" });
  expect(card.textContent).toContain("Not available");
  fireEvent.mouseLeave(cell, { relatedTarget: card });
  fireEvent.mouseEnter(card, { relatedTarget: cell });
  rerender(<Page view={make(90)} series={emptySeries} />);
  expect(cell.textContent).toContain("—");
  expect(card.textContent).toContain("Not available");
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.mouseMove(document.body, { clientX: 1, clientY: 1 });
  rerender(<Page view={make(90)} series={emptySeries} />);
  expect(cell.textContent).toContain("90.0%");
});
