import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { Help } from "./Help";

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

test("shows links only for ported topics and opens a related topic", () => {
  render(<Help topic="fleet">Targets</Help>);
  fireEvent.focus(screen.getByText("Targets"));
  expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Target tile",
    "Monitoring target",
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
