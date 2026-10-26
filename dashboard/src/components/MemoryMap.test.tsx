import { HELP_DELAY } from "../help/createHelpTimer";
// Ported from 777cf3a:tests/dashboard_test.js (old start lines in names),
// with the D1 identity case of PR 165.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type {
  LiveResponse,
  MemoryLayout,
  MemoryRegion,
  MemorySummary,
} from "../api/types";
import { helpTopics } from "../help/topics";
import { useObservation } from "../hooks/useObservation";
import { initialMemory } from "../lib/memoryView";
import type { ResourcePoint } from "../lib/assess/memory";
import { emptySeries } from "../lib/series";
import { NOW, memorySummary, rssHistory, view } from "../lib/test-fixtures";
import { MemoryMap } from "./MemoryMap";

let server: MemoryLayout = { available: false };
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem("triangulator:fold:memory", "open");
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(() => Promise.resolve(Response.json(server))),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const hex = (value: number) => "0x" + value.toString(16);
const region = (
  start: number,
  size: number,
  kind: string,
  permissions = "rw-p",
  name = "",
): MemoryRegion => ({
  start: hex(start),
  end: hex(start + size),
  size,
  vmas: 1,
  kind,
  permissions,
  name,
});
interface Process {
  session?: string;
  pid?: number;
  comm?: string;
  seq?: number;
  updated?: number;
  heap?: number;
  values?: MemorySummary["values"];
  extra?: Partial<LiveResponse>;
}
function processView({
  session = "s",
  pid = 1,
  comm = "app",
  seq = 1,
  updated = NOW - 5,
  heap = 1 << 20,
  values = {},
  extra = {},
}: Process = {}) {
  const id = `${session}:${String(seq)}`;
  server = {
    available: true,
    id,
    pid,
    updated,
    regions: [
      region(0x7ffc00000000, 0x21000, "stack"),
      region(0x555500400000, heap, "heap"),
      region(0x555500000000, 0x200000, "file", "r-xp", `/usr/bin/${comm}`),
    ],
  };
  return view({
    health: { ...view().health, session, pid },
    threads: [{ tid: pid, name: comm }] as LiveResponse["threads"],
    memory: memorySummary(values, {
      pid,
      updated,
      layout_id: id,
      interval_s: 30,
    }),
    ...extra,
  });
}
function Harness({
  live,
  points = [],
}: {
  live: LiveResponse;
  points?: readonly ResourcePoint[];
}) {
  const memory = useObservation("t", { view: live, now: NOW }, 900);
  return (
    <MemoryMap
      view={live}
      now={NOW}
      memory={memory.observation?.memory ?? initialMemory}
      dispatch={memory.memory}
      series={emptySeries}
      resourcePoints={points}
      scope="cgroup"
    />
  );
}
const settle = () => act(() => vi.advanceTimersByTimeAsync(10));
const byId = (id: string) => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no #${id}`);
  return element;
};
const factValue = (label: string) =>
  screen.getByText(label, { selector: "dt" }).nextElementSibling?.textContent;
const tile = (label: string) =>
  [...(screen.getByText(label).closest(".tile")?.children ?? [])].map(
    (child) => child.textContent,
  );

for (const [change, next] of [
  ["session", { session: "s2", comm: "newapp" }],
  ["PID", { pid: 2, seq: 2, comm: "newapp" }],
] as const)
  test(`D1 a ${change} change during hover and focus drops the old process and keeps the disclosures open`, async () => {
    const { rerender } = render(
      <Harness live={processView({ comm: "oldapp" })} />,
    );
    await settle();
    const fold = byId("memory-map").querySelector("details[data-fold]");
    const details = byId("memory-region-details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    const bar = screen.getByRole("button", {
      name: /oldapp \(program image\)/,
    });
    fireEvent.mouseEnter(byId("memory-amap").closest(".card") as Element);
    act(() => {
      bar.focus();
    });
    fireEvent.mouseMove(bar, { clientX: 20, clientY: 20 });
    await act(() => vi.advanceTimersByTimeAsync(HELP_DELAY));
    expect(screen.getByRole("dialog").textContent).toContain("oldapp");

    rerender(<Harness live={processView(next)} />);
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect((byId("memory-region-details") as HTMLDetailsElement).open).toBe(
      true,
    );
    expect(fold?.hasAttribute("open")).toBe(true);
    expect(screen.queryAllByRole("dialog")).toEqual([]);
    expect(document.body.textContent).not.toContain("oldapp");
    expect(
      screen.getByRole("button", { name: /newapp \(program image\)/ }),
    ).toBeDefined();
  });

