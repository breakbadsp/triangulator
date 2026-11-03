import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { App } from "../App";
import { readFileSync } from "node:fs";
import type { LiveResponse } from "../api/types";

const fleetCss = readFileSync("src/components/fleet.css", "utf8");

function fleetView(pid: number, name: string, cpu: number): LiveResponse {
  const now = Date.now() / 1000;
  return {
    health: {
      session: String(pid),
      pid,
      last_seen: now,
      sampler_silent: false,
      target_absent: false,
    },
    threads: [
      {
        tid: pid,
        generation: 1,
        name,
        last_sample: now,
        cpu_pct: cpu,
        run_delay_pct: 0,
        state: cpu >= 90 ? "running" : "sleep",
      },
    ],
  };
}
const fleetTargets = [
  {
    key: "h/api",
    host: "h",
    id: "api",
    pid: 10,
    status: "live",
    access: "full",
    throttled: false,
    process: null,
  },
  {
    key: "h/busy",
    host: "h",
    id: "busy",
    pid: 20,
    status: "live",
    access: "limited",
    throttled: true,
    process: null,
  },
  {
    key: "h/gone",
    host: "h",
    id: "gone",
    pid: 30,
    status: "silent",
    access: "full",
    throttled: false,
    process: null,
  },
] as const;
function fleetRespond(url: string): Response {
  if (url === "/api/targets") return Response.json({ targets: fleetTargets });
  if (url === "/api/live?target=h%2Fapi")
    return Response.json(fleetView(10, "api", 5));
  if (url === "/api/live?target=h%2Fbusy")
    return Response.json(fleetView(20, "busy", 99));
  if (url === "/api/live?target=h%2Fgone")
    return Response.json({}, { status: 503 });
  throw new Error("Unexpected request: " + url);
}
let respond: (url: string) => Response;
// Builds the one overview reply from the per-target replies of `respond`.
async function fleetReply() {
  const list = (await respond("/api/targets").json()) as {
    targets: readonly { key: string }[];
  };
  const live: Record<string, unknown> = {};
  for (const { key } of list.targets) {
    const reply = respond(
      "/api/live?" + new URLSearchParams({ target: key }).toString(),
    );
    if (reply.ok) live[key] = await reply.json();
  }
  return Response.json({ list, live });
}
let requests: string[];
let hidden: boolean;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T00:00:00Z"));
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  history.replaceState(null, "", "/");
  localStorage.clear();
  respond = fleetRespond;
  requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation((input) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requests.push(url);
      return url === "/api/fleet"
        ? fleetReply()
        : Promise.resolve(respond(url));
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
  localStorage.clear();
});
async function start(search = "") {
  history.replaceState(null, "", "/" + search);
  const app = render(<App />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  return app;
}
const poll = () => act(() => vi.advanceTimersByTimeAsync(5000));
function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error("Missing element: " + selector);
  return found;
}
const tiles = () =>
  Array.from(document.querySelectorAll<HTMLElement>("#fleet-grid > article"));
const link = (tile: HTMLElement) =>
  within(tile).getByRole("link", { hidden: true });
const tileFor = (key: string) =>
  element(`.ft-name[href^="?target=${encodeURIComponent(key)}"]`).closest(
    "article",
  ) as HTMLElement;
const shownTiles = () =>
  tiles()
    .filter((tile) => !tile.hidden)
    .map((tile) => tile.querySelector(".ft-key")?.textContent);
function filterFleet(text: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "Find target" }), {
    target: { value: text },
  });
}

