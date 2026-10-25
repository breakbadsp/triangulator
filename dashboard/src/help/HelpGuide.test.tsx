import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { Help, HelpPortalTarget, setHoverHelp } from "./Help";
import { HelpGuideProvider, PageHelp } from "./HelpGuide";
import { ObservationContext } from "../hooks/observationContext";
import { TimeChart } from "../components/TimeChart";
import { ThreadDrawer } from "../components/ThreadDrawer";
import { emptySeries } from "../lib/series";
import type { LiveResponse } from "../api/types";
const points = [
  { t: 10, value: 1 },
  { t: 20, value: null },
  { t: 30, value: 3 },
];
function NativeSource() {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  return (
    <main>
      <dialog open ref={setDialog} aria-label="Add target">
        <HelpPortalTarget value={dialog}>
          <Help topic="manage-targets">Native source</Help>
        </HelpPortalTarget>
      </dialog>
    </main>
  );
}
function Fixture({
  scope = "s",
  shown = true,
  samples = points,
  native = false,
  thread = false,
}) {
  const view: LiveResponse = {
    health: {
      session: scope,
      pid: 7,
      last_seen: 30,
      target_absent: false,
      sampler_silent: false,
    },
    threads: [{ tid: 7, name: "worker", generation: 1, state: "running" }],
  };
  return (
    <ObservationContext value={{ key: scope, recorded: false }}>
      <HelpGuideProvider>
        <header className="topbar">
          <button>Outside</button>
        </header>
        {native ? (
          <NativeSource />
        ) : (
          <main>
            <div className="card">
              {shown && (
                <Help topic="cpu">
                  <h3>CPU source</h3>
                </Help>
              )}
              <TimeChart
                id="guide-chart"
                topic="cpu"
                points={samples}
                series={[
                  { label: "CPU sample", color: "blue", get: (p) => p.value },
                ]}
              />
            </div>
            <PageHelp />
          </main>
        )}
        {thread && (
          <ThreadDrawer
            view={view}
            context={scope}
            series={emptySeries}
            selected={{ session: scope, tid: 7, generation: 1, name: "worker" }}
            now={30}
            onClose={() => undefined}
          />
        )}
      </HelpGuideProvider>
    </ObservationContext>
  );
}
function explain(label = "CPU source") {
  const source = screen.getByText(label).closest<HTMLElement>("[data-help]");
  if (!source) throw Error("Missing source");
  act(() => {
    source.focus();
  });
  const card = document.getElementById(
    source.getAttribute("aria-describedby") ?? "",
  );
  if (!card) throw Error("Missing source card");
  fireEvent.click(
    within(card).getByRole("button", { name: "Open metric guide" }),
  );
  const guide = document.getElementById("help-guide");
  if (!guide) throw Error("Missing guide");
  return { source, guide };
}
beforeEach(() => {
  vi.stubGlobal("innerWidth", 390);
  vi.useFakeTimers();
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ rows: [], truncated: false })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setHoverHelp(true);
  localStorage.clear();
});

