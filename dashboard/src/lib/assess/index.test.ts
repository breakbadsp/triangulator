import { expect, test } from "vitest";
import type { Thread, MemoryLayout, ProcessExit } from "../../api/types";
import { assess, assessRecorded, fleetAssessment } from "./index";
import { VERDICTS, worstLevel } from "../findings";
import { emptySeries } from "../series";
import { assessMemory, memoryRegions, asResourcePoints } from "./memory";
import { endedTarget } from "../exit";
import { viewTargetName } from "../target";
import {
  memorySummary,
  resources,
  view,
  NOW,
  rssHistory,
} from "../test-fixtures";
import { input, point } from "./test-input";
const levels = (data: Parameters<typeof assess>[0]) =>
  assess(data).map((item) => `${item.level}: ${item.title}`);

test("saturated threads are told apart by kernel share and switch rate", () => {
  const describe = (fields: Partial<Thread>) =>
    assess(
      input(
        view({
          threads: [
            {
              tid: 7,
              name: "worker-1",
              cpu_pct: 99,
              system_pct: 0,
              switches_per_s: 0,
              run_delay_pct: 0,
              state: "running",
              ...fields,
            },
          ],
        }),
      ),
    ).find((item) => item.title.includes("saturating"));
  const yielding = describe({ system_pct: 97, switches_per_s: 250 });
  expect(yielding?.title).toBe("worker-1 is saturating a core in the kernel");
  expect(yielding?.detail).toMatch(
    /99\.0% of one core, 98\.0% of it in the kernel, with 250 context switches\/s/,
  );
  expect(yielding?.detail).toMatch(/polling or yield loop/);
  expect(describe({ system_pct: 0.1, switches_per_s: 190 })?.title).toBe(
    "worker-1 is saturating a core",
  );
  expect(describe({ system_pct: 95, switches_per_s: 5 })?.title).toBe(
    "worker-1 is saturating a core",
  );
  expect(describe({ system_pct: 30, switches_per_s: 250 })?.title).toBe(
    "worker-1 is saturating a core",
  );
  expect(describe({ system_pct: 55, switches_per_s: 3000 })?.title).toBe(
    "worker-1 is saturating a core in the kernel",
  );
  expect(describe({ system_pct: undefined, switches_per_s: 250 })?.title).toBe(
    "worker-1 is saturating a core",
  );
});

test("resource assessment joins the overview assessment", () => {
  const sample = resources();
  sample.fds.open = 1000;
  expect(levels(input(view({ resources: sample })))).toContain(
    "critical: 97.7% of file descriptors in use",
  );
  expect(assess(input(view({ resources: resources() })))[0]?.detail).toBe(
    "No saturated threads, CPU waiting, kernel stalls, paging, resource pressure, exhausted limits or full socket buffers right now.",
  );
});

test("an exit describes only the absence that followed it", () => {
  const exit: ProcessExit = {
    pid: 100,
    name: "app",
    ended_at: 1000,
    reason: "segfault",
    kernel_log: "read",
    next_session: "x",
  };
  const absent = (session: string) =>
    view({
      health: { ...view().health, session, target_absent: true, pid: 0 },
      exit,
    });
  expect(levels(input(absent("x")))).toEqual([
    "critical: Target process ended · Segmentation fault",
  ]);
  expect(viewTargetName(absent("x"))).toBe("app");
  expect(levels(input(absent("y")))).toEqual([
    "critical: Target process is absent",
  ]);
  expect(viewTargetName(absent("y"))).toBe("the target");
  const running = {
    ...absent("x"),
    health: { ...absent("x").health, target_absent: false },
  };
  expect(endedTarget(running)).toBeNull();
  expect(
    levels(input(running)).some((title) => /absent|ended/.test(title)),
  ).toBe(false);
});

test("findings carry the type that Assessment history filters by", () => {
  const sample = resources();
  sample.fds.open = 1000;
  const findings = assess(
    input(
      view({
        health: { ...view().health, packet_loss_pct: 5 },
        threads: [{ tid: 7, name: "spin", cpu_pct: 99, state: "running" }],
        resources: sample,
      }),
    ),
  );
  const types = Object.fromEntries(
    findings.map((item) => [item.title, item.type]),
  );
  expect(types["Packet loss 5.0%"]).toBe("monitor");
  expect(types["spin is saturating a core"]).toBe("threads");
  expect(types["97.7% of file descriptors in use"]).toBe("resources");
});

test("memory-map warnings join the overview assessment and set the verdict", () => {
  let data = input(
    view({
      memory: memorySummary({
        vm_size_bytes: 950e6,
        address_space_limit_bytes: 1000e6,
      }),
    }),
  );
  expect(levels(data)).toEqual([
    "critical: Address space is close to RLIMIT_AS",
  ]);
  expect(VERDICTS[worstLevel(assess(data))]).toBe("Needs attention now");
  data = input(view({ memory: memorySummary({ vma_count: 50000 }) }));
  expect(VERDICTS[worstLevel(assess(data))]).toBe("Worth a look");
  expect(levels(data)).toEqual([
    "warning: Mapping count is close to the limit",
  ]);
});

test("growing resident memory joins the overview assessment", () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({
    ts: NOW - 70 + index * 10,
    pid: 1,
    elapsed_s: 10,
    rss_bytes: 100e6 + index * 50e6,
  }));
  expect(
    levels(
      input(view({ memory: memorySummary(), resources: resources() }), {
        resourcePoints: asResourcePoints(rows),
      }),
    ),
  ).toEqual(["warning: Resident memory grows without a plateau"]);
});
const stackLayout = (): MemoryLayout => ({
  available: true,
  id: "s:1",
  pid: 1,
  regions: [
    {
      start: "0x7ffc00000000",
      end: "0x7ffc00400000",
      size: 4 << 20,
      vmas: 1,
      kind: "stack",
      permissions: "rw-p",
      name: "",
    },
  ],
});

