import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { helpTopics } from "./help/topics";
import type { LiveResponse, TargetsResponse } from "./api/types";

// The target name in the top bar, not the thread of the same name.
const topBar = { ignore: "script, style, #threads-section *" };
const targets: TargetsResponse = {
  targets: [
    {
      key: "host/worker",
      host: "host",
      id: "worker",
      pid: 42,
      status: "live",
      process: { command: "worker --serve" },
    },
  ],
};
const live: LiveResponse = {
  health: {
    pid: 42,
    last_seen: 100,
    sampler_silent: false,
    target_absent: false,
  },
  threads: [{ tid: 42, name: "worker" }],
};
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

test.each(["/", "/?target=host%2Fworker"])(
  "renders the shell at %s with only registered help topics",
  async (url) => {
    history.replaceState(null, "", url);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          Response.json(
            typeof input === "string" && input.startsWith("/api/targets")
              ? targets
              : live,
          ),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<App />);
    await screen.findByRole("option", { name: /host · worker/ });
    if (url.includes("target")) {
      await screen.findByText("worker", topBar);
      expect(screen.getByText("PID 42 · Live")).toBeDefined();
      expect(
        fetchMock.mock.calls.some(
          (call) => call[0] === "/api/live?target=host%2Fworker",
        ),
      ).toBe(true);
    } else {
      expect(screen.getByRole("heading", { name: "Targets" })).toBeDefined();
      expect(
        fetchMock.mock.calls.every(
          (call) =>
            call[0] === "/api/targets" ||
            call[0] === "/api/targets/control" ||
            call[0] === "/api/live?target=host%2Fworker",
        ),
      ).toBe(true);
    }
    // Only the target page has sections to navigate.
    const sections = screen.queryByRole("navigation", { name: "Sections" });
    if (url.includes("target")) {
      expect(container.querySelector('[data-activity="idle"]')).not.toBeNull();
      expect(
        screen.getByRole("link", { name: "Summary" }).getAttribute("href"),
      ).toBe("#overview");
    } else expect(sections).toBeNull();
    const help = container.querySelectorAll<HTMLElement>("[data-help]");
    expect(help.length).toBeGreaterThan(0);
    for (const element of help)
      expect(Object.hasOwn(helpTopics, element.dataset.help ?? "")).toBe(true);
  },
);

test("restores and saves the theme under the existing key", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(Response.json(targets))),
  );
  localStorage.setItem("triangulator:theme", "dark");
  render(<App />);
  const theme = screen.getByRole<HTMLSelectElement>("combobox", {
    name: "Color theme",
  });
  expect(theme.value).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");
  fireEvent.change(theme, { target: { value: "light" } });
  expect(document.documentElement.dataset.theme).toBe("light");
  expect(localStorage.getItem("triangulator:theme")).toBe("light");
  fireEvent.change(theme, { target: { value: "auto" } });
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  expect(localStorage.getItem("triangulator:theme")).toBe("auto");
  await screen.findByRole("option", { name: /host · worker/ });
});

test("reports poll failures and keeps the last target name", async () => {
  history.replaceState(null, "", "/?target=host%2Fworker");
  let failed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation((input) => {
      if (typeof input === "string" && input.startsWith("/api/targets"))
        return Promise.resolve(Response.json(targets));
      return failed
        ? Promise.reject(new Error("Collector unavailable"))
        : Promise.resolve(Response.json(live));
    }),
  );
  render(<App />);
  await screen.findByText("worker", topBar);
  failed = true;
  await waitFor(
    () => {
      // The socket panel has its own status badge.
      expect(
        screen.getAllByRole("status").map((status) => status.textContent),
      ).toContain("⚠ Collector unavailable. Displayed data is stale.");
    },
    { timeout: 2500 },
  );
  expect(screen.getByText("worker", topBar)).toBeDefined();
});

test("uses a safe default when stored theme data is invalid", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(Response.json(targets))),
  );
  localStorage.setItem("triangulator:theme", "invalid");
  render(<App />);
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  expect(
    screen.getByRole<HTMLSelectElement>("combobox", { name: "Color theme" })
      .value,
  ).toBe("auto");
  await screen.findByRole("option", { name: /host · worker/ });
});

