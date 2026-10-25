// 10a ports pinned tests 990,1020,1041,1057,1072,1086,1097,1391,1411,
// 1433,1459,1483,1494,1508,1518,1531,1551,1566,1582,1610,2302.
// 10b's remaining test handoff is at lib/observation.test.ts.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";
import type { LiveResponse, MemoryLayout } from "./api/types";

function frame(at: number, session = "live", pid = 9): LiveResponse {
  return {
    recorded_at: at,
    process: { session, pid, started_at: 500, command: `${session}-process` },
    health: {
      session,
      pid,
      last_seen: at,
      target_absent: false,
      sampler_silent: false,
      sample_interval_ms: 1000,
    },
    threads: [
      {
        tid: pid,
        name: `${session}-worker`,
        generation: 1,
        group: "workers",
        state: "running",
        state_mix: { running: 1 },
        last_sample: at,
        cpu_pct: session === "live" ? 80 : 25,
        run_delay_pct: 0,
        cpu: 3,
        switches_per_s: 2,
      },
    ],
    groups: { workers: 1 },
    resources: {
      available: true,
      session,
      pid,
      updated: at,
      memory: { rss: 8388608 },
      fds: { open: 12 },
    },
    memory: {
      available: true,
      pid,
      layout_id: `${session}:1`,
      updated: at,
      values: { vm_size_bytes: 16777216 },
    },
  };
}
const watches = {
  rules: [{ prefix: "live-", wake_ms: 1000 }],
  revision: "r1",
  source: "config",
  saved_error: null,
  limits: {
    prefix_max_bytes: 15,
    wake_ms_min: 1,
    wake_ms_max: 60000,
    max_rules: 256,
  },
};
const layout: MemoryLayout = {
  available: true,
  id: "live:1",
  pid: 9,
  updated: 2000,
  regions: [
    {
      start: "0x1000",
      end: "0x2000",
      size: 4096,
      vmas: 1,
      kind: "heap",
      permissions: "rw-p",
      name: "[heap]",
    },
  ],
};
let current: LiveResponse;
let snapshot: LiveResponse | null;
let kept: unknown;
let first: number;
let last: number;
let requests: URL[];
let pending: Map<string, () => Promise<Response>>;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 15; ++i) await Promise.resolve();
  });
};
const tick = async (ms = 1000) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};
function byId(id: string) {
  const value = document.getElementById(id);
  if (!value) throw Error(`Missing ${id}`);
  return value;
}
function input(id: string) {
  const value = byId(id);
  if (!(value instanceof HTMLInputElement)) throw Error(`Not an input: ${id}`);
  return value;
}
function element(selector: string) {
  const value = document.querySelector(selector);
  if (!value) throw Error(`Missing ${selector}`);
  return value;
}
function savedBuffer() {
  return JSON.parse(
    sessionStorage.getItem("triangulator:buffer:host/app") ?? "{}",
  ) as { session: string; points: { t: number }[] };
}
const storage = () =>
  Object.fromEntries(
    Object.keys(sessionStorage)
      .sort()
      .map((key) => [key, sessionStorage.getItem(key)]),
  );
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<Response>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return {
    promise,
    reject,
    resolve: (value: unknown) => {
      resolve(Response.json(value));
    },
  };
}
async function open() {
  render(<App />);
  await flush();
}
async function previous() {
  fireEvent.click(screen.getByRole("button", { name: "Previous recording" }));
  await flush();
}
async function live() {
  fireEvent.click(byId("replay-live"));
  await flush();
}
const meta = () => byId("target-meta").textContent;
const absent = (session = "absent", expected?: string): LiveResponse => ({
  health: {
    session,
    pid: 0,
    last_seen: 2100,
    sampler_silent: false,
    target_absent: true,
    ...(expected ? { last_target: { session: expected } } : {}),
  },
  threads: [],
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(2000000);
  history.replaceState(null, "", "/?target=host%2Fapp");
  sessionStorage.clear();
  localStorage.clear();
  current = frame(2000);
  snapshot = frame(1000, "old");
  kept = { available: false };
  first = 900;
  last = 1100;
  requests = [];
  pending = new Map();
  fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      location.href,
    );
    requests.push(url);
    const override = pending.get(url.pathname);
    if (override) return await override();
    if (url.pathname === "/api/live") return Response.json(current);
    if (url.pathname === "/api/targets")
      return Response.json({
        targets: [
          {
            key: "host/app",
            host: "host",
            id: "app",
            pid: current.health.pid,
            status: "live",
            process: null,
          },
        ],
      });
    if (url.pathname === "/api/replay")
      return Response.json({
        first,
        last,
        interval_s: 1,
        ...(url.searchParams.has("at") ? { snapshot } : {}),
      });
    if (url.pathname === "/api/last-target") return Response.json(kept);
    if (url.pathname === "/api/memory-map") return Response.json(layout);
    if (url.pathname === "/api/resources")
      return Response.json({
        rows: [900, 1000, 1100, 2000, 3000].map((ts) => ({
          ts,
          pid: ts < 1500 ? 9 : current.health.pid,
          rss_bytes: ts * 1000,
          elapsed_s: 10,
          fd_open: 12,
        })),
        bucket_s: 1,
        truncated: false,
        read_error: false,
      });
    if (url.pathname === "/api/watches") return Response.json(watches);
    if (url.pathname === "/api/history")
      return Response.json({ rows: [], limit: 2000, truncated: false });
    return Response.json({ available: false, reason: "No observer" });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
  sessionStorage.clear();
  localStorage.clear();
});

