import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type {
  LiveResponse,
  PressureScope,
  Resources as ResourceSample,
  ResourceSocket,
} from "../api/types";
import { helpTopics } from "../help/topics";
import { asResourcePoints } from "../lib/assess/memory";
import { Resources, type ResourceRange } from "./Resources";

afterEach(() => {
  localStorage.clear();
});

const socket = (fd: number, extra: Partial<ResourceSocket> = {}) => ({
  fd,
  inode: 1000 + fd,
  kind: "tcp4",
  state: "ESTAB",
  listener: false,
  local: `10.0.0.1:${String(fd)}`,
  remote: "10.0.0.9:5000",
  rx_queue: 0,
  tx_queue: 0,
  ...extra,
});
const sample = (extra: Partial<ResourceSample> = {}): ResourceSample => ({
  available: true,
  session: "s1",
  pid: 7,
  sequence: 4,
  interval_s: 5,
  updated: 100,
  pressure: {
    cgroup: { cpu: { some: { pct: 1 } }, memory: { some: { pct: 2 } } },
    host: { cpu: { some: { pct: 30 } }, memory: { some: { pct: 40 } } },
  },
  sockets: {
    tcp: { sockets: 2, rx_queue: 10, tx_queue: 0 },
    udp: { sockets: 0, rx_queue: 0, tx_queue: 0 },
    unix: { sockets: 0, rx_queue: 0, tx_queue: 0 },
    top: [socket(5, { rx_queue: 300 }), socket(6)],
    matched: 2,
    complete: true,
  },
  network: {
    listen_drops: { delta: 0, per_s: 0, total: 9 },
    tcp_timeouts: { delta: 0, per_s: 0, total: 4 },
  },
  ...extra,
});
const view = (resources: ResourceSample, session = "s1"): LiveResponse => ({
  health: {
    session,
    pid: 7,
    last_seen: 100,
    sampler_silent: false,
    target_absent: false,
  },
  threads: [],
  resources,
});
function show(
  live: LiveResponse,
  {
    points = [],
    range = 900,
    scope = "cgroup",
  }: {
    points?: ReturnType<typeof asResourcePoints>;
    range?: ResourceRange;
    scope?: PressureScope;
  } = {},
) {
  return (
    <Resources
      view={live}
      now={220}
      points={points}
      range={range}
      onRange={() => undefined}
      scope={scope}
      onScope={() => undefined}
    />
  );
}
const counters = () =>
  [...document.querySelectorAll<HTMLElement>("#netstack tr[data-counter]")].map(
    (row) => row.dataset.counter,
  );
const tile = (label: string) =>
  [...document.querySelectorAll("#resource-tiles .tile")].find(
    (item) => item.querySelector(".label")?.textContent === label,
  );

// Old test 519, panel half: missing sockets are explained, never shown as 0.
test("hidden or unreachable sockets and stale samples are explained", () => {
  const { rerender } = render(
    show(view(sample({ flags: { descriptors_hidden: true } }))),
  );
  expect(document.getElementById("resource-coverage")?.textContent).toContain(
    "The sampler cannot read the target’s descriptor links, so its sockets cannot be identified.",
  );
  rerender(show(view(sample({ flags: { other_network_namespace: true } }))));
  expect(document.getElementById("resource-coverage")?.textContent).toContain(
    "The target is in another network namespace: its sockets are not visible to the sampler.",
  );
  rerender(show(view(sample({ stale: true }))));
  expect(document.getElementById("resources-sub")?.textContent).toBe(
    "Resource stalls, remaining capacity, and socket queues. Stale: no sample since 2 min ago.",
  );
  rerender(
    show(view({ available: false, reason: "Resource sampling is off." })),
  );
  expect(document.getElementById("resources-empty")?.textContent).toBe(
    "Resource sampling is off.",
  );
  expect(document.getElementById("resources-content")).toBeNull();
});

test("a sample of an earlier process never shows for the current session", () => {
  render(show(view(sample(), "s2")));
  expect(document.getElementById("resources-content")).toBeNull();
  expect(document.getElementById("resources-empty")?.textContent).toBe(
    "Waiting for a resource sample of the current process.",
  );
});

