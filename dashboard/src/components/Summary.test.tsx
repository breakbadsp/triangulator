import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { LiveResponse, MemorySummary, Resources } from "../api/types";
import { helpTopics } from "../help/topics";
import { assess } from "../lib/assess";
import type { Finding } from "../lib/findings";
import { emptySeries, type Point, type Series } from "../lib/series";
import { watchedThread } from "../lib/test-fixtures";
import css from "../style.css?raw";
import { Summary } from "./Summary";
import { HelpGuideProvider } from "../help/HelpGuide";

vi.mock("../lib/assess", { spy: true });
afterEach(() => {
  vi.mocked(assess).mockRestore();
});

const view = (extra: Partial<LiveResponse> = {}): LiveResponse => ({
  health: {
    session: "s",
    pid: 7,
    last_seen: 3,
    sampler_silent: false,
    target_absent: false,
  },
  threads: [],
  ...extra,
});
const point = (t: number, extra: Partial<Point> = {}): Point => ({
  t,
  cpu: 5,
  rd: 0,
  sw: 0,
  rb: 0,
  wb: 0,
  mf: 0,
  n: 1,
  busy: 0,
  active: 0,
  s: {},
  born: 0,
  died: 0,
  rss: null,
  vm: null,
  l1: null,
  ...extra,
});
const series = (points: Point[]): Series => ({
  ...emptySeries,
  session: "s",
  points,
  lastTick: points.at(-1)?.t ?? 0,
});
function show(live: LiveResponse | undefined, data: Series = emptySeries) {
  return render(
    <Summary
      view={live}
      series={data}
      now={10}
      windowSecs={300}
      onWindow={() => undefined}
      resourcePoints={[]}
      pressureScope="cgroup"
    />,
  );
}

test("each theme gives every thread state a distinct color", () => {
  const palettes = [...css.matchAll(/\{([^{}]*--s-running:[^{}]*)\}/g)];
  expect(palettes, "light, system dark, and explicit dark").toHaveLength(3);
  for (const [, declarations = ""] of palettes) {
    const colors = [...declarations.matchAll(/--s-([\w_]+):([^;]+)/g)];
    expect(colors).toHaveLength(10);
    // Running, Sleep, and every other state must have distinct colors.
    expect(
      new Set(colors.map(([, , color = ""]) => color.trim().toLowerCase()))
        .size,
    ).toBe(10);
  }
});

// With memory sampling off the load chart still supplies points, so the
// memory charts must get no points and a reason instead of drawing bare axes.
test("summary memory charts explain sampling that is off or missing", () => {
  const empty = (container: HTMLElement, id: string) =>
    container.querySelector(`#${id} .chart-empty`)?.textContent ?? null;
  const points = [1, 2, 3].map((t) => point(t));
  const draw = (resources?: Resources, memory?: MemorySummary) => {
    const { container, unmount } = show(
      view({ resources, memory }),
      series(points),
    );
    const result = [
      empty(container, "chart-rss"),
      empty(container, "chart-vm"),
    ];
    unmount();
    return result;
  };
  expect(
    draw({ available: false, reason: "Resource sampling is off." }, undefined),
  ).toEqual([
    "Resource sampling is off.",
    "This collector does not report memory-map samples.",
  ]);
  expect(
    draw({ available: true, stale: true }, { available: true, stale: true }),
  ).toEqual(["Waiting for resource samples…", "Waiting for memory samples…"]);
  const { container } = show(
    view({ resources: { available: true } }),
    series([point(1), point(2, { rss: 2 ** 20 }), point(3)]),
  );
  expect(empty(container, "chart-rss")).toBeNull();
  expect(container.querySelector("#chart-rss svg")).not.toBeNull();
  expect(container.querySelector("#chart-load svg")).not.toBeNull();
});

test("a memory chart reads a missing sample as not available, not 0 B", () => {
  vi.useFakeTimers();
  try {
    const { container } = show(
      view({ resources: { available: true } }),
      series([point(1), point(2, { rss: 2 ** 20 }), point(3)]),
    );
    // jsdom has no layout: the plot spans x=52 (t=1) to x=586 (t=3).
    const hit = container.querySelector("#chart-rss rect") as SVGRectElement;
    fireEvent.pointerMove(hit, { clientX: 586, clientY: 40 });
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    const card = screen.getByRole("dialog");
    expect(card.querySelector(".help-reading")?.textContent).toBe(
      "Not availableResident (RSS)",
    );
  } finally {
    vi.useRealTimers();
  }
});