// The served page computes the Summary in the browser from /api/live.
test("the target page shows the Summary with a load average after two ticks", async () => {
  history.replaceState(null, "", "/?target=host%2Fworker");
  let tick = 100;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation((input) => {
      if (typeof input === "string" && input.startsWith("/api/targets"))
        return Promise.resolve(Response.json(targets));
      tick++;
      return Promise.resolve(
        Response.json({
          ...live,
          health: { ...live.health, session: "s", last_seen: tick },
          threads: [
            {
              tid: 42,
              generation: 1,
              name: "worker",
              last_sample: tick,
              cpu_pct: 100,
              run_delay_pct: 0,
              state: "running",
            },
          ],
        }),
      );
    }),
  );
  const { container } = render(<App />);
  expect(container.querySelector("section#overview")).not.toBeNull();
  await waitFor(
    () => {
      expect(document.getElementById("hero-load")?.textContent).toBe("1.00");
      expect(
        container.querySelectorAll("#chart-load svg polygon").length,
      ).toBeGreaterThan(0);
    },
    { timeout: 4000 },
  );
});

test("switching targets clears the view caches of both targets and keeps others", () => {
  history.replaceState(null, "", "/?target=host-a%2Forders");
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation(() => new Promise(() => undefined)),
  );
  for (const [key, value] of [
    ["triangulator:buffer:host-a/orders", "old"],
    ["triangulator:threads:host-b/billing", "old"],
    ["triangulator:frozen:host-b/billing", "old"],
    ["triangulator:buffer:host-c/gateway", "keep"],
  ] as const)
    sessionStorage.setItem(key, value);
  const assign = vi.fn();
  vi.stubGlobal("location", {
    assign,
    hash: "",
    pathname: location.pathname,
    search: location.search,
  });
  render(<App />);
  const select = screen.getByRole("combobox", {
    name: "Selected monitoring target",
  });
  const option = document.createElement("option");
  option.value = "host-b/billing";
  select.append(option);
  fireEvent.change(select, { target: { value: "host-b/billing" } });
  expect(assign).toHaveBeenCalledWith("/?target=host-b%2Fbilling");
  // The caches go when the page really unloads, not when the user selects.
  expect(sessionStorage.getItem("triangulator:buffer:host-a/orders")).toBe(
    "old",
  );
  dispatchEvent(new Event("pagehide"));
  expect(
    sessionStorage.getItem("triangulator:buffer:host-a/orders"),
  ).toBeNull();
  expect(
    sessionStorage.getItem("triangulator:threads:host-b/billing"),
  ).toBeNull();
  expect(
    sessionStorage.getItem("triangulator:frozen:host-b/billing"),
  ).toBeNull();
  expect(sessionStorage.getItem("triangulator:buffer:host-c/gateway")).toBe(
    "keep",
  );
  sessionStorage.clear();
});

test("the target page shows the last process exit that /api/live reports", async () => {
  history.replaceState(null, "", "/?target=host%2Fworker");
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation((input) =>
      Promise.resolve(
        Response.json(
          typeof input === "string" && input.startsWith("/api/targets")
            ? targets
            : {
                ...live,
                health: { ...live.health, session: "n", target_absent: true },
                threads: [],
                exit: {
                  pid: 42,
                  name: "worker",
                  ended_at: 100,
                  reason: "killed",
                  signal: 9,
                  signal_name: "SIGKILL",
                  next_session: "n",
                  kernel_log: "read",
                  messages: [],
                },
              },
        ),
      ),
    ),
  );
  render(<App />);
  expect(
    await screen.findByText("Killed by SIGKILL", {}, { timeout: 2000 }),
  ).toBeDefined();
  expect(
    document.querySelector("section#overview section#process-exit"),
  ).not.toBeNull();
});

// Old test 2950: the thread fragment must not discard the selected target.
test("a thread URL opens the drawer and closing it keeps the target query", async () => {
  history.replaceState(null, "", "/?target=host%2Fworker#thread=42");
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          Response.json(
            (typeof input === "string" ? input : "").startsWith("/api/targets")
              ? targets
              : (typeof input === "string" ? input : "").startsWith(
                    "/api/history",
                  )
                ? { rows: [], truncated: false }
                : live,
          ),
        ),
      ),
  );
  render(<App />);
  await waitFor(() => {
    expect(document.querySelector("#drawer.open")).not.toBeNull();
  });
  fireEvent.click(screen.getByRole("button", { name: "Close thread details" }));
  expect(location.search).toBe("?target=host%2Fworker");
  expect(location.hash).toBe("");
  expect(document.querySelector("#drawer.open")).toBeNull();
});