// Old test 534, panel half: the tile keeps unknown and measured zero apart.
test("the queue tile shows unknown, partial and zero queues", () => {
  const queues = (rx: number | null, tx: number | null) => ({
    sockets: 1,
    rx_queue: rx,
    tx_queue: tx,
  });
  const { rerender } = render(
    show(
      view(
        sample({
          sockets: {
            tcp: queues(10, null),
            udp: queues(0, 0),
            unix: queues(0, 0),
          },
        }),
      ),
    ),
  );
  const values = () =>
    [...(tile("Queued in sockets")?.children ?? [])]
      .slice(1, 3)
      .map((node) => node.textContent);
  expect(values()).toEqual(["—", "unread 10 B · unsent —"]);
  rerender(
    show(
      view(
        sample({
          sockets: {
            tcp: queues(0, 0),
            udp: queues(0, 0),
            unix: queues(0, 0),
          },
        }),
      ),
    ),
  );
  expect(values()).toEqual(["0 B", "unread 0 B · unsent 0 B"]);
});

test("the chosen scope falls back to the host without cgroup pressure", () => {
  const { rerender } = render(show(view(sample()), { scope: "cgroup" }));
  const select = screen.getByRole<HTMLSelectElement>("combobox", {
    name: "Pressure scope",
  });
  expect(select.value).toBe("cgroup");
  expect(tile("CPU pressure")?.textContent).toContain("1.0%full — · cgroup");
  rerender(show(view(sample()), { scope: "host" }));
  expect(select.value).toBe("host");
  expect(tile("CPU pressure")?.textContent).toContain("30.0%full — · host");
  const hostOnly = sample({
    pressure: { host: { cpu: { some: { pct: 30 } } } },
  });
  rerender(show(view(hostOnly), { scope: "cgroup" }));
  expect(select.value).toBe("host");
  expect(
    within(select).getByRole<HTMLOptionElement>("option", {
      name: "Target's cgroup",
    }).disabled,
  ).toBe(true);
});

test("In range counts the stored samples of the selected range", () => {
  const points = (deltas: number[]) =>
    asResourcePoints(
      deltas.map((delta, index) => ({
        ts: 100 + index,
        pid: 7,
        elapsed_s: 1,
        tcp_timeouts_delta: delta,
        rss_bytes: null,
      })),
    );
  const inRange = () =>
    document.querySelector('#netstack tr[data-counter="tcp_timeouts"]')
      ?.children[2]?.textContent;
  const { rerender } = render(show(view(sample()), { points: points([1, 2]) }));
  expect(inRange()).toBe("3");
  rerender(show(view(sample()), { points: points([1, 2, 4]), range: 3600 }));
  expect(inRange()).toBe("7");
  // No stored history is not zero events.
  rerender(show(view(sample()), { points: [], range: 3600 }));
  expect(inRange()).toBe("—");
});

test("resource charts and range counts keep only the displayed PID", () => {
  const rows = [100, 110].map((ts) => ({
    ts,
    pid: 7,
    elapsed_s: 1,
    tcp_timeouts_delta: 2,
    rss_bytes: ts * 1024,
    cgroup_cpu_some_pct: ts,
  }));
  const current = view(sample());
  const paths = () =>
    [
      ...document.querySelectorAll(
        "#resources svg polyline, #resources svg polygon",
      ),
    ].map((path) => path.getAttribute("points"));
  const { rerender } = render(
    show(current, { points: asResourcePoints(rows) }),
  );
  const before = paths();
  expect(before.length).toBeGreaterThan(0);
  rerender(
    show(current, {
      points: asResourcePoints([
        ...rows.slice(0, 1),
        {
          ts: 105,
          pid: 8,
          elapsed_s: 1,
          tcp_timeouts_delta: 9999,
          rss_bytes: 1e15,
        },
        ...rows.slice(1),
      ]),
    }),
  );
  expect(
    document.querySelector('#netstack tr[data-counter="tcp_timeouts"]')
      ?.children[2]?.textContent,
  ).toBe("4");
  expect(paths()).toEqual(before);
});