test("narrow guide traps focus, navigates topics, resizes, and restores the opener", () => {
  render(<Fixture />);
  const { source, guide } = explain();
  expect(guide.getAttribute("role")).toBe("dialog");
  expect(document.querySelector("main")?.inert).toBe(true);
  expect(document.activeElement?.id).toBe("help-guide-title");
  fireEvent.keyDown(document.activeElement ?? document, {
    key: "Tab",
    shiftKey: true,
  });
  expect(document.activeElement?.id).toBe("hover-help");
  fireEvent.keyDown(document.activeElement ?? document, { key: "Tab" });
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Close metric guide",
  );
  fireEvent.click(within(guide).getByRole("button", { name: "All topics" }));
  expect(within(guide).getByRole("heading", { level: 2 }).textContent).toBe(
    "How to read this page",
  );
  expect(guide.querySelectorAll(".help-topics button").length).toBeGreaterThan(
    140,
  );
  fireEvent.click(
    within(guide).getByRole("button", { name: "Limited access" }),
  );
  expect(guide.textContent).toContain(
    "The sampler cannot read all process files.",
  );
  vi.stubGlobal("innerWidth", 1200);
  fireEvent.resize(window);
  expect(guide.getAttribute("role")).toBe("complementary");
  expect(document.querySelector("main")?.inert).toBe(false);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(document.getElementById("help-guide")).toBeNull();
  expect(document.activeElement).toBe(source);
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("the native Add target guide leaves its dialog ancestor usable", () => {
  render(<Fixture native />);
  const { guide } = explain("Native source");
  expect(guide.closest("dialog")?.getAttribute("aria-label")).toBe(
    "Add target",
  );
  expect(document.querySelector("main")?.inert).not.toBe(true);
  expect(document.querySelector("header")?.inert).toBe(true);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(document.querySelector("dialog")?.open).toBe(true);
});

test("guide data and its chart stay frozen until close, including unavailable cells", () => {
  const { rerender } = render(<Fixture />);
  const { guide } = explain();
  fireEvent.click(within(guide).getByText("View chart data"));
  expect(
    within(guide).getByRole("cell", { name: "Not available" }),
  ).toBeDefined();
  const before = document.getElementById("guide-chart")?.innerHTML;
  rerender(<Fixture samples={points.map((p) => ({ ...p, value: 99 }))} />);
  expect(document.getElementById("guide-chart")?.innerHTML).toBe(before);
  expect(within(guide).getByRole("cell", { name: "1.0" })).toBeDefined();
  fireEvent.click(
    within(guide).getByRole("button", { name: "Close metric guide" }),
  );
  expect(document.getElementById("guide-chart")?.innerHTML).not.toBe(before);
});

test("a context change dismisses a guide and an unmounted opener uses the page fallback", () => {
  const { rerender } = render(<Fixture />);
  explain();
  rerender(<Fixture scope="replacement" />);
  expect(document.getElementById("help-guide")).toBeNull();
  explain();
  rerender(<Fixture scope="replacement" shown={false} />);
  expect(document.getElementById("help-guide")).toBeNull();
  expect(document.activeElement?.id).toBe("page-help");
});

test("Back to thread preserves the mounted drawer, inputs, scroll and opener", () => {
  render(<Fixture thread />);
  const drawer = document.getElementById("drawer");
  const body = drawer?.querySelector(".drawer-body");
  const from = document.getElementById("from");
  if (
    !(drawer instanceof HTMLElement) ||
    !(body instanceof HTMLElement) ||
    !(from instanceof HTMLInputElement)
  )
    throw Error("Missing thread history");
  fireEvent.change(from, { target: { value: "2026-10-20T12:34:00" } });
  const custom = from.value;
  body.scrollTop = 87;
  const { source, guide } = explain("worker");
  expect(drawer.hidden).toBe(true);
  fireEvent.click(within(guide).getByRole("button", { name: "All topics" }));
  fireEvent.click(
    within(guide).getByRole("button", { name: "Back to thread" }),
  );
  expect(document.getElementById("drawer")).toBe(drawer);
  expect(drawer.hidden).toBe(false);
  expect(from.value).toBe(custom);
  expect(body.scrollTop).toBe(87);
  expect(document.activeElement).toBe(source);
});

test("hover preference survives blocked storage and leaves keyboard help available", () => {
  render(<Fixture />);
  const { source, guide } = explain();
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("blocked");
  });
  fireEvent.click(
    within(guide).getByRole("checkbox", { name: "Show help on hover" }),
  );
  fireEvent.click(
    within(guide).getByRole("button", { name: "Close metric guide" }),
  );
  fireEvent.blur(source);
  fireEvent.mouseEnter(source);
  act(() => {
    vi.advanceTimersByTime(1500);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.focus(source);
  expect(screen.getByRole("dialog")).toBeDefined();
});

test("a related explanation cannot label the original chart as another metric", () => {
  render(<Fixture />);
  const source = screen
    .getByText("CPU source")
    .closest<HTMLElement>("[data-help]");
  if (!source) throw Error("Missing source");
  act(() => {
    source.focus();
  });
  const card = document.getElementById(
    source.getAttribute("aria-describedby") ?? "",
  );
  if (!card) throw Error("Missing card");
  fireEvent.click(within(card).getAllByRole("link")[0] ?? document.body);
  fireEvent.click(
    within(card).getByRole("button", { name: "Open metric guide" }),
  );
  const guide = document.getElementById("help-guide");
  if (!guide) throw Error("Missing guide");
  expect(within(guide).queryByText("View chart data")).toBeNull();
});

test.each([null, "on", "off"])(
  "hover choice survives a failed write with saved %s and successful reads",
  (saved) => {
    if (saved !== null) localStorage.setItem("triangulator:hover-help", saved);
    const enabled = saved === "off";
    render(<Fixture />);
    const { source, guide } = explain();
    const reads = vi.spyOn(Storage.prototype, "getItem");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw Error("quota");
    });
    fireEvent.click(
      within(guide).getByRole("checkbox", { name: "Show help on hover" }),
    );
    expect(localStorage.getItem("triangulator:hover-help")).toBe(saved);
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => {
      source.blur();
    });
    fireEvent.mouseEnter(source);
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(!!screen.queryByRole("dialog")).toBe(enabled);
    expect(reads).toHaveReturnedWith(saved);
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseLeave(source);
    act(() => {
      source.focus();
    });
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.keyDown(document, { key: "Escape" });
    act(() => {
      source.blur();
    });
    fireEvent.click(source);
    expect(screen.getByRole("dialog")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Open metric guide" }));
    const checkbox = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Show help on hover",
    });
    expect(checkbox.checked).toBe(enabled);
  },
);

