import { HELP_DELAY } from "./createHelpTimer";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Help } from "./Help";
import { HelpGuideProvider } from "./HelpGuide";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("innerWidth", 1400);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("a label opens help only from its info button, beside the dashboard", () => {
  render(
    <HelpGuideProvider>
      <main>
        <Help topic="appearance">Theme</Help>
      </main>
    </HelpGuideProvider>,
  );
  const label = screen.getByText("Theme");
  fireEvent.mouseEnter(label);
  fireEvent.focus(label);
  fireEvent.click(label);
  act(() => {
    vi.advanceTimersByTime(HELP_DELAY);
  });
  expect(document.getElementById("help-guide")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Explain Color theme" }));
  expect(
    screen.getByRole("complementary", { name: "Color theme" }),
  ).toBeDefined();
  expect(document.body.classList.contains("help-open")).toBe(true);
});

test("the info button in a summary does not toggle its disclosure", () => {
  render(
    <HelpGuideProvider>
      <details>
        <summary>
          <Help topic="appearance">Theme</Help>
        </summary>
      </details>
    </HelpGuideProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Explain Color theme" }));
  expect(document.querySelector("details")?.open).toBe(false);
  expect(document.getElementById("help-guide")).not.toBeNull();
});

test("a chart readout still opens its card after the delay", () => {
  render(
    <HelpGuideProvider>
      <Help
        topic="cpu"
        as="div"
        readout={{
          key: "1",
          title: "Sample",
          rows: [{ color: "blue", value: "42%", label: "CPU" }],
          stamp: 0,
          point: { x: 10, y: 10 },
        }}
      >
        Chart
      </Help>
    </HelpGuideProvider>,
  );
  expect(screen.queryByRole("button", { name: /^Explain / })).toBeNull();
  act(() => {
    vi.advanceTimersByTime(HELP_DELAY);
  });
  expect(screen.getByRole("dialog").textContent).toContain("42%");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