test("the assessment lists 8 findings and shows the rest on request", () => {
  const findings = (count: number): Finding[] =>
    Array.from({ length: count }, (_, index) => ({
      type: "monitor",
      level: index ? "warning" : "critical",
      title: "F" + String(index),
      detail: "",
    }));
  vi.mocked(assess).mockReturnValue(findings(10));
  const titles = () =>
    within(document.getElementById("findings") as HTMLElement)
      .getAllByRole("listitem")
      .map((row) => row.querySelector(".t")?.textContent);
  const more = () => screen.getByRole("button", { name: /finding/ });
  const { rerender } = show(view());
  expect(titles()).toEqual(["F0", "F1", "F2", "F3", "F4", "F5", "F6", "F7"]);
  expect(more().textContent).toBe("Show 2 more findings");
  expect(more().getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(more());
  expect(titles()).toHaveLength(10);
  expect(more().textContent).toBe("Show fewer findings");
  expect(more().getAttribute("aria-expanded")).toBe("true");
  // A poll keeps the choice and the button element, so it keeps focus.
  const button = more();
  const poll = () => {
    rerender(
      <Summary
        view={view()}
        series={emptySeries}
        now={11}
        windowSecs={300}
        onWindow={() => undefined}
        resourcePoints={[]}
        pressureScope="cgroup"
      />,
    );
  };
  poll();
  expect(titles()).toHaveLength(10);
  expect(more()).toBe(button);
  fireEvent.click(more());
  expect(titles()).toHaveLength(8);
  vi.mocked(assess).mockReturnValue(findings(9));
  poll();
  expect(more().textContent).toBe("Show 1 more finding");
  vi.mocked(assess).mockReturnValue(findings(8));
  poll();
  expect(screen.queryByRole("button", { name: /finding/ })).toBeNull();
  // The worst level sets the verdict and the card's level.
  expect(screen.getByText("Needs attention now").id).toBe("verdict");
  expect(
    document.getElementById("assessment-card")?.getAttribute("data-level"),
  ).toBe("critical");
});

test("the summary shows load, tiles, and trends from the live series", () => {
  const live = view({
    threads: [
      {
        tid: 7,
        generation: 1,
        name: "app",
        last_sample: 3,
        cpu_pct: 150,
        run_delay_pct: 50,
        state: "running",
      },
    ],
  });
  const points = [
    point(1, { cpu: 150, rd: 50, sw: 40, active: 1, s: { running: 1 } }),
    point(2, { cpu: 150, rd: 50, sw: 40, active: 1, s: { running: 1 } }),
  ];
  const { container } = show(live, {
    ...series(points),
    load: { t: 2, averages: [2, 1.5, 1] },
  });
  expect(document.getElementById("overview-sub")?.textContent).toMatch(
    /^app · 1 threads\. Trends kept in this tab since /,
  );
  expect(document.getElementById("hero-load")?.textContent).toBe("2.00");
  expect(document.getElementById("hero-load15")?.textContent).toBe("1.00");
  expect(document.getElementById("hero-load15-label")?.textContent).toBe(
    "15 min (1 s of data)",
  );
  expect(document.getElementById("hero-cpu")?.textContent).toBe("1.50 cores");
  expect(document.getElementById("hero-wait")?.textContent).toBe(
    "25.0% of demand",
  );
  expect(document.getElementById("hero-top")?.textContent).toBe("app · 150%");
  const tiles = [...container.querySelectorAll("#tiles .tile .label")].map(
    (label) => label.textContent,
  );
  expect(tiles).toEqual([
    "Active threads",
    "Context switches",
    "Disk & syscall I/O",
    "Thread churn",
  ]);
  const legend = [...container.querySelectorAll("#load-legend > span")].map(
    (item) => item.textContent,
  );
  expect(legend).toEqual([
    "On CPU1.50",
    "Waiting for CPU0.50",
    "1-min average",
  ]);
  // Every visible part names a registered topic.
  for (const element of container.querySelectorAll<HTMLElement>("[data-help]"))
    expect(Object.hasOwn(helpTopics, element.dataset.help ?? "")).toBe(true);
});

test("before the first live view the summary waits", () => {
  show(undefined);
  expect(screen.getByText("Waiting for data").id).toBe("verdict");
  expect(document.getElementById("hero-load")?.textContent).toBe("—");
  expect(document.querySelectorAll("#tiles .tile")).toHaveLength(0);
});

test.each([
  ["rss", "chart-rss", "chart-vm", "Resident (RSS)", "2 MiB"],
  ["vmsize", "chart-vm", "chart-rss", "Virtual size (VmSize)", "32 MiB"],
])(
  "the %s label guide holds only its own memory chart",
  (topic, heldId, liveId, label, value) => {
    const page = (scale: number) => (
      <HelpGuideProvider>
        <Summary
          view={view()}
          series={series([
            point(1, { rss: 2 ** 20, vm: 16 * 2 ** 20 }),
            point(2, { rss: scale * 2 * 2 ** 20, vm: scale * 32 * 2 ** 20 }),
          ])}
          now={10}
          windowSecs={300}
          onWindow={() => undefined}
          resourcePoints={[]}
          pressureScope="cgroup"
        />
      </HelpGuideProvider>
    );
    const { rerender } = render(page(1));
    const opener = document.querySelector<HTMLElement>(
      `#overview-memory .help-label[data-help='${topic}']`,
    );
    if (!opener) throw Error("Missing memory label");
    act(() => {
      opener.focus();
    });
    fireEvent.click(screen.getByRole("button", { name: "Open metric guide" }));
    const guide = document.getElementById("help-guide");
    if (!guide) throw Error("Missing guide");
    fireEvent.click(within(guide).getByText("View chart data"));
    expect(
      within(guide).getByRole("columnheader", { name: label }),
    ).toBeDefined();
    expect(within(guide).getByRole("cell", { name: value })).toBeDefined();
    const chart = (id: string) =>
      document.getElementById(id)?.querySelector("svg")?.innerHTML;
    const held = chart(heldId),
      updating = chart(liveId),
      rows = guide.querySelector(".help-data")?.textContent;
    expect(held).toBeDefined();
    expect(updating).toBeDefined();
    rerender(page(4));
    expect(chart(heldId)).toBe(held);
    expect(chart(liveId)).not.toBe(updating);
    expect(guide.querySelector(".help-data")?.textContent).toBe(rows);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(chart(heldId)).not.toBe(held);
  },
);

test("a watched finding keeps its help target through live re-renders", () => {
  vi.useFakeTimers();
  try {
    const live = (now: number) => (
      <Summary
        view={view({
          health: {
            session: "s",
            pid: 7,
            last_seen: 1000,
            sample_interval_ms: 200,
            sampler_silent: false,
            target_absent: false,
          },
          threads: [watchedThread(1, "worker-1", { quiet: 30 })],
        })}
        series={emptySeries}
        now={now}
        windowSecs={300}
        onWindow={() => undefined}
        resourcePoints={[]}
        pressureScope="cgroup"
        watchRules={[{ prefix: "worker-", wake_ms: 500 }]}
      />
    );
    const { rerender } = render(live(1000));
    const target = screen
      .getByText("worker-1 stopped waking up")
      .closest<HTMLElement>("[data-help]");
    expect(target?.dataset.help).toBe("watched");
    if (!target) return;
    fireEvent.mouseEnter(target);
    // Live polling re-renders about once a second, before the 1,200 ms help
    // delay ends.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    rerender(live(1001));
    expect(target.isConnected, "the pending row is not replaced").toBe(true);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(
      screen.getByRole("dialog", { name: "Watched threads" }),
      "help opens after 1,200 ms",
    ).toBeDefined();
    rerender(live(1002));
    expect(target.isConnected, "an open card keeps its row too").toBe(true);
    expect(screen.getByRole("dialog", { name: "Watched threads" })).toBe(
      screen.getByRole("dialog"),
    );
  } finally {
    vi.useRealTimers();
  }
});