test("every visible resource label has a registered help topic", () => {
  render(
    show(
      view(
        sample({
          fds: { open: 10, soft_limit: 100, hard_limit: 200 },
          cgroup_limits: {
            memory: { current: 50, max: 100 },
            cpu: { quota_us: 50000, period_us: 100000, throttled_pct: 2 },
            pids: { current: 5, max: 50 },
          },
          sockstat: { tcp_mem: 10, tcp_inuse: 3, tcp_orphan: 0, tcp_tw: 1 },
          limits: { tcp_mem: [100, 200, 300], rmem_max: 1024, somaxconn: 128 },
        }),
      ),
    ),
  );
  const section = document.getElementById("resources");
  if (!section) throw new Error("Missing resources section");
  for (const element of section.querySelectorAll<HTMLElement>("[data-help]"))
    expect(Object.hasOwn(helpTopics, element.dataset.help ?? "")).toBe(true);
  const unexplained = [
    ...section.querySelectorAll(
      "h2, h3, th, .tile .label, .legend > *, .meter, dt, button, select, label, #resource-coverage",
    ),
  ].filter(
    (node) =>
      !node.closest("[data-help]") && !node.querySelector("[data-help]"),
  );
  expect(unexplained.map((node) => node.textContent)).toEqual([]);
  expect(
    [
      ...section.querySelectorAll<HTMLElement>("#netstack tr[data-counter]"),
    ].map((row) => row.dataset.counter),
  ).toEqual(["listen_drops", "tcp_timeouts"]);
  for (const key of ["listen_drops", "tcp_timeouts"])
    expect(Object.hasOwn(helpTopics, `net-${key}`)).toBe(true);
});

test("an inspected table holds its rows and readout; release shows the newest", () => {
  const busy = sample({
    network: {
      listen_drops: { delta: 0, per_s: 0, total: 9 },
      tcp_timeouts: { delta: 3, per_s: 0.6, total: 7 },
    },
  });
  const { rerender } = render(show(view(sample())));
  expect(counters()).toEqual(["listen_drops", "tcp_timeouts"]);
  const table = document.getElementById("netstack")?.closest(".table-wrap")
    ?.parentElement as HTMLElement;
  fireEvent.mouseEnter(table);
  const row = document.querySelector(
    '#netstack tr[data-counter="tcp_timeouts"]',
  );
  rerender(show(view(busy)));
  expect(counters(), "held while the pointer is over it").toEqual([
    "listen_drops",
    "tcp_timeouts",
  ]);
  fireEvent.mouseLeave(table);
  // The active counter moves first, and its row element stays the same.
  expect(counters()).toEqual(["tcp_timeouts", "listen_drops"]);
  expect(
    document.querySelector('#netstack tr[data-counter="tcp_timeouts"]'),
  ).toBe(row);
});

test("busy-only applies to the held sockets, keeps focus and scrolls to the top", () => {
  const { rerender } = render(show(view(sample())));
  const rows = () => document.querySelectorAll("#resource-sockets tr").length;
  expect(document.getElementById("resource-socket-count")?.textContent).toBe(
    "(1 of 2 reported)",
  );
  const card = document.getElementById("resource-sockets")?.closest(".card");
  if (!(card instanceof HTMLElement)) throw new Error("Missing sockets card");
  fireEvent.mouseEnter(card);
  rerender(
    show(
      view(
        sample({
          sockets: { top: [socket(9, { rx_queue: 1 })], complete: true },
        }),
      ),
    ),
  );
  const checkbox = screen.getByRole<HTMLInputElement>("checkbox", {
    name: "Only sockets with data, drops or retransmits",
  });
  checkbox.focus();
  const wrap = card.querySelector(".table-wrap") as HTMLElement;
  wrap.scrollTop = 120;
  fireEvent.click(checkbox);
  // Still the held sample: both of its sockets, not the newer single one.
  expect(document.getElementById("resource-socket-count")?.textContent).toBe(
    "(2 of 2 reported)",
  );
  expect(rows()).toBe(2);
  expect(document.activeElement).toBe(checkbox);
  expect(wrap.scrollTop).toBe(0);
  fireEvent.mouseLeave(card);
  fireEvent.blur(checkbox);
  expect(document.getElementById("resource-socket-count")?.textContent).toBe(
    "(1 of 1 reported)",
  );
});

test("a new session discards a held socket table at once", () => {
  const { rerender } = render(show(view(sample())));
  const card = document.getElementById("resource-sockets")?.closest(".card");
  if (!(card instanceof HTMLElement)) throw new Error("Missing sockets card");
  fireEvent.mouseEnter(card);
  const next = sample({
    session: "s2",
    sockets: { top: [socket(9, { rx_queue: 1 })], complete: true },
  });
  rerender(show(view(next, "s2")));
  expect(
    [...document.querySelectorAll<HTMLElement>("#resource-sockets tr")].map(
      (row) => row.dataset.socket,
    ),
  ).toEqual(["s2|7|1009|9|tcp4"]);
});
