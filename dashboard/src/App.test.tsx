import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      expect(screen.getByRole("status").textContent).toBe(
        "⚠ Collector unavailable. Displayed data is stale.",
      );
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