test("a heading with two charts of the same topic omits ambiguous chart data", () => {
  render(
    <HelpGuideProvider>
      <main>
        <div className="card">
          <Help topic="cpu">CPU source</Help>
          {["first", "second"].map((id) => (
            <TimeChart
              key={id}
              id={id}
              topic="cpu"
              points={points}
              series={[{ label: id, color: "blue", get: (p) => p.value }]}
            />
          ))}
        </div>
      </main>
    </HelpGuideProvider>,
  );
  const { guide } = explain();
  expect(within(guide).queryByText("View chart data")).toBeNull();
  fireEvent.keyDown(document, { key: "Escape" });
  const opener = document
    .getElementById("second")
    ?.closest<HTMLElement>("[data-help]");
  if (!opener) throw Error("Missing chart source");
  act(() => {
    opener.focus();
  });
  fireEvent.click(screen.getByRole("button", { name: "Open metric guide" }));
  const direct = document.getElementById("help-guide");
  if (!direct) throw Error("Missing direct chart guide");
  fireEvent.click(within(direct).getByText("View chart data"));
  expect(
    within(direct).getByRole("columnheader", { name: "second" }),
  ).toBeDefined();
});

test("a successful preference write replaces a failed-write choice", () => {
  render(<Fixture />);
  const { source, guide } = explain();
  const write = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation(() => {
      throw Error("quota");
    });
  fireEvent.click(
    within(guide).getByRole("checkbox", { name: "Show help on hover" }),
  );
  write.mockRestore();
  fireEvent.click(
    within(guide).getByRole("checkbox", { name: "Show help on hover" }),
  );
  expect(localStorage.getItem("triangulator:hover-help")).toBe("on");
  fireEvent.keyDown(document, { key: "Escape" });
  act(() => {
    source.blur();
  });
  fireEvent.mouseEnter(source);
  act(() => {
    vi.advanceTimersByTime(1500);
  });
  expect(screen.getByRole("dialog")).toBeDefined();
  fireEvent.keyDown(document, { key: "Escape" });
  localStorage.setItem("triangulator:hover-help", "off");
  fireEvent.mouseLeave(source);
  fireEvent.mouseEnter(source);
  act(() => {
    vi.advanceTimersByTime(1500);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});
