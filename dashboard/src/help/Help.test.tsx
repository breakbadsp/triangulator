import { ObservationContext } from "../hooks/observationContext";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Help, HelpEnabled, HelpPortalTarget } from "./Help";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

test("opens after 1200 ms, permits entry into the card, and closes on Escape", () => {
  render(<Help topic="appearance">Theme</Help>);
  fireEvent.mouseEnter(screen.getByText("Theme"));
  act(() => {
    vi.advanceTimersByTime(1199);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  const card = screen.getByRole("dialog", { name: "Color theme" });
  fireEvent.mouseLeave(screen.getByText("Theme"));
  fireEvent.mouseEnter(card);
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByRole("dialog")).toBe(card);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("disables hover through the existing storage key but permits focus and tap", () => {
  localStorage.setItem("triangulator:hover-help", "off");
  render(<Help topic="appearance">Theme</Help>);
  const anchor = screen.getByText("Theme");
  fireEvent.mouseEnter(anchor);
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.focus(anchor);
  expect(screen.getByRole("dialog")).toBeDefined();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.click(anchor);
  expect(screen.getByRole("dialog")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Close help" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("Escape dismisses all visible cards and a later pending hover", () => {
  render(
    <>
      <Help topic="appearance">Theme</Help>
      <Help topic="fleet">Targets</Help>
      <Help topic="assessment">Assessment</Help>
    </>,
  );
  act(() => {
    screen.getByText("Theme").focus();
  });
  act(() => {
    screen.getByText("Targets").focus();
  });
  expect(screen.getAllByRole("dialog")).toHaveLength(2);
  const pendingHelp = document.querySelector("[data-help='assessment']");
  if (!pendingHelp) throw new Error("Missing assessment help");
  fireEvent.mouseEnter(pendingHelp);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("opens a related topic through its explicit ID", () => {
  render(<Help topic="fleet">Targets</Help>);
  fireEvent.focus(screen.getByText("Targets"));
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Target tile",
    "Monitoring target",
    "Assessment",
  ]);
  fireEvent.click(screen.getByRole("link", { name: "Monitoring target" }));
  expect(
    screen.getByRole("dialog", { name: "Monitoring target" }),
  ).toBeDefined();
});

test("does not open a pending card after unmount", () => {
  const { unmount } = render(<Help topic="appearance">Theme</Help>);
  fireEvent.mouseEnter(screen.getByText("Theme"));
  unmount();
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("a hidden drawer dismisses help without remounting its content", () => {
  const show = (active: boolean) => (
    <HelpEnabled value={active}>
      <Help topic="thread">
        <input aria-label="Kept input" defaultValue="custom range" />
      </Help>
    </HelpEnabled>
  );
  const { rerender } = render(show(true));
  const input = screen.getByLabelText<HTMLInputElement>("Kept input");
  fireEvent.focus(input);
  expect(screen.getByRole("dialog")).toBeDefined();
  rerender(show(false));
  expect(screen.queryByRole("dialog")).toBeNull();
  rerender(show(true));
  act(() => {
    vi.advanceTimersByTime(1200);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByLabelText("Kept input")).toBe(input);
  expect(input.value).toBe("custom range");
});

test("a modal portal keeps interactive help inside its dialog and falls back to body", () => {
  const dialog = document.createElement("dialog");
  dialog.open = true;
  document.body.append(dialog);
  const app = render(
    <HelpPortalTarget value={dialog}>
      <Help topic="appearance">Theme</Help>
    </HelpPortalTarget>,
  );
  fireEvent.focus(screen.getByText("Theme"));
  expect(
    dialog.contains(screen.getByRole("dialog", { name: "Color theme" })),
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Close help" }));
  expect(screen.queryByRole("dialog", { name: "Color theme" })).toBeNull();
  app.rerender(
    <HelpPortalTarget value={null}>
      <Help topic="appearance">Theme</Help>
    </HelpPortalTarget>,
  );
  fireEvent.click(screen.getByText("Theme"));
  expect(
    screen.getByRole("dialog", { name: "Color theme" }).parentElement,
  ).toBe(document.body);
  app.unmount();
  dialog.remove();
});

test("pointer focus leaves the click target in place, while keyboard focus still opens help", () => {
  const action = vi.fn();
  render(
    <Help topic="manage-targets">
      <button onClick={action}>Add target</button>
    </Help>,
  );
  const button = screen.getByRole("button", { name: "Add target" });
  fireEvent.pointerDown(button);
  fireEvent.focus(button);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.pointerUp(button);
  fireEvent.click(button);
  expect(action).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog", { name: "Manage targets" })).toBeDefined();
  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.blur(button);
  fireEvent.focus(button);
  expect(screen.getByRole("dialog", { name: "Manage targets" })).toBeDefined();
});

test("an observation change clears visible and pending Help without replacing focused controls", () => {
  function Page({ identity }: { identity: string }) {
    return (
      <ObservationContext
        value={{ key: identity, recorded: identity === "recorded" }}
      >
        <Help topic="overview" as="div">
          <h2>Summary heading</h2>
        </Help>
        <Help topic="map">
          <input aria-label="Kept control" defaultValue="draft" />
        </Help>
      </ObservationContext>
    );
  }
  const view = render(<Page identity="live" />);
  const input = screen.getByRole("textbox", { name: "Kept control" });
  act(() => {
    input.focus();
  });
  expect(screen.getByRole("dialog")).toBeDefined();
  view.rerender(<Page identity="recorded" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(input);
  expect(screen.getByRole("textbox", { name: "Kept control" })).toBe(input);
  fireEvent.mouseEnter(screen.getByText("Summary heading"));
  view.rerender(<Page identity="new-session" />);
  act(() => {
    vi.advanceTimersByTime(1500);
  });
  expect(screen.queryByRole("dialog")).toBeNull();
});
