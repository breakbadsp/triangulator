// Ports pinned 777cf3a:tests/dashboard_test.js 1194, 1258, 1279, 1314, 1336
// and 1359, with the mounted page and a collector fetch double.
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../App";
import type { LiveResponse, ResourceRow } from "../api/types";
import { date } from "../lib/format";

type Bounds = { first: number | null; last: number | null };
interface Collector {
  bounds: Bounds;
  live: LiveResponse;
  snapshotAt: (at: number) => LiveResponse | null;
  resourcesIn: (start: number, end: number) => ResourceRow[];
  /** Replies for scan reads (`direction=at`), when set. */
  replay?: (at: number) => Promise<Response>;
  /** Resource reads wait for this, when set. */
  gate?: Promise<void>;
}
let collector: Collector;
let requests: URL[];

function frame(at: number, session = "old", cpu = 5): LiveResponse {
  return {
    recorded_at: at,
    health: {
      session,
      pid: 9,
      last_seen: at,
      target_absent: false,
      sampler_silent: false,
      sample_interval_ms: 1000,
    },
    threads: [
      {
        tid: 9,
        name: `${session}-worker`,
        generation: 1,
        state: "running",
        last_sample: at,
        cpu_pct: cpu,
        run_delay_pct: 0,
      },
    ],
  };
}
// A thread is saturated from 1300 to 1500; recordings stop between 1600 and 1700.
const spinView = (at: number) => {
  const recorded = at >= 1600 && at < 1700 ? 1599 : Math.floor(at);
  return frame(recorded, "old", recorded >= 1300 && recorded <= 1500 ? 99 : 5);
};
// RSS grows 8 MB/s from 1300 to 1500 and is flat before and after.
const leakRss = (at: number) =>
  100e6 + 8e6 * Math.min(200, Math.max(0, at - 1300));
const leakView = (at: number): LiveResponse => {
  const view = frame(Math.floor(at), "old", 1);
  const recorded = view.recorded_at ?? 0;
  return {
    ...view,
    memory: {
      available: true,
      stale: false,
      pid: 9,
      updated: recorded,
      values: { vma_count: 100, max_map_count: 65530 },
    },
    resources: {
      available: true,
      stale: false,
      pid: 9,
      session: "old",
      updated: recorded,
      memory: { rss: leakRss(recorded) },
    },
  };
};
const leakRows = (start: number, end: number) => {
  const rows: ResourceRow[] = [];
  for (let at = Math.max(1000, Math.ceil(start)); at <= end; at++)
    rows.push({ ts: at, pid: 9, rss_bytes: leakRss(at), elapsed_s: 1 });
  return rows;
};

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 20; ++i) await Promise.resolve();
  });
};
const settle = async () => {
  for (let i = 0; i < 60; ++i) await flush();
};
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
};
function byId(id: string) {
  const value = document.getElementById(id);
  if (!value) throw Error(`Missing ${id}`);
  return value;
}
const range = () => byId("timeline-range") as HTMLInputElement;
const rows = () =>
  [...byId("history-list").children].map(
    (row) => row.querySelector(".t")?.textContent ?? row.textContent,
  );
const status = () => byId("history-status").textContent;
const scanTimes = () =>
  requests
    .filter(
      (url) =>
        url.pathname === "/api/replay" &&
        url.searchParams.get("direction") === "at",
    )
    .map((url) => Number(url.searchParams.get("at")));
const storage = () =>
  Object.fromEntries(
    Object.keys(sessionStorage)
      .sort()
      .map((key) => [key, sessionStorage.getItem(key)]),
  );
const panels = () =>
  Object.fromEntries(
    [
      "target-name",
      "target-meta",
      "overview",
      "threads-section",
      "resources",
      "memory-map",
      "monitor",
      "collector-settings",
      "replay-note",
    ].map((id) => [id, byId(id).textContent]),
  );
async function release(value: number) {
  fireEvent.input(range(), { target: { value: String(value) } });
  const cursor = byId("timeline-cursor").textContent;
  fireEvent.change(range(), { target: { value: String(value) } });
  await settle();
  return cursor;
}
const viewing = () =>
  document.getElementById("history-pill") ? Number(range().value) : null;

