import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import type { ResourceRow, Resources } from "../api/types";
import { asResourcePoints, type ResourcePoint } from "../lib/assess/memory";
import { readFileSync } from "node:fs";
import { MemoryUse } from "./MemoryUse";
import type { ResourceRange } from "./Resources";

const MB = 2 ** 20,
  GiB = 2 ** 30,
  HOUR = 3600,
  DAY = 24 * HOUR,
  END = DAY + 1000;
// One stored row each 60 s over the last `seconds`, ending at END.
const rows = (
  seconds: number,
  row: (age: number) => Partial<ResourceRow> = () => ({}),
): ResourcePoint[] =>
  asResourcePoints(
    Array.from({ length: Math.floor(seconds / 60) + 1 }, (_, i) => {
      const age = seconds - i * 60;
      return {
        ts: END - age,
        pid: 1,
        elapsed_s: 60,
        // RSS doubles each 4 h to 4 GiB now; VmSize stays at 300 MiB.
        rss_bytes: Math.round(64 * MB * 2 ** ((DAY - age) / (4 * HOUR))),
        vm_size_bytes: 300 * MB,
        host_mem_total_bytes: 16 * GiB,
        host_mem_available_bytes: 8 * GiB,
        ...row(age),
      };
    }),
  );
const resources: Resources = {
  available: true,
  host_memory: {
    total: 16 * GiB,
    available: 8 * GiB,
    swap_total: 4 * GiB,
    swap_free: 3 * GiB,
  },
};
const day = rows(DAY);
const inRange = (range: number, points: readonly ResourcePoint[] = day) =>
  points.filter((point) => point.t >= END - range);

function Tile({
  dayPoints = day,
  initial = 900,
  recorded = false,
}: {
  dayPoints?: readonly ResourcePoint[];
  initial?: ResourceRange;
  recorded?: boolean;
}) {
  const [range, setRange] = useState<ResourceRange>(initial);
  return (
    <MemoryUse
      resources={resources}
      rangePoints={inRange(range, dayPoints)}
      dayPoints={dayPoints}
      liveRss={undefined}
      liveVm={undefined}
      range={range}
      onRange={setRange}
      recorded={recorded}
    />
  );
}
const text = (root: ParentNode, selector: string) =>
  [...root.querySelectorAll(selector)].map((element) => element.textContent);

test("the tile shows two charts on one time axis, chips, and two bars", () => {
  const { container } = render(<Tile />);
  expect(container.querySelector("h3")?.textContent).toBe("Memory use");
  expect(container.querySelector("#memory-verdict")?.textContent).not.toBe("");
  expect(text(container, '[aria-label="Memory history range"] button')).toEqual(
    ["15 min", "1 h", "6 h", "24 h"],
  );
  expect(container.querySelector("#overview-rss")?.textContent).toBe("4.0 GiB");
  expect(container.querySelector("#overview-vm")?.textContent).toBe(
    "300.0 MiB",
  );
  // Time labels show once, below the VmSize chart.
  const times = (id: string) =>
    [...container.querySelectorAll(`#${id} .axis-label`)].filter((label) =>
      label.textContent.includes(":"),
    ).length;
  expect([times("chart-rss"), times("chart-vm")]).toEqual([0, 3]);
  expect(text(container, "#rss-changes li")).toEqual([
    "15 m ▲ +173.7 MiB",
    "1 h ▲ +651.7 MiB",
    "6 h ▲ +2.6 GiB",
    "24 h ▲ +3.9 GiB",
  ]);
  expect(text(container, "#vm-changes li")).toEqual([
    "15 m ► 0 B",
    "1 h ► 0 B",
    "6 h ► 0 B",
    "24 h ► 0 B",
  ]);
  expect(text(container, "#host-mem-changes li")).toHaveLength(4);
  expect(container.querySelector("#overview-host-mem")?.textContent).toBe(
    "50.0%",
  );
  expect(text(container, ".mem-bar-head b")).toEqual([
    "8.0 GiB / 16.0 GiB free",
    "1.0 GiB / 4.0 GiB used",
  ]);
  expect(text(container, ".mem-bar small")).toEqual([
    "50.0% available",
    "25.0% used",
  ]);
  // RSS rose in every window; VmSize did not. Only RSS has the pill.
  expect(text(container, ".mem-pill")).toEqual(["Rising in every window"]);
  expect(container.querySelector("#rss-panel .mem-pill")).not.toBeNull();
  // The axes are fitted to each series, not from 0, and are not shared.
  const floor = (id: string) =>
    container.querySelector(`#${id} .axis-label`)?.textContent;
  expect(floor("chart-rss")).toBe("3.8 GiB");
  expect(floor("chart-vm")).toBe("292.5 MiB");
  // No source button inside the card: the Summary section button covers it.
  expect(container.querySelector(".help-info")).toBeNull();
});