test("info and good memory findings stay out of the overview assessment", () => {
  const layout = stackLayout(),
    memory = memorySummary({}, { layout_id: "s:1" }),
    live = view({ memory });
  expect(
    assessMemory(memory, memoryRegions(layout)).some(
      (item) => item.level === "info",
    ),
  ).toBe(true);
  expect(levels(input(live, { memoryLayout: layout }))).toEqual([
    "good: No problems detected",
  ]);
  expect(assess(input(live, { memoryLayout: layout }))[0]?.detail).toBe(
    "No saturated threads, CPU waiting, kernel stalls or paging right now. No memory-map warnings detected in the available samples.",
  );
  const grown = {
    ...layout,
    regions: layout.regions?.map((region) => ({
      ...region,
      end: "0x7ffc00700000",
      size: 0x700000,
    })),
  };
  expect(levels(input(live, { memoryLayout: grown }))).toEqual([
    "warning: Main stack is at 87.5% of its limit",
  ]);
});

test("without usable memory samples the overview ignores the memory map", () => {
  const bloated = memorySummary({
    vm_size_bytes: 950e6,
    address_space_limit_bytes: 1000e6,
  });
  for (const memory of [
    undefined,
    { available: false },
    { ...bloated, stale: true },
  ])
    expect(assess(input(view({ memory })))[0]?.detail).toBe(
      "No saturated threads, CPU waiting, kernel stalls or paging right now.",
    );
});

test("an older stack layout cannot supply a current overview finding", () => {
  const memory = memorySummary({}, { layout_id: "s:2" }),
    layout = {
      ...stackLayout(),
      regions: stackLayout().regions?.map((region) => ({
        ...region,
        end: "0x7ffc00700000",
        size: 0x700000,
      })),
    };
  expect(levels(input(view({ memory }), { memoryLayout: layout }))).toEqual([
    "good: No problems detected",
  ]);
  expect(
    levels(input(view({ memory }), { memoryLayout: { ...layout, id: "s:2" } })),
  ).toEqual(["warning: Main stack is at 87.5% of its limit"]);
});
function faultInput(
  host: number,
  cgroup: number,
  pressureScope: "host" | "cgroup" = "cgroup",
) {
  const sample = resources();
  sample.pressure.host.memory = { some: { pct: host }, full: { pct: 0 } };
  sample.pressure.cgroup.memory = { some: { pct: cgroup }, full: { pct: 0 } };
  return input(
    view({
      threads: [
        { tid: 7, name: "worker", state: "running", major_faults_per_s: 80 },
      ],
      memory: memorySummary(),
      resources: sample,
    }),
    {
      series: { ...emptySeries, points: [point(1, 1, { mf: 80 })] },
      pressureScope,
    },
  );
}

test("a memory fault finding replaces the thread one only when it is more severe", () => {
  const data = faultInput(20, 20);
  expect(levels(data).filter((title) => /fault/.test(title))).toEqual([
    "serious: Major page faults and memory pressure rise together",
  ]);
  expect(
    assess(data).find((item) => item.topic === "faults")?.action?.tid,
  ).toBe(7);
  expect(levels(faultInput(0, 0))).toEqual([
    "warning: 80.0 major page faults/s",
  ]);
});

test("D1: major faults use the selected pressure scope", () => {
  expect(levels(faultInput(20, 0, "host"))).toEqual([
    "serious: Major page faults and memory pressure rise together",
  ]);
  expect(levels(faultInput(20, 0, "cgroup"))).toEqual([
    "warning: 80.0 major page faults/s",
  ]);
});

test("recorded assessment uses only earlier resources and identifies thread actions", () => {
  const live = view({
    threads: [
      {
        tid: 7,
        name: "spin",
        generation: 3,
        last_sample: NOW,
        cpu_pct: 99,
        state: "running",
      },
    ],
  });
  const findings = assessRecorded(live, NOW, []);
  expect(findings[0]?.action).toEqual({ tid: 7, session: "s", generation: 3 });
  expect(fleetAssessment(live, NOW)?.level).toBe("serious");
  expect(fleetAssessment(null, NOW)).toBeNull();
  const healthy = fleetAssessment(view(), NOW);
  expect(healthy).toEqual({ level: "good", findings: [] });
  const history = rssHistory([[7, 120, 100, 8]]);
  const recorded = { ...history.view, memory: memorySummary({}, { pid: 7 }) };
  expect(
    assessRecorded(recorded, NOW, history.points).some(
      (item) => item.title === "Resident memory grows without a plateau",
    ),
  ).toBe(true);
  expect(
    assessRecorded(recorded, NOW - 300, history.points).some(
      (item) => item.title === "Resident memory grows without a plateau",
    ),
  ).toBe(false);
});

test("memory counter fallback is live only and ignores counter resets", () => {
  const live = view({ memory: memorySummary(), resources: resources() });
  const memoryHistory = [
    { t: 1, mf: 0 },
    { t: 2, mf: 200 },
  ];
  expect(levels(input(live, { memoryHistory }))).toContain(
    "warning: Frequent major page faults",
  );
  expect(
    levels(input(live, { memoryHistory, mode: { kind: "recorded" } })),
  ).toEqual(["good: No problems detected"]);
  expect(
    levels(
      input(live, {
        memoryHistory: [
          { t: 1, mf: 50 },
          { t: 2, mf: 10 },
        ],
      }),
    ),
  ).toEqual(["good: No problems detected"]);
});