// Ported from 777cf3a:tests/dashboard_test.js, phase 3 cases 3060–3404.
test("overview page shows one tile per target in API order, and links to each dashboard", async () => {
  await start();
  expect(document.documentElement.dataset.page).toBe("fleet");
  expect(document.getElementById("target-select")).toBeNull();
  expect(
    requests.some((url) =>
      /^\/api\/(live|replay|resources|watches)$|^\/api\/(replay|resources)\?/.test(
        url,
      ),
    ),
  ).toBe(false);
  expect(requests.filter((url) => url === "/api/fleet")).toHaveLength(1);
  expect(requests.some((url) => url.startsWith("/api/live"))).toBe(false);
  expect(tiles().map((tile) => link(tile).getAttribute("href"))).toEqual([
    "?target=h%2Fapi",
    "?target=h%2Fbusy",
    "?target=h%2Fgone",
  ]);
  expect(tiles().map((tile) => tile.dataset.level)).toEqual([
    "good",
    "serious",
    "unknown",
  ]);
  expect(tileFor("h/busy").textContent).toContain("busy is saturating a core");
  expect(
    within(tileFor("h/api")).getByRole("img").getAttribute("aria-label"),
  ).toBe("Assessment: Healthy");
  expect(tileFor("h/api").textContent).not.toContain("No problems detected");
  expect(
    within(tileFor("h/gone")).getByRole("img").getAttribute("aria-label"),
  ).toBe("Assessment: No data");
  expect(document.title).toBe("(1) Targets · Thread monitor");
  expect(document.querySelector("#fleet-empty")).toBeNull();
  const first = tiles()[0];
  await poll();
  expect(tiles()[0]).toBe(first);
  expect(requests.filter((url) => url === "/api/fleet")).toHaveLength(2);
});

test("overview preserves a non-alphabetical API order through polls and search", async () => {
  const targets = [fleetTargets[2], fleetTargets[0], fleetTargets[1]];
  let cpu = 99;
  respond = (url) =>
    url === "/api/targets"
      ? Response.json({ targets })
      : url === "/api/live?target=h%2Fbusy"
        ? Response.json(fleetView(20, "busy", cpu))
        : fleetRespond(url);
  await start();
  expect(shownTiles()).toEqual(["h · gone", "h · api", "h · busy"]);
  cpu = 5;
  await poll();
  expect(tileFor("h/busy").dataset.level).toBe("good");
  expect(shownTiles()).toEqual(["h · gone", "h · api", "h · busy"]);
  filterFleet("h/");
  expect(shownTiles()).toEqual(["h · gone", "h · api", "h · busy"]);
});

test("overview page polls nothing while the tab is hidden and reports a lost collector", async () => {
  await start();
  hidden = true;
  const before = requests.length;
  await poll();
  expect(requests).toHaveLength(before);
  hidden = false;
  respond = () => {
    throw new Error("down");
  };
  await poll();
  expect(element("#error").textContent).toBe(
    "⚠ Collector unavailable. Displayed data is stale.",
  );
  expect(tiles()).toHaveLength(3);
  respond = () => Response.json({ targets: [] });
  await poll();
  expect(document.querySelector("#error")).toBeNull();
  expect(tiles()).toHaveLength(0);
  expect(element("#fleet-empty").hidden).toBe(false);
  expect(element("#fleet-empty").textContent).toBe(
    "No targets yet. A target appears here when its sampler sends its first data to this collector.",
  );
  expect(document.title).toBe("Targets · Thread monitor");
});

test("overview tile faces show only identity and an accessible assessment dot", async () => {
  respond = (url) =>
    url === "/api/live?target=h%2Fapi"
      ? Response.json({
          ...fleetView(10, "api", 5),
          resources: {
            available: true,
            stale: false,
            session: "10",
            pid: 10,
            memory: { rss: 5 * 1048576 },
          },
        })
      : fleetRespond(url);
  await start();
  for (const [key, level, label] of [
    ["busy", "serious", "Something is struggling"],
    ["api", "good", "Healthy"],
    ["gone", "unknown", "No data"],
  ]) {
    const tile = tileFor("h/" + String(key));
    expect([
      tile.querySelector(".ft-top")?.textContent,
      tile.querySelector(".ft-key")?.textContent,
    ]).toEqual([key, "h · " + String(key)]);
    expect(tile.dataset.level).toBe(level);
    const dot = within(tile).getByRole("img");
    expect(dot.getAttribute("aria-label")).toBe("Assessment: " + String(label));
    expect(dot.title).toBe(label);
    expect(link(tile).getAttribute("aria-label")?.toLowerCase()).toContain(
      String(label).toLowerCase(),
    );
    expect(dot.className).toBe("status-dot ft-assessment");
  }
});