test.each(["table", "map"])(
  "a held %s thread opens history from its own session after a poll",
  async (surface) => {
    history.replaceState(null, "", "/?target=host%2Fworker");
    const thread = {
      tid: 42,
      generation: 1,
      name: "session A worker",
      state: "running",
      cpu_pct: 10,
      last_sample: 100,
    };
    let liveCalls = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : "";
      if (url.startsWith("/api/targets"))
        return Promise.resolve(Response.json(targets));
      if (url.startsWith("/api/history"))
        return Promise.resolve(Response.json({ rows: [], truncated: false }));
      // Only /api/live answers count as polls.
      if (url.startsWith("/api/watches"))
        return Promise.resolve(Response.json({}, { status: 404 }));
      liveCalls++;
      return Promise.resolve(
        Response.json({
          ...live,
          health: {
            ...live.health,
            session: liveCalls === 1 ? "session-A" : "session-B",
          },
          threads: [
            liveCalls === 1 ? thread : { ...thread, name: "session B worker" },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    const row = await waitFor(() => {
      const item = document.querySelector<HTMLElement>(
        "#threads tr[data-tid='42']",
      );
      expect(item?.textContent).toContain("session A worker");
      return item as HTMLElement;
    });
    const tile = document.querySelector<HTMLElement>("#mosaic [data-tid='42']");
    if (!tile) throw new Error("Missing thread map tile");
    if (surface === "table") fireEvent.focus(row);
    else fireEvent.mouseEnter(tile);
    await waitFor(
      () => {
        expect(liveCalls).toBeGreaterThanOrEqual(2);
      },
      { timeout: 2500 },
    );
    await act(async () => {
      await Promise.resolve();
    });
    if (surface === "table")
      expect(row.textContent).toContain("session A worker");
    else expect(tile.getAttribute("aria-label")).toContain("session A worker");
    if (surface === "table") fireEvent.keyDown(row, { key: "Enter" });
    else fireEvent.click(tile);
    await waitFor(() => {
      const request = fetchMock.mock.calls
        .map(([input]) => (typeof input === "string" ? input : ""))
        .find((url) => url.startsWith("/api/history?"));
      expect(request).toBeDefined();
      expect(
        new URL(request ?? "", "http://test").searchParams.get("session"),
      ).toBe("session-A");
    });
    expect(document.getElementById("history-title")?.textContent).toBe(
      "session A worker",
    );
  },
);

test("a finding action filters the thread table", async () => {
  history.replaceState(null, "", "/?target=host%2Fworker");
  const blocked: LiveResponse = {
    ...live,
    health: { ...live.health, session: "s" },
    threads: [
      {
        tid: 42,
        name: "blocked",
        state: "kernel",
        last_sample: 100,
        cpu_pct: 0,
      },
      {
        tid: 43,
        name: "running",
        state: "running",
        last_sample: 100,
        cpu_pct: 10,
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          Response.json(
            (typeof input === "string" ? input : "").startsWith("/api/targets")
              ? targets
              : blocked,
          ),
        ),
      ),
  );
  render(<App />);
  const finding = await screen.findByText(/in uninterruptible/);
  const action = finding.closest<HTMLElement>("[data-action]");
  if (!action) throw new Error("Missing finding action");
  fireEvent.click(action);
  expect(
    [...document.querySelectorAll("#threads tr[data-tid]")].map((row) =>
      row.getAttribute("data-tid"),
    ),
  ).toEqual(["42"]);
});

// The Resources section: its own history poll, and the Summary findings use
// the same history and pressure scope.
const resourceLive = (extra: Partial<LiveResponse> = {}): LiveResponse => ({
  ...live,
  health: { ...live.health, session: "s" },
  threads: [{ tid: 42, name: "worker", last_sample: 100, cpu_pct: 1 }],
  resources: {
    available: true,
    session: "s",
    pid: 42,
    updated: 100,
    network: { tcp_timeouts: { delta: 0, per_s: 0, total: 4 } },
  },
  ...extra,
});
const span = (url: string) => {
  const query = new URL(url, "http://test").searchParams;
  return Number(query.get("end")) - Number(query.get("start"));
};
const timeouts = (delta: number) =>
  Response.json({
    rows: [{ ts: 1, pid: 42, elapsed_s: 1, tcp_timeouts_delta: delta }],
    bucket_s: 1,
    truncated: false,
    read_error: false,
  });

// Old test 558: range clicks refresh at once, but only one loop polls.
test("resource range changes keep one polling loop, with overlapping requests and failures", async () => {
  vi.useFakeTimers();
  try {
    history.replaceState(null, "", "/?target=host%2Fworker");
    const calls: {
      url: string;
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
    }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation((input) => {
        const url = typeof input === "string" ? input : "";
        if (url.startsWith("/api/targets"))
          return Promise.resolve(Response.json(targets));
        if (url.startsWith("/api/resources"))
          return new Promise((resolve, reject) => {
            calls.push({ url, resolve, reject });
          });
        return Promise.resolve(Response.json(resourceLive()));
      }),
    );
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(calls.map((call) => span(call.url))).toEqual([900]);
    expect(calls[0]?.url).toContain("target=host%2Fworker");
    fireEvent.click(screen.getByRole("button", { name: "1 h" }));
    fireEvent.click(screen.getByRole("button", { name: "6 h" }));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(calls.map((call) => span(call.url))).toEqual([900, 3600, 21600]);
    // The answers arrive in reverse order; only the 6 h answer is shown.
    await act(async () => {
      calls[2]?.resolve(timeouts(7));
      calls[1]?.resolve(timeouts(99));
      calls[0]?.resolve(timeouts(55));
      await vi.advanceTimersByTimeAsync(10);
    });
    const inRange = () =>
      document.querySelector('#netstack tr[data-counter="tcp_timeouts"]')
        ?.children[2]?.textContent;
    expect(inRange()).toBe("7");
    await act(() => vi.advanceTimersByTimeAsync(4900));
    expect(calls).toHaveLength(3);
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(calls.map((call) => span(call.url))).toEqual([
      900, 3600, 21600, 21600,
    ]);
    // A failed poll keeps the last good history and the single loop.
    await act(async () => {
      calls[3]?.reject(new Error("Collector unavailable"));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(inRange()).toBe("7");
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(calls).toHaveLength(5);
  } finally {
    vi.useRealTimers();
  }
});

test("the Summary findings use the Resources history and pressure scope", async () => {
  history.replaceState(null, "", "/?target=host%2Fworker");
  const now = Date.now() / 1000;
  const view = resourceLive({
    threads: [
      {
        tid: 42,
        name: "worker",
        last_sample: 100,
        cpu_pct: 1,
        major_faults_per_s: 20,
      },
    ],
    memory: { available: true, pid: 42 },
    resources: {
      available: true,
      session: "s",
      pid: 42,
      updated: now,
      pressure: {
        cgroup: { memory: { some: { pct: 0 } } },
        host: { memory: { some: { pct: 10 } } },
      },
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = typeof input === "string" ? input : "";
      if (url.startsWith("/api/targets"))
        return Promise.resolve(Response.json(targets));
      if (url.startsWith("/api/resources"))
        return Promise.resolve(
          Response.json({
            rows: Array.from({ length: 7 }, (_, index) => ({
              ts: now - 60 + index * 10,
              pid: 42,
              elapsed_s: 10,
              rss_bytes: (100 + index * 4) * 2 ** 20,
            })),
            bucket_s: 10,
            truncated: false,
            read_error: false,
          }),
        );
      return Promise.resolve(Response.json(view));
    }),
  );
  render(<App />);
  // The Memory map section lists the same memory findings; this is the Summary.
  const summary = () =>
    within(document.getElementById("overview") as HTMLElement);
  expect(
    await summary().findByText("Resident memory grows without a plateau"),
  ).toBeDefined();
  // The cgroup has no memory pressure; the host has 10%.
  expect(
    summary().queryByText(
      "Major page faults and memory pressure rise together",
    ),
  ).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "Pressure scope" }), {
    target: { value: "host" },
  });
  expect(
    summary().getByText("Major page faults and memory pressure rise together"),
  ).toBeDefined();
});

test("selecting the Settings tab reads the watch rules again", async () => {
  history.replaceState(null, "", "/?target=host%2Fworker");
  const rules = {
    rules: [{ prefix: "worker", wake_ms: 500 }],
    source: "config",
    saved_error: null,
    revision: "r1",
    limits: {
      prefix_max_bytes: 15,
      wake_ms_min: 10,
      wake_ms_max: 3600000,
      max_rules: 64,
    },
  };
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = typeof input === "string" ? input : "";
    return Promise.resolve(
      Response.json(
        url.startsWith("/api/targets")
          ? targets
          : url.startsWith("/api/watches")
            ? rules
            : live,
      ),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<App />);
  await screen.findByRole("button", { name: "Save" });
  const reads = () =>
    fetchMock.mock.calls.filter(
      ([input]) => input === "/api/watches?target=host%2Fworker",
    ).length;
  await waitFor(() => {
    expect(reads(), "the editor and the assessment each read once").toBe(2);
  });
  fireEvent.click(screen.getByRole("link", { name: "Settings" }));
  await waitFor(() => {
    expect(reads()).toBe(3);
  });
  // The matching column counts the live threads of the target.
  expect(document.querySelector("#watch-rows .watch-count")?.textContent).toBe(
    "1",
  );
});

// Replaces test_monitor.py showAlerting: the separate alert program has no API.
test.each(["startup", "settings", "lost field"])(
  "alerts stay hidden with no alert requests: %s",
  async (mode) => {
    vi.useFakeTimers();
    try {
      history.replaceState(
        null,
        "",
        "/?target=host%2Fworker" + (mode === "settings" ? "#settings" : ""),
      );
      let hasAlerts = mode === "lost field";
      const urls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockImplementation((input) => {
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          urls.push(url);
          if (url.startsWith("/api/targets"))
            return Promise.resolve(Response.json(targets));
          if (url.startsWith("/api/watches"))
            return Promise.resolve(Response.json({}, { status: 404 }));
          return Promise.resolve(
            Response.json({
              ...live,
              ...(hasAlerts ? { alerts: [] } : {}),
            }),
          );
        }),
      );
      render(<App />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      const assertHidden = () => {
        expect(
          document.querySelector('[id*="alert"], [data-help="alerts"]'),
        ).toBeNull();
        expect(
          screen.queryByText(/Open alerts|Recent alerts|Alert settings/),
        ).toBeNull();
        expect(urls.some((url) => url.includes("/api/alert-settings"))).toBe(
          false,
        );
      };
      assertHidden();
      hasAlerts = false;
      await act(() => vi.advanceTimersByTimeAsync(1100));
      assertHidden();
    } finally {
      vi.useRealTimers();
    }
  },
);

// A navigation can end without an unload: a Ctrl-click, an unsaved Settings
// draft that the user keeps ("Stay"), or a page that returns from the
// back/forward cache. The page must stay live and keep its trends.
function stubLiveTarget() {
  history.replaceState(null, "", "/?target=host%2Fworker");
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockImplementation((input) =>
        Promise.resolve(
          Response.json(
            typeof input === "string" && input.startsWith("/api/targets")
              ? targets
              : { ...live, health: { ...live.health, session: "s1" } },
          ),
        ),
      ),
  );
}
async function renderLiveTarget() {
  stubLiveTarget();
  render(<App />);
  await waitFor(() => {
    expect(document.title).toContain(" · Thread monitor");
  });
}

test("a cancelled navigation to the overview leaves the page live and editable", async () => {
  await renderLiveTarget();
  const cancel = (event: Event) => {
    event.preventDefault();
  };
  document.addEventListener("click", cancel);
  fireEvent.click(document.getElementById("fleet-back") as HTMLElement);
  document.removeEventListener("click", cancel);
  expect(document.getElementById("watch-recorded-readonly")).toBeNull();
  sessionStorage.clear();
});

test("a cancelled target switch leaves the page live and keeps its caches", async () => {
  await renderLiveTarget();
  sessionStorage.setItem("triangulator:buffer:host/worker", "kept");
  const assign = vi.fn();
  vi.stubGlobal("location", {
    assign,
    hash: "",
    pathname: location.pathname,
    search: location.search,
  });
  const select = screen.getByRole("combobox", {
    name: "Selected monitoring target",
  });
  const option = document.createElement("option");
  option.value = "host-b/billing";
  select.append(option);
  fireEvent.change(select, { target: { value: "host-b/billing" } });
  expect(assign).toHaveBeenCalled();
  expect(document.getElementById("watch-recorded-readonly")).toBeNull();
  expect(sessionStorage.getItem("triangulator:buffer:host/worker")).toBe(
    "kept",
  );
  sessionStorage.clear();
});

test("leaving for the overview saves the trends this tab collected", async () => {
  await renderLiveTarget();
  const leave = (event: Event) => {
    event.preventDefault();
  };
  document.addEventListener("click", leave);
  fireEvent.click(document.getElementById("fleet-back") as HTMLElement);
  document.removeEventListener("click", leave);
  dispatchEvent(new Event("pagehide"));
  const saved = JSON.parse(
    sessionStorage.getItem("triangulator:buffer:host/worker") ?? "null",
  ) as { session: string } | null;
  expect(saved?.session).toBe("s1");
  sessionStorage.clear();
});
