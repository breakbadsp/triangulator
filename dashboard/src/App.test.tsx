import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "./App";
import { helpTopics } from "./help/topics";
import type { LiveResponse, TargetsResponse } from "./api/types";

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
      await screen.findByText("worker");
      expect(screen.getByText("PID 42 · Live")).toBeDefined();
      expect(
        fetchMock.mock.calls.some(
          (call) => call[0] === "/api/live?target=host%2Fworker",
        ),
      ).toBe(true);
    } else {
      expect(screen.getByRole("heading", { name: "Targets" })).toBeDefined();
      expect(
        fetchMock.mock.calls.every((call) => call[0] === "/api/targets"),
      ).toBe(true);
    }
    expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
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
  await screen.findByText("worker");
  failed = true;
  await waitFor(
    () => {
      expect(screen.getByRole("status").textContent).toBe(
        "Collector unavailable",
      );
    },
    { timeout: 2500 },
  );
  expect(screen.getByText("worker")).toBeDefined();
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