test("a target dashboard does not start the overview", async () => {
  await start("?target=h%2Fapi");
  expect(document.documentElement.dataset.page).toBe("target");
  expect(requests).toContain("/api/live?target=h%2Fapi");
  expect(document.querySelector("#fleet-grid")).toBeNull();
  expect(requests).not.toContain("/api/live?target=h%2Fbusy");
});

test("a tile with findings carries a card with the worst findings and the process start", async () => {
  respond = (url) => {
    if (url !== "/api/live?target=h%2Fbusy") return fleetRespond(url);
    return Response.json({
      ...fleetView(20, "busy", 99),
      process: {
        session: "20",
        started_at: Date.now() / 1000 - 7200,
        command: "/usr/bin/busy --spin",
      },
    });
  };
  await start();
  expect(tileFor("h/api").querySelector(".ft-card")).toBeNull();
  const card = tileFor("h/busy").querySelector(".ft-card");
  expect(card?.textContent).toContain(
    "PID 20 · Started 2 h ago · /usr/bin/busy --spin",
  );
  expect(card?.textContent).toContain("busy is saturating a core");
  expect(card?.textContent).toContain("uses 99");
  expect(card?.querySelector("li")?.className).toBe("lvl-serious");
});

test("a poll keeps the tile link element, so keyboard focus survives", async () => {
  await start();
  const tile = tileFor("h/busy");
  const before = link(tile);
  await poll();
  expect(link(tile)).toBe(before);
  expect(before.getAttribute("href")).toBe("?target=h%2Fbusy");
  expect(tile.querySelectorAll(".ft-key")).toHaveLength(1);
});

test("a tile link has the full process name as its title and keeps it current across polls", async () => {
  let name = "postgres-00-primary-replica-sha";
  respond = (url) =>
    url === "/api/live?target=h%2Fbusy"
      ? Response.json(fleetView(20, name, 99))
      : fleetRespond(url);
  await start();
  const tile = tileFor("h/busy");
  const before = link(tile);
  expect(before.title).toBe("postgres-00-primary-replica-sha");
  expect(before.getAttribute("aria-label")).toMatch(
    /^postgres-00-primary-replica-sha, h · busy: /,
  );
  name = "postgres-01-standby";
  await poll();
  expect(link(tile)).toBe(before);
  expect(before.title).toBe("postgres-01-standby");
  expect(before.getAttribute("aria-label")).toMatch(
    /^postgres-01-standby, h · busy: /,
  );
});

test("a tile that holds keyboard focus is not refilled until focus leaves it", async () => {
  let cpu = 99;
  respond = (url) =>
    url === "/api/live?target=h%2Fbusy"
      ? Response.json(fleetView(20, "busy", cpu))
      : fleetRespond(url);
  await start();
  const tile = tileFor("h/busy");
  const key = tile.querySelector(".ft-key");
  const before = link(tile);
  act(() => {
    before.focus();
  });
  cpu = 5;
  await poll();
  expect(tile.querySelector(".ft-key")).toBe(key);
  expect(link(tile)).toBe(before);
  expect(tile.dataset.level).toBe("serious");
  expect(tile.querySelector(".ft-card")?.textContent).toContain("uses 99");
  expect(tiles()[1]).toBe(tile);
  act(() => {
    before.blur();
  });
  await poll();
  expect(tile.dataset.level).toBe("good");
  expect(tile.querySelector(".ft-card")).toBeNull();
});