test("recorded panels share the selected clock, rates and identity; return preserves live trends and controls", async () => {
  await open();
  fireEvent.click(element('[data-map-window="300"]'));
  fireEvent.change(byId("search"), { target: { value: "worker" } });
  dispatchEvent(new Event("pagehide"));
  const before = storage();
  await previous();
  expect(meta()).toContain("Historical");
  expect(
    element(".status-dot[aria-label=Historical]").classList.contains("warning"),
  ).toBe(true);
  expect(byId("target-name").textContent).toBe("old-worker");
  expect(byId("hero-load").textContent).toBe("—");
  expect(byId("hero-cpu").textContent).toBe("0.25 cores");
  expect(byId("socket-panel").hidden).toBe(true);
  expect(byId("chart-load").closest("[hidden]")).not.toBeNull();
  expect(byId("chart-states").closest("[hidden]")).not.toBeNull();
  expect(byId("watch-editor").closest("[hidden]")).not.toBeNull();
  expect(byId("watch-recorded-readonly").textContent).toContain(
    "cannot be edited",
  );
  expect(
    document
      .querySelector('[data-map-window="0"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    (document.querySelector('[data-map-window="300"]') as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (JSON.parse(byId("diagnostics").textContent) as { session: string })
      .session,
  ).toBe("old");
  expect(byId("memory-sub").textContent).toContain("latest layout");
  expect(byId("process-facts").textContent).toContain("up 8 min");
  fireEvent.click(element("#threads tr[data-tid]"));
  await flush();
  const historyRequest = requests
    .filter((url) => url.pathname === "/api/history")
    .at(-1);
  if (!historyRequest) throw Error("Missing history request");
  expect(historyRequest.searchParams.get("session")).toBe("old");
  expect(Number(historyRequest.searchParams.get("end"))).toBe(1000);
  expect(byId("drawer-live").closest("[hidden]")).not.toBeNull();
  const resourceRequests = requests.filter(
    (url) =>
      url.pathname === "/api/resources" &&
      Number(url.searchParams.get("end")) === 1000,
  );
  expect(resourceRequests.length).toBeGreaterThan(0);
  dispatchEvent(new Event("pagehide"));
  expect(storage()).toEqual(before);
  current = frame(2001);
  await tick();
  expect(meta()).toContain("Historical");
  expect(byId("hero-cpu").textContent).toBe("0.25 cores");
  await live();
  expect(meta()).toContain("Live");
  expect(byId("drawer").getAttribute("aria-hidden")).toBe("true");
  expect(
    document
      .querySelector('[data-map-window="300"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(input("search").value).toBe("worker");
  dispatchEvent(new Event("pagehide"));
  expect(savedBuffer().points.map((point: { t: number }) => point.t)).toEqual([
    2000, 2001,
  ]);
});

test("recorded mode stops layout, socket and watch reads, including editor retries", async () => {
  await open();
  await previous();
  const count = requests.length;
  current = frame(2010, "replacement", 77);
  await tick(12000);
  const paths = requests.slice(count).map((url) => url.pathname);
  for (const path of ["/api/socket-io", "/api/memory-map", "/api/watches"])
    expect(paths).not.toContain(path);
  expect(paths).toContain("/api/live");
  expect(paths).toContain("/api/targets");
  expect(byId("target-name").textContent).toBe("old-worker");
  await live();
  expect(byId("target-name").textContent).toBe("replacement-worker");
  dispatchEvent(new Event("pagehide"));
  const saved = savedBuffer();
  expect(saved.session).toBe("replacement");
  expect(saved.points).toHaveLength(1);
});

test("newer selection and return reject late snapshot successes and errors", async () => {
  await open();
  const old = deferred();
  pending.set("/api/replay", () => old.promise);
  fireEvent.click(byId("replay-previous"));
  await flush();
  pending.delete("/api/replay");
  await previous();
  old.resolve({ first, last, snapshot: frame(900, "late") });
  await flush();
  expect(byId("target-name").textContent).toBe("old-worker");
  const abandoned = deferred();
  pending.set("/api/replay", () => abandoned.promise);
  fireEvent.click(byId("replay-previous"));
  await flush();
  await live();
  abandoned.resolve({ first, last, snapshot: frame(900, "abandoned") });
  await flush();
  expect(meta()).toContain("Live");
  expect(byId("replay-note").textContent).toContain("Live view");
});

test("missing, invalid, failed and gap recordings retain the last successful view", async () => {
  await open();
  await previous();
  snapshot = null;
  await previous();
  expect(byId("target-name").textContent).toBe("old-worker");
  expect(byId("replay-note").textContent).toContain("No more");
  pending.set("/api/replay", () =>
    Promise.resolve(
      Response.json({ first, last, snapshot: { health: {}, threads: [] } }),
    ),
  );
  await previous();
  expect(byId("replay-note").textContent).toContain("Invalid recorded");
  expect(meta()).toContain("Historical");
  pending.set("/api/replay", () =>
    Promise.resolve(
      Response.json({ error: "Recording read failed" }, { status: 500 }),
    ),
  );
  await previous();
  expect(byId("replay-note").textContent).toContain("Recording read failed");
  pending.delete("/api/replay");
  snapshot = frame(900, "gap");
  fireEvent.change(byId("timeline-range"), { target: { value: "1500" } });
  await flush();
  expect(byId("replay-note").textContent).toContain("recording gap");
});

test("Timeline previews input, selects change, respects bounds and accepts collector time ahead", async () => {
  snapshot = frame(3000, "ahead");
  first = last = 3000;
  await open();
  expect((byId("replay-next") as HTMLButtonElement).disabled).toBe(true);
  const range = input("timeline-range");
  const count = requests.filter((url) => url.searchParams.has("at")).length;
  fireEvent.input(range, { target: { value: "3000" } });
  await flush();
  expect(requests.filter((url) => url.searchParams.has("at"))).toHaveLength(
    count,
  );
  fireEvent.pointerCancel(range);
  expect(byId("timeline-cursor").textContent).toBe("");
  await previous();
  expect(byId("target-name").textContent).toBe("ahead-worker");
  expect((byId("replay-previous") as HTMLButtonElement).disabled).toBe(true);
  expect((byId("replay-next") as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(range, { target: { value: range.max } });
  await flush();
  expect(meta()).toContain("Live");
});

test("confirmed absence freezes panels, survives restart, and final Settings counts current threads", async () => {
  await open();
  current = frame(2001);
  await tick();
  current = absent();
  await tick();
  expect(meta()).toContain("Stopped reporting");
  expect(
    element('.status-dot[aria-label="Stopped reporting"]').classList.contains(
      "critical",
    ),
  ).toBe(true);
  expect(byId("exited").hidden).toBe(false);
  expect(byId("hero-cpu").textContent).toBe("0.80 cores");
  const finalRequests = requests.length;
  current = frame(2200, "replacement", 77);
  await tick(10000);
  expect(byId("target-name").textContent).toBe("live-worker");
  expect(byId("exited-text").textContent).toContain("new process (PID 77)");
  expect(
    requests.slice(finalRequests).map((url) => url.pathname),
  ).not.toContain("/api/socket-io");
  expect(
    requests.slice(finalRequests).map((url) => url.pathname),
  ).not.toContain("/api/memory-map");
  expect(byId("watch-editor").textContent).toContain(
    "No live thread name starts with this prefix.",
  );
  fireEvent.click(byId("exited-live"));
  await flush();
  expect(byId("target-name").textContent).toBe("replacement-worker");
  expect(byId("exited").hidden).toBe(true);
});

test("settling retains populated panels for ten seconds, then accepts an unconfirmed empty session", async () => {
  await open();
  current = { ...frame(2100, "starting", 0), threads: [] };
  await tick();
  expect(byId("target-name").textContent).toBe("live-worker");
  await tick(9000);
  expect(byId("target-name").textContent).toBe("live-worker");
  await tick();
  expect(byId("target-name").textContent).toBe("the target");
  expect(byId("exited").hidden).toBe(true);
});

test("an exit during replay freezes saved live analysis; dismissal leaves the recording open", async () => {
  await open();
  await previous();
  current = absent();
  await tick();
  expect(byId("exited").hidden).toBe(false);
  expect(meta()).toContain("Historical");
  current = frame(2200, "restart", 77);
  await tick();
  await live();
  expect(meta()).toContain("Stopped reporting");
  expect(byId("target-name").textContent).toBe("live-worker");
  await previous();
  fireEvent.click(byId("exited-live"));
  await flush();
  expect(meta()).toContain("Historical");
  expect(byId("exited").hidden).toBe(true);
  await live();
  expect(byId("target-name").textContent).toBe("restart-worker");
});

test("final view restores compatible layout and trends without replacement reads; late exits match session and PID", async () => {
  const app = render(<App />);
  await flush();
  current = frame(2001);
  await tick();
  current = absent();
  await tick();
  const exit = {
    pid: 9,
    session: "live",
    name: "worker",
    ended_at: 2002,
    reason: "segfault",
    next_session: "absent",
  };
  current = { ...absent(), exit: { ...exit, pid: 77 } };
  await tick();
  expect(document.getElementById("process-exit")).toBeNull();
  expect(byId("exited-text").textContent).toContain(
    "it exited or is no longer the target",
  );
  current = { ...absent(), exit };
  await tick();
  expect(byId("process-exit").textContent).toContain("Segmentation fault");
  expect(byId("exited-text").textContent).toContain(
    "it ended (Segmentation fault)",
  );
  current = { ...absent(), exit: { ...exit, session: "unrelated" } };
  await tick();
  app.unmount();
  const count = requests.length;
  await open();
  expect(meta()).toContain("Stopped reporting");
  expect(byId("process-exit").textContent).toContain("Segmentation fault");
  expect(requests.slice(count).map((url) => url.pathname)).not.toContain(
    "/api/memory-map",
  );
  expect(byId("memory-amap").textContent).toBeDefined();
  expect(savedBuffer().points).toHaveLength(2);
});

test.each(["ok", "wrong", "empty", "retry"])(
  "fresh tab last-target %s is session checked and dismissed once",
  async (kind) => {
    current = absent("now", "old");
    kept =
      kind === "wrong"
        ? frame(1000, "wrong")
        : kind === "empty"
          ? { ...frame(1000, "old"), threads: [] }
          : frame(1000, "old");
    if (kind === "retry")
      pending.set("/api/last-target", () =>
        Promise.resolve(Response.json({}, { status: 500 })),
      );
    await open();
    if (kind === "retry") {
      expect(byId("exited").hidden).toBe(true);
      pending.delete("/api/last-target");
      await tick();
    }
    expect(byId("exited").hidden).toBe(kind === "wrong" || kind === "empty");
    const count = requests.filter(
      (url) => url.pathname === "/api/last-target",
    ).length;
    if (kind === "ok" || kind === "retry") {
      fireEvent.click(byId("exited-live"));
      await flush();
    }
    await tick(5000);
    expect(
      requests.filter((url) => url.pathname === "/api/last-target"),
    ).toHaveLength(count);
  },
);

test("frozen storage validation and quota failure keep usable final panels", async () => {
  sessionStorage.setItem(
    "triangulator:frozen:host/app",
    JSON.stringify({ at: "bad", live: frame(1000) }),
  );
  await open();
  expect(sessionStorage.getItem("triangulator:frozen:host/app")).toBeNull();
  const original = Storage.prototype.setItem.bind(sessionStorage);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key,
    value,
  ) {
    if (key.startsWith("triangulator:frozen"))
      throw Error("QuotaExceededError");
    original(key, value);
  });
  current = absent();
  await tick();
  expect(meta()).toContain("Stopped reporting");
  expect(byId("exited-text").textContent).toContain(
    "too large to keep across a reload",
  );
  vi.restoreAllMocks();
});

test("late resource, layout and thread-history delivery cannot cross recording selection or return", async () => {
  const resource = deferred(),
    memory = deferred(),
    history = deferred();
  pending.set("/api/resources", () => resource.promise);
  pending.set("/api/memory-map", () => memory.promise);
  await open();
  fireEvent.click(element("#threads tr[data-tid]"));
  pending.set("/api/history", () => history.promise);
  await flush();
  // Select a recording without resources so the old live resource reply stays pending.
  snapshot = { ...frame(1000, "old"), resources: { available: false } };
  await previous();
  resource.resolve({
    rows: [{ ts: 3000, pid: 9, rss_bytes: 999999999, elapsed_s: 10 }],
    bucket_s: 1,
  });
  memory.resolve(layout);
  history.resolve({ rows: [], limit: 2000 });
  await flush();
  expect(byId("target-name").textContent).toBe("old-worker");
  expect(byId("overview-rss").textContent).not.toContain("953");
  expect(byId("drawer").getAttribute("aria-hidden")).toBe("true");
  expect(byId("memory-map").textContent).not.toContain("[heap]");
});

test("recorded mixes and readouts keep Other and No access distinct while panels are held", async () => {
  await open();
  fireEvent.focus(byId("search"));
  fireEvent.mouseEnter(element("#threads-live"));
  fireEvent.mouseEnter(element("#mosaic .cell"));
  snapshot = {
    ...frame(1000, "old"),
    threads: [
      {
        tid: 9,
        name: "old-worker",
        generation: 1,
        state: "other",
        state_mix: { other: 1, no_access: 3 },
        last_sample: 1000,
        cpu_pct: 25,
      },
    ],
  };
  await previous();
  expect(byId("threads").textContent).toContain("old-worker");
  expect(element("#mosaic .cell").getAttribute("aria-label")).toContain(
    "old-worker",
  );
  expect(element("#threads .mix .other").getAttribute("style")).toContain(
    "25%",
  );
  expect(element("#threads .mix .no_access").getAttribute("style")).toContain(
    "75%",
  );
  const mix = element("#threads .mix");
  fireEvent.mouseMove(mix, { clientX: 50, clientY: 50 });
  await tick(1200);
  expect(screen.getByRole("dialog").textContent).toContain("Recorded at");
  expect(screen.getByRole("dialog").textContent).toContain("No access");
  expect(screen.getByRole("dialog").textContent).toContain("Other");
  await live();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(byId("threads").textContent).toContain("live-worker");
  expect(element("#mosaic .cell").getAttribute("aria-label")).toContain(
    "live-worker",
  );
});

test("last-target replies must still name the expected absent session", async () => {
  current = absent("now", "old");
  const late = deferred();
  pending.set("/api/last-target", () => late.promise);
  await open();
  current = frame(2200, "replacement", 77);
  await tick();
  late.resolve(frame(1000, "old"));
  await flush();
  expect(byId("exited").hidden).toBe(true);
  expect(byId("target-name").textContent).toBe("replacement-worker");
});

test("a late live success updates only metadata during replay; a late live error leaves its note unchanged", async () => {
  const late = deferred();
  pending.set("/api/live", () => late.promise);
  await open();
  await previous();
  late.resolve(frame(2200, "replacement", 77));
  await flush();
  expect(byId("target-name").textContent).toBe("old-worker");
  pending.set("/api/live", () =>
    Promise.resolve(
      Response.json({ error: "late current error" }, { status: 500 }),
    ),
  );
  await tick();
  expect(byId("replay-note").textContent).toContain("Recorded view");
  await live();
  expect(byId("target-name").textContent).toBe("replacement-worker");
});

test("recorded custom thread history ends at the recording and preserves the custom inputs for return", async () => {
  await open();
  fireEvent.click(element("#threads tr[data-tid]"));
  await flush();
  const local = (seconds: number) => {
    const date = new Date(seconds * 1000);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 19);
  };
  fireEvent.change(byId("from"), { target: { value: local(500) } });
  fireEvent.change(byId("to"), { target: { value: local(2500) } });
  fireEvent.click(byId("load-history"));
  await flush();
  await previous();
  fireEvent.click(element("#threads tr[data-tid]"));
  await flush();
  const request = requests
    .filter((url) => url.pathname === "/api/history")
    .at(-1);
  expect(request?.searchParams.get("session")).toBe("old");
  expect(Number(request?.searchParams.get("end"))).toBe(1000);
  expect(input("from").value).toBe(local(500));
  expect(input("to").value).toBe(local(2500));
  await live();
  fireEvent.click(element("#threads tr[data-tid]"));
  await flush();
  expect(input("to").value).toBe(local(2500));
  fireEvent.click(element('[data-range="900"]'));
  await flush();
  fireEvent.click(byId("drawer-close"));
  fireEvent.click(element("#threads tr[data-tid]"));
  await flush();
  expect(element('[data-range="900"]').getAttribute("aria-pressed")).toBe(
    "true",
  );
});

test.each([
  "/api/replay",
  "/api/resources",
  "/api/memory-map",
  "/api/history",
  "/api/live",
])(
  "late %s errors cannot change a successful recorded observation",
  async (path) => {
    const late = deferred();
    if (path !== "/api/replay") pending.set(path, () => late.promise);
    await open();
    if (path === "/api/history") {
      fireEvent.click(element("#threads tr[data-tid]"));
      await flush();
    }
    if (path === "/api/replay") {
      pending.set(path, () => late.promise);
      fireEvent.click(byId("replay-previous"));
      await flush();
      pending.delete(path);
    }
    snapshot = { ...frame(1000, "old"), resources: { available: false } };
    await previous();
    const note = byId("replay-note").textContent;
    late.reject(Error("abandoned request failed"));
    await flush();
    expect(byId("target-name").textContent).toBe("old-worker");
    expect(byId("replay-note").textContent).toBe(note);
    expect(byId("drawer").getAttribute("aria-hidden")).toBe("true");
  },
);

test("live socket read errors retain the report and stale status; final mode stops refresh", async () => {
  await open();
  expect(byId("socket-status").textContent).toBe("Not available");
  pending.set("/api/socket-io", () =>
    Promise.resolve(Response.json({}, { status: 503 })),
  );
  await tick(3000);
  expect(byId("socket-status").textContent).toBe("Report unavailable · stale");
  expect(byId("socket-empty").textContent).toContain("No observer");
  current = absent();
  await tick();
  const count = requests.filter(
    (url) => url.pathname === "/api/socket-io",
  ).length;
  await tick(6000);
  expect(
    requests.filter((url) => url.pathname === "/api/socket-io"),
  ).toHaveLength(count);
  expect(byId("socket-status").textContent).toBe("Report unavailable · stale");
});

test("a recording at zero keeps the resource range end at zero", async () => {
  first = last = 0;
  snapshot = frame(0, "old");
  await open();
  await previous();
  fireEvent.click(element('[data-res-range="3600"]'));
  await flush();
  const request = requests
    .filter((url) => url.pathname === "/api/resources")
    .at(-1);
  expect(Number(request?.searchParams.get("end"))).toBe(0);
  expect(byId("target-name").textContent).toBe("old-worker");
});