test("a range changes the chart and the highlight, not the chips", () => {
  const { container, getByRole } = render(<Tile />);
  const chips = text(container, "#rss-changes li");
  const firstTime = () =>
    container.querySelector('#chart-vm text[text-anchor="start"]')?.textContent;
  const before = firstTime();
  expect(text(container, "#rss-changes li.on")).toEqual(["15 m ▲ +173.7 MiB"]);
  // Under 1 h there is no rate.
  expect(container.querySelector("#overview-rss-detail")).toBeNull();
  fireEvent.click(getByRole("button", { name: "6 h" }));
  expect(text(container, "#rss-changes li")).toEqual(chips);
  expect(text(container, "#rss-changes li.on")).toEqual(["6 h ▲ +2.6 GiB"]);
  expect(firstTime()).not.toBe(before);
  expect(container.querySelector("#overview-rss-detail")?.textContent).toBe(
    "▲ +441.3 MiB/h",
  );
  expect(container.querySelector("#overview-vm-detail")?.textContent).toBe(
    "► flat for 24.0 h · 0.1× RSS",
  );
  expect(
    container.querySelector("#overview-host-mem-detail")?.textContent,
  ).toBe("► 0.0 pts/h · 8.0 GiB of 16.0 GiB");
});

test("rows stored before VmSize and host memory were kept show –", () => {
  // Only the last 30 min have VmSize and host memory.
  const points = rows(DAY, (age) =>
    age > 1800
      ? {
          vm_size_bytes: null,
          host_mem_available_bytes: null,
          host_mem_total_bytes: null,
        }
      : {},
  );
  const { container } = render(<Tile dayPoints={points} initial={3600} />);
  expect(text(container, "#vm-changes li")).toEqual([
    "15 m ► 0 B",
    "1 h –",
    "6 h –",
    "24 h –",
  ]);
  expect(text(container, "#host-mem-changes li").slice(1)).toEqual([
    "1 h –",
    "6 h –",
    "24 h –",
  ]);
  // RSS was always stored.
  expect(text(container, "#rss-changes li")[3]).toBe("24 h ▲ +3.9 GiB");
  // No VmSize at all: the chart says why instead of drawing an empty axis.
  cleanup();
  const none = rows(HOUR, () => ({ vm_size_bytes: null }));
  const { container: empty } = render(<Tile dayPoints={none} />);
  expect(empty.querySelector("#chart-vm .chart-empty")?.textContent).toBe(
    "No stored VmSize history yet.",
  );
  // The time labels then go below the RSS chart.
  expect(
    [...empty.querySelectorAll("#chart-rss .axis-label")].some((label) =>
      label.textContent.includes(":"),
    ),
  ).toBe(true);
});

test("a recorded view shows the values but no history", () => {
  const { container } = render(<Tile recorded />);
  expect(container.querySelector("#overview-rss")?.textContent).toBe("4.0 GiB");
  for (const selector of [
    "#rss-changes",
    "#vm-changes",
    "#host-mem-changes",
    '[aria-label="Memory history range"]',
  ])
    expect(
      (container.querySelector(selector) as HTMLElement).hidden,
      selector,
    ).toBe(true);
  expect(
    container.querySelector("#chart-rss")?.closest("[hidden]"),
  ).not.toBeNull();
  expect(container.querySelector(".mem-pill")).toBeNull();
});

test("at narrow width the bars stack and the chips wrap", () => {
  // jsdom has no layout, so check the rules that do it.
  const css = readFileSync("src/components/summary.css", "utf8");
  expect(css).toMatch(
    /@media \(max-width: 560px\) \{\s*\.mem-bars \{\s*grid-template-columns: minmax\(0, 1fr\);/,
  );
  expect(css).toMatch(/\.mem-chips \{[^}]*flex-wrap: wrap;/);
});