test("API order and keyboard focus survive assessment changes", async () => {
  let cpu = 5;
  respond = (url) =>
    url === "/api/live?target=h%2Fbusy"
      ? Response.json(fleetView(20, "busy", cpu))
      : fleetRespond(url);
  await start();
  const apiLink = link(tileFor("h/api"));
  act(() => {
    apiLink.focus();
  });
  expect(document.activeElement).toBe(apiLink);
  const original = tiles();
  expect(shownTiles()).toEqual(["h · api", "h · busy", "h · gone"]);
  cpu = 99;
  await poll();
  expect(
    link(element("#fleet-grid > article:first-child")).getAttribute("href"),
  ).toBe("?target=h%2Fapi");
  expect(tiles()).toEqual(original);
  expect(tileFor("h/busy").dataset.level).toBe("serious");
  expect(document.activeElement).toBe(apiLink);
});

test("a tile with only informational findings has no card", async () => {
  const info = fleetView(10, "api", 5);
  const view = {
    ...info,
    threads: [
      ...info.threads,
      {
        tid: 11,
        generation: 1,
        name: "side",
        last_sample: info.threads[0]?.last_sample,
        cpu_pct: 1,
        run_delay_pct: 0,
        state: "sleep",
      },
    ],
  };
  respond = (url) =>
    url === "/api/live?target=h%2Fapi"
      ? Response.json(view)
      : fleetRespond(url);
  await start();
  const api = tileFor("h/api");
  expect(within(api).getByRole("img").getAttribute("aria-label")).toBe(
    "Assessment: Healthy",
  );
  expect(api.textContent).not.toContain("No problems detected");
  expect(api.querySelector(".ft-card")).toBeNull();
});

test.each(["comfortable", "compact", "bogus", "blocked storage"])(
  "compact is the only layout with legacy choice %s",
  async (choice) => {
    if (choice === "blocked storage")
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("blocked");
      });
    else localStorage.setItem("triangulator:fleet-density", choice);
    const style = document.createElement("style");
    style.textContent = fleetCss;
    document.head.append(style);
    try {
      await start(`?status=critical&layout=${choice}&density=${choice}`);
      expect(
        screen.queryByRole("combobox", { name: "Assessment status" }),
      ).toBeNull();
      expect(
        screen.queryByRole("combobox", { name: "Tile density" }),
      ).toBeNull();
      expect(shownTiles()).toEqual(["h · api", "h · busy", "h · gone"]);
      expect(getComputedStyle(element("#fleet-grid > article")).minHeight).toBe(
        "104px",
      );
      expect(getComputedStyle(element("#fleet-grid")).gap).toBe("16px");
      await poll();
      expect(getComputedStyle(element("#fleet-grid > article")).minHeight).toBe(
        "104px",
      );
    } finally {
      style.remove();
    }
  },
);

test("search shows matching tiles with no request while the counts keep every target", async () => {
  await start();
  const before = requests.length;
  const original = tiles();
  expect(element("#fleet-shown").textContent).toBe("Showing 3 of 3 targets");
  expect(document.querySelector("#fleet-clear")).toBeNull();
  filterFleet("API");
  expect(shownTiles()).toEqual(["h · api"]);
  expect(element("#fleet-shown").textContent).toBe("Showing 1 of 3 targets");
  filterFleet("h/");
  expect(shownTiles()).toEqual(["h · api", "h · busy", "h · gone"]);
  expect(requests).toHaveLength(before);
  filterFleet("missing");
  expect(shownTiles()).toEqual([]);
  expect(element("#fleet-none")).toBeDefined();
  expect(element("#fleet-clear")).toBeDefined();
  expect(element("#fleet-none").textContent).toBe(
    "No targets match this search. Clear filters shows every target.",
  );
  expect(element("#fleet-counts").textContent).toMatch(
    /Totals for all targets.*1.*Serious.*1.*Healthy.*1.*No data/,
  );
  filterFleet("busy");
  await poll();
  expect(shownTiles()).toEqual(["h · busy"]);
  tiles().forEach((tile, index) => {
    expect(tile).toBe(original[index]);
  });
  fireEvent.click(element("#fleet-clear"));
  expect(shownTiles()).toEqual(["h · api", "h · busy", "h · gone"]);
  expect(document.querySelector("#fleet-none")).toBeNull();
  expect(document.querySelector("#fleet-clear")).toBeNull();
  expect(document.activeElement).toBe(element("#fleet-search"));
});

