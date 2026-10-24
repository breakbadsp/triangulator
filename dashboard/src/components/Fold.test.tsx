import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { wantsFold, type Finding } from "../lib/findings";
import { Fold } from "./Fold";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});
const finding = (type: Finding["type"], level: Finding["level"]): Finding => ({
  type,
  level,
  title: "",
  detail: "",
});
function panel(
  name: string,
  findings: readonly Finding[],
  type: Finding["type"],
) {
  return (
    <Fold
      name={name}
      summary={<h3>{name}</h3>}
      autoOpen={wantsFold(findings, type)}
    >
      <p>{name} body</p>
    </Fold>
  );
}
const isOpen = (name: string) =>
  (screen.getByText(name).closest("details") as HTMLDetailsElement).open;

test("folded panels open for a warning of their type until the user chooses", () => {
  // Info is not enough; a warning of the panel's type opens it.
  const findings = [finding("monitor", "info"), finding("memory", "warning")];
  render(
    <>
      {panel("health-a", findings, "monitor")}
      {panel("memory-a", findings, "memory")}
    </>,
  );
  expect([isOpen("health-a"), isOpen("memory-a")]).toEqual([false, true]);
  // A panel the user closed stays closed.
  localStorage.setItem("triangulator:fold:health-b", "closed");
  render(panel("health-b", [finding("monitor", "critical")], "monitor"));
  expect(isOpen("health-b")).toBe(false);
});

test("folded panels restore a saved choice and save a click", () => {
  localStorage.setItem("triangulator:fold:health-c", "closed");
  localStorage.setItem("triangulator:fold:memory-c", "open");
  render(
    <>
      {panel("health-c", [], "monitor")}
      {panel("memory-c", [], "memory")}
    </>,
  );
  expect([isOpen("health-c"), isOpen("memory-c")]).toEqual([false, true]);
  fireEvent.click(screen.getByText("health-c"));
  expect(isOpen("health-c")).toBe(true);
  expect(localStorage.getItem("triangulator:fold:health-c")).toBe("open");
});

test("a panel the user chose stays closed when storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("blocked");
  });
  const critical = [finding("monitor", "critical")];
  const { rerender } = render(panel("health-d", critical, "monitor"));
  expect(isOpen("health-d")).toBe(true);
  fireEvent.click(screen.getByText("health-d"));
  expect(isOpen("health-d")).toBe(false);
  rerender(panel("health-d", [], "monitor"));
  rerender(panel("health-d", critical, "monitor"));
  expect(isOpen("health-d")).toBe(false);
});