for (const [change, next] of [
  ["session", { session: "s2" }],
  ["PID", { pid: 2, seq: 2 }],
] as const)
  for (const label of ["Memory map", "Address space & zoom"])
    for (const phase of ["pending", "open"])
      test(`D1 a ${change} change cancels ${phase} ${label} help and keeps the disclosures open`, async () => {
        const { rerender } = render(<Harness live={processView()} />);
        await settle();
        const fold = byId("memory-map").querySelector("details[data-fold]");
        const details = byId("memory-region-details") as HTMLDetailsElement;
        details.open = true;
        fireEvent(details, new Event("toggle"));
        const help = screen
          .getByRole("heading", { name: label })
          .closest("[data-help]") as Element;
        fireEvent.mouseEnter(help);
        await act(() =>
          vi.advanceTimersByTimeAsync(phase === "pending" ? 600 : HELP_DELAY),
        );
        expect(screen.queryAllByRole("dialog")).toHaveLength(
          phase === "pending" ? 0 : 1,
        );

        rerender(<Harness live={processView(next)} />);
        await settle();
        expect(screen.queryAllByRole("dialog")).toEqual([]);
        await act(() => vi.advanceTimersByTimeAsync(5000));
        expect(screen.queryAllByRole("dialog")).toEqual([]);
        expect(byId("memory-map").querySelector("details[data-fold]")).toBe(
          fold,
        );
        expect(fold?.hasAttribute("open")).toBe(true);
        expect((byId("memory-region-details") as HTMLDetailsElement).open).toBe(
          true,
        );
      });

test("2138 a held zoom shows its snapshot until release, and other parts are not held", async () => {
  const live = (size: number, vmas: number) =>
    processView({
      updated: NOW - 5,
      values: { vm_size_bytes: size, vma_count: vmas },
    });
  const { rerender } = render(<Harness live={live(4 << 20, 100)} />);
  await settle();
  expect(factValue("Share of VmSize")).toBe("25.0%");
  const zoom = byId("memory-zoom-facts").closest(".card") as Element;
  fireEvent.mouseEnter(zoom);
  rerender(<Harness live={live(8 << 20, 777)} />);
  expect(factValue("Share of VmSize")).toBe("25.0%");
  expect(tile("Mappings (VMAs)")[1]).toBe("777");
  fireEvent.mouseLeave(zoom);
  expect(factValue("Share of VmSize")).toBe("12.5%");
});

test("1801 the resident tile uses the steady RSS trend", async () => {
  const history = rssHistory([[7, 300, 100, 2]], { dip: 15 });
  render(
    <Harness
      live={processView({
        pid: 7,
        extra: { resources: history.view.resources },
      })}
      points={history.points}
    />,
  );
  await settle();
  expect(tile("Resident (RSS)")[2]).toMatch(
    /^▲ 1[12][0-9](\.[0-9])? MiB \/ min$/,
  );
});

test("2015 memory tile, meter, fact and chart labels resolve to a real topic", async () => {
  render(<Harness live={processView()} />);
  await settle();
  const labels = [
    "Virtual size (VmSize)",
    "Resident (RSS)",
    "Anonymous / file / shared",
    "Mappings (VMAs)",
    "Major faults",
    "Memory pressure (PSI some)",
    "Mappings",
    "Address space",
    "Main stack",
    "Peak virtual size",
    "Data + heap (VmData)",
    "Page tables",
    "Locked",
    "Page faults since start",
    "Longest maps read",
    "Size (mapped)",
    "Largest unmapped gap",
    "Heap mapping size change",
    "Page size",
    "Heap mapping end ↑",
    "Main stack start ↓",
    "Resident anonymous",
    "Member regions",
    "Thread stacks",
  ];
  const topic = (label: string) =>
    screen
      .getAllByText(label)
      .map(
        (element) => element.closest<HTMLElement>("[data-help]")?.dataset.help,
      );
  for (const label of labels)
    for (const id of topic(label))
      expect(Object.hasOwn(helpTopics, id ?? ""), label).toBe(true);
  expect(topic("Data + heap (VmData)")).toEqual(["vmdata"]);
  expect(topic("Page faults since start")).toEqual(["faulttotals"]);
  expect(topic("Major faults")).toEqual(["faults"]);
  expect(topic("Largest unmapped gap")).toEqual(["memgap"]);
});