test("search survives reload and navigation while legacy status is dropped from links", async () => {
  let app = await start("?q=bus&status=attention&layout=comfortable");
  expect(
    screen.getByRole<HTMLInputElement>("searchbox", { name: "Find target" })
      .value,
  ).toBe("bus");
  expect(shownTiles()).toEqual(["h · busy"]);
  const href = link(tileFor("h/busy")).getAttribute("href");
  expect(href).toBe("?target=h%2Fbusy&q=bus");
  app.unmount();
  app = await start(href ?? "");
  const back = screen
    .getByRole("link", { name: "← All targets" })
    .getAttribute("href");
  expect(back).toBe("./?q=bus");
  app.unmount();
  app = await start(back?.slice(2));
  expect(shownTiles()).toEqual(["h · busy"]);
  filterFleet("a b");
  expect(location.search).toBe("?q=a+b");
  filterFleet("");
  expect(location.search).toBe("");
  app.unmount();
  app = await start("?target=h%2Fapi&status=critical&layout=comfortable");
  expect(
    screen.getByRole("link", { name: "← All targets" }).getAttribute("href"),
  ).toBe("./");
  app.unmount();
  await start("?target=h%2Fbusy&q=a+b&status=serious");
  expect(
    screen.getByRole("link", { name: "← All targets" }).getAttribute("href"),
  ).toBe("./?q=a+b");
});

test("released target stays searchable and opens its final dashboard", async () => {
  respond = (url) =>
    url === "/api/targets"
      ? Response.json({
          targets: [
            {
              ...fleetTargets[0],
              archived: true,
              session: "10",
              local: false,
              excluded: 255,
            },
          ],
          max_targets: 1,
          capacity_drops: 1,
        })
      : fleetRespond(url);
  await start("?q=api");
  expect(screen.getByText("No longer monitored · Final data")).toBeDefined();
  expect(screen.queryByText(/matching processes on h/)).toBeNull();
  expect(screen.queryByText(/collector is at its limit/)).toBeNull();
  expect(link(tileFor("h/api")).getAttribute("href")).toBe(
    "?target=h%2Fapi&q=api",
  );
  expect(link(tileFor("h/api")).getAttribute("aria-label")).toContain(
    "No longer monitored",
  );
  expect(screen.queryByRole("button", { name: /Remove target/ })).toBeNull();
});

test("remove retained target works without sampler control and updates the overview", async () => {
  let removed = false;
  respond = (url) => {
    if (url === "/api/targets")
      return Response.json({
        targets: removed
          ? []
          : [
              {
                ...fleetTargets[0],
                archived: true,
                session: "10",
                local: false,
              },
            ],
      });
    if (url === "/api/targets/retained/remove") {
      removed = true;
      return Response.json({ message: "Removed" });
    }
    return fleetRespond(url);
  };
  await start();
  await act(() =>
    fireEvent.click(
      screen.getByRole("button", { name: "Remove retained target api" }),
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(tiles()).toHaveLength(0);
  expect(requests).toContain("/api/targets/retained/remove");
});

test("failed retained removal keeps the tile and explains the failure", async () => {
  respond = (url) => {
    if (url === "/api/targets")
      return Response.json({
        targets: [
          { ...fleetTargets[0], archived: true, session: "10", local: false },
        ],
      });
    if (url === "/api/targets/retained/remove")
      return Response.json(
        { error: "Target changed. Refresh Targets." },
        { status: 409 },
      );
    return fleetRespond(url);
  };
  await start();
  await act(() =>
    fireEvent.click(
      screen.getByRole("button", { name: "Remove retained target api" }),
    ),
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "Target changed. Refresh Targets.",
  );
  expect(tiles()).toHaveLength(1);
  expect(
    screen
      .getByRole("button", { name: "Remove retained target api" })
      .hasAttribute("disabled"),
  ).toBe(false);
});