function open(setup: Partial<Collector> = {}) {
  collector = {
    bounds: { first: 1000, last: 1900 },
    live: frame(1900, "live"),
    snapshotAt: spinView,
    resourcesIn: () => [],
    ...setup,
  };
  return render(<App />);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1900000);
  history.replaceState(null, "", "/?target=host%2Fapp");
  sessionStorage.clear();
  localStorage.clear();
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        location.href,
      );
      requests.push(url);
      const bounds = { ...collector.bounds, interval_s: 1 };
      if (url.pathname === "/api/live") return Response.json(collector.live);
      if (url.pathname === "/api/targets")
        return Response.json({
          targets: [
            {
              key: "host/app",
              host: "host",
              id: "app",
              pid: 9,
              status: "live",
            },
          ],
        });
      if (url.pathname === "/api/replay") {
        const at = url.searchParams.get("at");
        if (at === null) return Response.json({ ...bounds, snapshot: null });
        if (collector.replay && url.searchParams.get("direction") === "at")
          return await collector.replay(Number(at));
        return Response.json({
          ...bounds,
          snapshot: collector.snapshotAt(Number(at)),
        });
      }
      if (url.pathname === "/api/resources") {
        await collector.gate;
        return Response.json({
          rows: collector.resourcesIn(
            Number(url.searchParams.get("start")),
            Number(url.searchParams.get("end")),
          ),
          bucket_s: 1,
          truncated: false,
          read_error: false,
        });
      }
      if (url.pathname === "/api/history")
        return Response.json({ rows: [], limit: 2000, truncated: false });
      return Response.json({ available: false, reason: "No observer" });
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
  sessionStorage.clear();
  localStorage.clear();
});

