import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useState } from "react";
import { Help, HelpPortalTarget } from "./Help";
import { HelpGuideProvider, PageHelp } from "./HelpGuide";
import { ViewIdentityContext } from "../hooks/viewIdentityContext";
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
    <ViewIdentityContext value={{ key: scope, recorded: false }}>
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
    </ViewIdentityContext>
  );
}
function explain(label = "CPU source") {
  const source = screen.getByText(label).closest<HTMLElement>("[data-help]");
  if (!source) throw Error("Missing source");
  const opener = within(source).getByRole("button", { name: /^Explain / });
  fireEvent.click(opener);
  const guide = document.getElementById("help-guide");
  if (!guide) throw Error("Missing guide");
  return { opener, guide };
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
  localStorage.clear();
});

test("narrow guide traps focus, navigates topics, resizes, and restores the opener", () => {
  render(<Fixture />);
  const { opener, guide } = explain();
  expect(guide.getAttribute("role")).toBe("dialog");
  expect(document.querySelector("main")?.inert).toBe(true);
  expect(document.activeElement?.id).toBe("help-guide-title");
  fireEvent.keyDown(document.activeElement ?? document, {
    key: "Tab",
    shiftKey: true,
  });
  expect(document.activeElement?.textContent).toBe("All topics");
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
  expect(document.activeElement).toBe(opener);
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
  const { opener, guide } = explain("worker");
  expect(drawer.hidden).toBe(true);
  fireEvent.click(within(guide).getByRole("button", { name: "All topics" }));
  fireEvent.click(
    within(guide).getByRole("button", { name: "Back to thread" }),
  );
  expect(document.getElementById("drawer")).toBe(drawer);
  expect(drawer.hidden).toBe(false);
  expect(from.value).toBe(custom);
  expect(body.scrollTop).toBe(87);
  expect(document.activeElement).toBe(opener);
});

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
});