test("2066 the zoom legend in the page names the grid's kinds", async () => {
  render(<Harness live={processView({ heap: 0x3000 })} />);
  await settle();
  const legend = [...byId("memory-grid-legend").children].map((item) => [
    item.textContent,
    item.firstElementChild?.className,
  ]);
  expect(legend).toContainEqual(["heap (brk)", "sw "]);
  // The heap's display margin is not mapped.
  expect(legend).toContainEqual(["not mapped", "sw cell-none"]);
});

test("2153 2232 the zoom caption and boundary chart in the page", async () => {
  const { rerender } = render(<Harness live={processView()} />);
  await settle();
  expect(byId("memory-grid-caption").textContent).toMatch(
    /^Top = high address\. One square = \d+ bytes, \d+ squares\./,
  );
  rerender(
    <Harness
      live={processView({ seq: 2, updated: NOW + 25, heap: (1 << 20) + 4096 })}
    />,
  );
  await settle();
  // The summary names a layout that never arrives: a missing sample.
  const lagging = processView({ seq: 3, updated: NOW + 55 });
  server = { ...server, available: false };
  rerender(<Harness live={lagging} />);
  await settle();
  rerender(<Harness live={processView({ seq: 4, updated: NOW + 85 })} />);
  await settle();
  const heap = screen.getByRole("img", { name: /^Heap mapping end ↑/ });
  expect(heap.querySelectorAll("polyline").length).toBe(2);
  expect(heap.getAttribute("aria-label")).toBe(
    "Heap mapping end ↑: Offset: 0 B → 0 B",
  );
});

test("null, zero and unknown values show as unknown, with byte units", async () => {
  render(
    <Harness
      live={processView({
        heap: 2 ** 31,
        values: {
          vma_count: 0,
          max_map_count: 0,
          vm_size_bytes: null,
          address_space_limit_bytes: null,
          stack_limit_bytes: null,
        },
      })}
    />,
  );
  await settle();
  expect(tile("Virtual size (VmSize)")).toEqual([
    "Virtual size (VmSize)",
    "—",
    "limit: unlimited · peak —",
  ]);
  expect(tile("Mappings (VMAs)")).toEqual([
    "Mappings (VMAs)",
    "0",
    "limit unknown",
  ]);
  expect(tile("Anonymous / file / shared")).toEqual([
    "Anonymous / file / shared",
    "—",
    "needs resource samples",
  ]);
  expect(tile("Major faults")).toEqual(["Major faults", "—", "— since start"]);
  expect(factValue("Peak virtual size")).toBe("—");
  expect(factValue("Size (mapped)")).toBe("2.0 GiB");
  expect(factValue("Share of VmSize")).toBe("—");
  expect(factValue("Page size")).toBe("Unknown");
  expect(factValue("Heap mapping size change")).toBe("Collecting…");
  const meters = [...byId("memory-limits").children].map(
    (meter) => meter.textContent,
  );
  expect(meters).toEqual([
    "Mappingsvm.max_map_count0 / 0",
    "Address spaceno RLIMIT_AS limit—",
    "Main stackno RLIMIT_STACK limit132.0 KiB",
  ]);
});

test("a collector without memory samples shows its reason", () => {
  render(
    <Harness
      live={view({
        memory: { available: false, reason: "No memory-map samples yet." },
      })}
    />,
  );
  expect(byId("memory-empty").textContent).toBe("No memory-map samples yet.");
  expect(byId("memory-content").hidden).toBe(true);
});

test("a map under the pointer before its first layout shows the layout when it arrives", async () => {
  render(<Harness live={processView()} />);
  fireEvent.mouseEnter(byId("memory-amap").closest(".card") as Element);
  fireEvent.mouseEnter(byId("memory-zoom-facts").closest(".card") as Element);
  expect(byId("memory-amap").textContent).toContain("No layout yet");
  await settle();
  expect(
    screen.getByRole("button", { name: /app \(program image\)/ }),
  ).toBeDefined();
  expect(factValue("Size (mapped)")).toBe("1.0 MiB");
});