describe("past assessments", () => {
  test.each(["live", "recorded", "final"] as const)(
    "a complete background scan preserves %s panels, analysis and storage",
    async (mode) => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((done) => {
        release = done;
      });
      open({
        replay: async (at) => {
          await gate;
          return Response.json({
            first: 1000,
            last: 1900,
            interval_s: 1,
            snapshot: spinView(at),
          });
        },
      });
      await settle();
      expect(scanTimes()).toHaveLength(4);
      const livePanels = panels();
      collector.replay = undefined;
      if (mode === "recorded") {
        fireEvent.click(byId("replay-previous"));
        await settle();
        expect(viewing()).toBe(1900);
      } else if (mode === "final") {
        collector.live = {
          health: {
            session: "gone",
            pid: 0,
            last_seen: 1900,
            target_absent: true,
            sampler_silent: false,
          },
          threads: [],
        };
        await advance(1000);
        expect(byId("target-meta").textContent).toContain("Stopped reporting");
      }
      const before = { panels: panels(), storage: storage() };
      const sent = requests.length;
      const writes = vi.spyOn(Storage.prototype, "setItem");
      const removals = vi.spyOn(Storage.prototype, "removeItem");
      const clears = vi.spyOn(Storage.prototype, "clear");
      release();
      await settle();
      expect({ panels: panels(), storage: storage() }).toEqual(before);
      expect(writes).not.toHaveBeenCalled();
      expect(removals).not.toHaveBeenCalled();
      expect(clears).not.toHaveBeenCalled();
      expect(
        requests
          .slice(sent)
          .every(
            (url) =>
              url.pathname === "/api/replay" &&
              url.searchParams.get("direction") === "at",
          ),
      ).toBe(true);
      expect(status()).toMatch(/^Checked 108 recordings/);
      expect(scanTimes()).toHaveLength(mode === "recorded" ? 121 : 120);
      // The retained live charts and assessment survive a scan during replay.
      if (mode === "recorded") {
        fireEvent.click(byId("replay-live"));
        await settle();
        expect(panels()).toEqual(livePanels);
      }
    },
  );
  test("check the latest recordings when the page opens and leave the live view alone", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    open({
      replay: async (at) => {
        await held;
        return Response.json({
          first: 1000,
          last: 1900,
          interval_s: 1,
          snapshot: spinView(at),
        });
      },
    });
    await settle();
    const before = {
      storage: storage(),
      name: byId("target-name").textContent,
      meta: byId("target-meta").textContent,
      note: byId("replay-note").textContent,
    };
    expect(status()).toBe("Checking the latest recordings…");
    release();
    await settle();
    expect({
      storage: storage(),
      name: byId("target-name").textContent,
      meta: byId("target-meta").textContent,
      note: byId("replay-note").textContent,
    }).toEqual(before);
    expect(before.name).toBe("live-worker");
    expect(viewing()).toBeNull();
    const times = scanTimes().sort((a, b) => a - b);
    expect(times).toHaveLength(120);
    expect([times[0], times.at(-1)]).toEqual([1000, 1900]);
    // The scan makes no recording selection of its own.
    expect(
      requests.filter(
        (url) =>
          url.pathname === "/api/replay" &&
          url.searchParams.has("direction") &&
          url.searchParams.get("direction") !== "at",
      ),
    ).toEqual([]);
    expect(rows()).toEqual(["old-worker is saturating a core"]);
    // The first checked recording of the spin, on the slot grid.
    const episodeFirst = Math.floor(
      times.find((at) => Math.floor(at) >= 1300) ?? NaN,
    );
    expect(episodeFirst >= 1300 && episodeFirst < 1308).toBe(true);
    expect(byId("history-list").querySelector(".when")?.textContent).toMatch(
      new RegExp(
        `^${date(episodeFirst).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} – `,
      ),
    );
    expect(status()).toMatch(
      /^Checked 108 recordings back to .* \(the oldest recording\)\. 12 checked times had no recording\. Showing 1 of 1 finding\.$/,
    );
    expect(document.getElementById("history-more")).toBeNull();
    // The timeline spans the checked period and marks the finding.
    expect([range().min, range().max, range().value]).toEqual([
      "1000",
      "1900",
      "1900",
    ]);
    const mark = byId("timeline-marks").children[0] as HTMLElement;
    expect(parseFloat(mark.style.left)).toBeCloseTo(
      (100 * (episodeFirst - 1000)) / 900,
    );
    // Filters hide rows and marks without checking again.
    const serious = byId("history-levels").querySelector(
      'input[value="serious"]',
    ) as HTMLInputElement;
    fireEvent.click(serious);
    expect(rows()).toEqual(["No findings match these filters."]);
    expect(byId("timeline-marks").children).toHaveLength(0);
    fireEvent.click(serious);
    fireEvent.change(byId("history-type"), { target: { value: "memory" } });
    expect(rows()).toEqual(["No findings match these filters."]);
    fireEvent.change(byId("history-type"), { target: { value: "threads" } });
    expect(rows()).toEqual(["old-worker is saturating a core"]);
    await settle();
    expect(scanTimes()).toHaveLength(120);
    // A row moves the whole dashboard to the time it was worst and stays selected.
    fireEvent.click(byId("history-list").children[0] as HTMLElement);
    await settle();
    const at = viewing();
    expect(at !== null && at >= 1300 && at <= 1500).toBe(true);
    expect(byId("findings").textContent).toContain(
      "old-worker is saturating a core",
    );
    const row = byId("history-list").children[0] as HTMLElement;
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.querySelector(".d")?.textContent).toBeTruthy();
    const pill = byId("history-pill");
    expect(pill.textContent).toMatch(/ · Back to live$/);
    expect(pill.getAttribute("aria-label")).toMatch(
      /^Viewing the recording at .*\. Back to live$/,
    );
    fireEvent.click(pill);
    await settle();
    expect(viewing()).toBeNull();
    expect(row.getAttribute("aria-current")).toBe("false");
    // Enter on a row selects it too.
    fireEvent.keyDown(byId("history-list").children[0] as HTMLElement, {
      key: "Enter",
    });
    await settle();
    expect(viewing()).toBe(at);
  });

  test("find RSS growth from the stored resource samples", async () => {
    // The growth ends at 1500. Judged against the newest samples (to 1900),
    // every recording would see a flat end and no growth.
    open({ snapshotAt: leakView, resourcesIn: leakRows });
    await settle();
    expect(rows()).toEqual(["Resident memory grows without a plateau"]);
    fireEvent.change(byId("history-type"), { target: { value: "memory" } });
    expect(rows()).toEqual(["Resident memory grows without a plateau"]);
    const periodReads = requests.filter(
      (url) =>
        url.pathname === "/api/resources" &&
        url.searchParams.get("end") === "1900" &&
        // The live reader asks for its own range; the period read starts
        // one step and the RSS trend window before the first slot.
        Number(url.searchParams.get("start")) === 1000 - 900 / 119 - 180,
    );
    expect(periodReads).toHaveLength(1);
    // The row opens the recording, and the Assessment there shows the same finding.
    fireEvent.click(byId("history-list").children[0] as HTMLElement);
    await settle();
    const at = viewing();
    expect(at !== null && at > 1300 && at < 1700).toBe(true);
    expect(byId("findings").textContent).toContain(
      "Resident memory grows without a plateau",
    );
  });

  test.each([false, true])(
    "stored RSS preserves PID boundaries, including unavailable rows: %s",
    async (boundary) => {
      const resourceRows: ResourceRow[] = Array.from(
        { length: 24 },
        (_, i) => ({
          ts: 1780 + i * 5,
          pid: 7,
          elapsed_s: 5,
          rss_bytes: (100 + 8 * i * 5) * 2 ** 20,
        }),
      );
      if (boundary)
        resourceRows.splice(-1, 0, {
          ts: 1894,
          pid: 8,
          elapsed_s: 5,
          rss_bytes: null,
        });
      const view = leakView(1900);
      view.health.pid = 7;
      view.memory = { ...view.memory, available: true, pid: 7 };
      view.resources = { ...view.resources, available: true, pid: 7 };
      open({
        bounds: { first: 1900, last: 1900 },
        snapshotAt: () => view,
        resourcesIn: (start, end) =>
          resourceRows.filter((row) => row.ts >= start && row.ts <= end),
      });
      await settle();
      expect(status()).toMatch(/^Checked 1 recording/);
      expect(rows()).toEqual([
        boundary
          ? "The Assessment found nothing in the checked recordings."
          : "Resident memory grows without a plateau",
      ]);
      expect(byId("timeline-marks").children).toHaveLength(boundary ? 0 : 1);
      // A direct recording selection must agree with its scan, even when
      // there is no finding row to select.
      fireEvent.click(byId("replay-previous"));
      await settle();
      expect(
        byId("findings").textContent.includes(
          "Resident memory grows without a plateau",
        ),
      ).toBe(!boundary);
    },
  );

  test("without stored resource samples there is no trend", async () => {
    open({ snapshotAt: leakView });
    await settle();
    expect(rows()).toEqual([
      "The Assessment found nothing in the checked recordings.",
    ]);
  });

  test("scrolling to the end of the list or the start of the timeline checks an earlier period", async () => {
    const page = open({
      bounds: { first: 0, last: 1900 },
      snapshotAt: (at) => frame(Math.floor(at)),
    });
    await settle();
    expect(scanTimes()).toHaveLength(120);
    expect(status()).toContain(`back to ${date(1000)}.`);
    expect(byId("history-more").textContent).toBe("Load earlier");
    // The list's end is in view: the next period is twice as long, back to
    // the oldest recording. One load at a time.
    fireEvent.scroll(byId("history-list"));
    expect(byId("history-more").textContent).toBe("Loading…");
    fireEvent.scroll(byId("history-list"));
    await settle();
    const earlier = scanTimes().slice(120);
    expect(earlier).toHaveLength(119);
    expect([Math.min(...earlier), Math.max(...earlier) < 1000]).toEqual([
      0,
      true,
    ]);
    expect(document.getElementById("history-more")).toBeNull();
    expect(status()).toContain("(the oldest recording)");
    expect(range().min).toBe("0");
    page.unmount();

    // Releasing the handle at the left end opens that moment and loads
    // earlier; at the right end it returns to live.
    requests = [];
    open({
      bounds: { first: 0, last: 1900 },
      snapshotAt: (at) => frame(Math.floor(at)),
    });
    await settle();
    expect(range().min).toBe("1000");
    await release(1000);
    expect(viewing()).toBe(1000);
    expect(scanTimes()).toHaveLength(120 + 1 + 119);
    expect(range().min).toBe("0");
    expect(await release(Number(range().max))).toBe("Release for live");
    expect(viewing()).toBeNull();
  });

  test("a long timeline opens recent past times and one step before Live", async () => {
    vi.setSystemTime(86400000);
    open({
      bounds: { first: 0, last: 86400 },
      live: frame(86400, "live"),
      snapshotAt: (at) => frame(Math.floor(at)),
    });
    await settle();
    while (document.getElementById("history-more")) {
      fireEvent.click(byId("history-more"));
      await settle();
    }
    expect(Number(range().max) - Number(range().min)).toBe(86400);
    for (const secondsBeforeLive of [300, 1]) {
      expect(await release(86400 - secondsBeforeLive)).toMatch(
        /^Release to view /,
      );
      expect(viewing()).toBe(86400 - secondsBeforeLive);
      fireEvent.click(byId("replay-live"));
      await settle();
    }
    expect(await release(86400)).toBe("Release for live");
    expect(viewing()).toBeNull();
  });

  test("a fractional timeline returns to Live only from its last selectable step", async () => {
    // A native range input selects these endpoints with min=1000.2 and step=1.
    for (const [liveEnd, lastSelectable] of [
      [1900.9, 1900.2],
      [1901.2, 1901.2],
    ] as const) {
      const page = open({
        bounds: { first: 1000.2, last: 1900.2 },
        live: frame(liveEnd, "live"),
        snapshotAt: (at) => frame(at),
      });
      await settle();
      await release(1800.2);
      expect([Number(range().min), Number(range().max)]).toEqual([
        1000.2,
        liveEnd,
      ]);
      expect(await release(lastSelectable - 1)).toMatch(/^Release to view /);
      expect(viewing()).toBeCloseTo(lastSelectable - 1);
      expect(await release(lastSelectable)).toBe("Release for live");
      expect(viewing()).toBeNull();
      page.unmount();
    }
  });

  test("while live the newest recordings join the list, and errors can be retried", async () => {
    open({ snapshotAt: (at) => frame(Math.floor(at)) });
    await settle();
    const step = 900 / 119;
    collector.bounds = { first: 1000, last: 1960 };
    await advance(15000);
    const added = scanTimes().slice(120);
    expect(added).toHaveLength(Math.floor(60 / step));
    expect(added[0]).toBeCloseTo(1900 + step);
  });

  test("newer reads keep filters, row focus and scroll; recorded mode pauses them and a failed newer read retries silently", async () => {
    open();
    await settle();
    const list = byId("history-list"),
      row = list.children[0] as HTMLElement;
    fireEvent.change(byId("history-type"), { target: { value: "threads" } });
    list.scrollTop = 40;
    row.focus();
    const before = scanTimes().length;
    collector.bounds = { first: 1000, last: 1960 };
    collector.replay = () =>
      Promise.resolve(
        Response.json({ error: "newer failed" }, { status: 500 }),
      );
    await advance(15000);
    expect(status()).not.toContain("failed");
    expect(scanTimes().length).toBeGreaterThan(before);
    collector.replay = undefined;
    await advance(15000);
    expect(list.children[0]).toBe(row);
    expect(document.activeElement).toBe(row);
    expect(list.scrollTop).toBe(40);
    expect((byId("history-type") as HTMLSelectElement).value).toBe("threads");
    expect(byId("timeline-marks").children).toHaveLength(1);
    fireEvent.keyDown(row, { key: "Enter" });
    await settle();
    const selected = viewing(),
      sent = scanTimes().length;
    collector.bounds = { first: 1000, last: 2020 };
    await advance(15000);
    expect(scanTimes()).toHaveLength(sent);
    expect(viewing()).toBe(selected);
    expect(row.getAttribute("aria-current")).toBe("true");
    fireEvent.click(byId("replay-live"));
    await settle();
    await advance(15000);
    expect(scanTimes().length).toBeGreaterThan(sent);
    expect(byId("history-list").children[0]).toBe(row);
  });

  test("a single recording at zero has one row and a zero-width mark", async () => {
    vi.setSystemTime(0);
    open({
      bounds: { first: 0, last: 0 },
      live: frame(0, "live"),
      snapshotAt: () => frame(0, "old", 99),
    });
    await settle();
    expect(scanTimes()).toEqual([0]);
    expect([range().min, range().max, range().disabled]).toEqual([
      "0",
      "1",
      false,
    ]);
    expect(byId("past-count").textContent).toBe("1 finding");
    const mark = byId("timeline-marks").children[0] as HTMLElement;
    expect([mark.style.left, mark.style.width]).toEqual(["0%", "0%"]);
    expect(document.getElementById("history-more")).toBeNull();
  });

  test("a failed period shows its error and Load earlier retries it", async () => {
    open({
      replay: () =>
        Promise.resolve(Response.json({ error: "bad at" }, { status: 500 })),
    });
    await settle();
    expect(status()).toBe("bad at Select Load earlier to try again.");
    collector.replay = undefined;
    fireEvent.click(byId("history-more"));
    await settle();
    expect(status()).toMatch(/^Checked /);
  });

  test("a failed read stops new slots and keeps the batch busy until its other reads finish", async () => {
    const waiting: (() => void)[] = [];
    open({
      replay: () =>
        scanTimes().length === 1
          ? Promise.resolve(
              Response.json({ error: "first read failed" }, { status: 500 }),
            )
          : new Promise((done) =>
              waiting.push(() => {
                done(
                  Response.json({
                    first: 1000,
                    last: 1900,
                    interval_s: 1,
                    snapshot: null,
                  }),
                );
              }),
            ),
    });
    await settle();
    expect(scanTimes()).toHaveLength(4);
    expect(status()).toBe("Checking the latest recordings…");
    await advance(15000);
    expect(scanTimes()).toHaveLength(4);
    for (const done of waiting) done();
    await settle();
    expect(status()).toBe(
      "first read failed Select Load earlier to try again.",
    );
    expect(scanTimes()).toHaveLength(4);
    collector.replay = undefined;
    fireEvent.click(byId("history-more"));
    await settle();
    expect(status()).toMatch(/^Checked /);
  });

  test("without recordings there is nothing to check", async () => {
    open({ bounds: { first: null, last: null }, snapshotAt: () => null });
    await settle();
    expect(status()).toBe("No recordings to check.");
    expect(range().disabled).toBe(true);
    expect(scanTimes()).toEqual([]);
  });

  test("the first period starts when recordings appear after the page opens", async () => {
    open({ bounds: { first: null, last: null }, snapshotAt: () => null });
    await settle();
    expect(scanTimes()).toEqual([]);
    collector.bounds = { first: 1000, last: 1900 };
    collector.snapshotAt = spinView;
    await advance(15000);
    expect(scanTimes()).toHaveLength(120);
    expect(rows()).toEqual(["old-worker is saturating a core"]);
  });

  test("a failed first period retries by itself on the next bounds read", async () => {
    open({
      replay: () =>
        Promise.resolve(Response.json({ error: "bad at" }, { status: 500 })),
    });
    await settle();
    expect(status()).toBe("bad at Select Load earlier to try again.");
    collector.replay = undefined;
    await advance(15000);
    expect(status()).toMatch(/^Checked /);
    expect(rows()).toEqual(["old-worker is saturating a core"]);
  });

  test("unmount during a batch sends and applies nothing more", async () => {
    const waiting: (() => void)[] = [];
    const page = open({
      replay: (at) =>
        new Promise((done) => {
          waiting.push(() => {
            done(
              Response.json({
                first: 1000,
                last: 1900,
                interval_s: 1,
                snapshot: spinView(at),
              }),
            );
          });
        }),
    });
    await settle();
    expect(scanTimes()).toHaveLength(4);
    const signals = vi
      .mocked(fetch)
      .mock.calls.filter(
        (_, index) => requests[index]?.searchParams.get("direction") === "at",
      )
      .map(([, options]) => options?.signal);
    expect(signals).toHaveLength(4);
    const errors = vi.spyOn(console, "error");
    page.unmount();
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    const sent = requests.length;
    for (const done of waiting) done();
    await settle();
    expect(requests.length).toBe(sent);
    expect(errors).not.toHaveBeenCalled();
  });

  test("a late scan reply cannot replace a selected recording, and pagehide does not stop the scan", async () => {
    let release: () => void = () => undefined;
    open({
      gate: new Promise<void>((done) => {
        release = done;
      }),
    });
    await settle();
    expect(scanTimes()).toEqual([]);
    fireEvent.click(byId("replay-previous"));
    await settle();
    expect(byId("target-name").textContent).toBe("old-worker");
    dispatchEvent(new Event("pagehide"));
    const saved = storage();
    release();
    await settle();
    expect(scanTimes()).toHaveLength(1 + 120);
    expect(byId("target-name").textContent).toBe("old-worker");
    expect(viewing()).toBe(1900);
    expect(storage()).toEqual(saved);
    expect(status()).toMatch(/^Checked 108 recordings/);
  });
});
