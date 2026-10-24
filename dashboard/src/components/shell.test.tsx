import { render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ErrorBanner } from "./ErrorBanner";
import { SectionTabs } from "./SectionTabs";

afterEach(() => {
  vi.unstubAllGlobals();
});
test("gives sampler silence priority over a poll error", () => {
  render(
    <ErrorBanner
      health={{
        pid: 42,
        last_seen: 0,
        sampler_silent: true,
        target_absent: false,
      }}
      error={new Error("Poll failed")}
    />,
  );
  expect(screen.getByRole("status").textContent).toBe(
    "⚠ Sampler is silent. Displayed thread data may be stale.",
  );
});
test("reports stale data for any collector error", () => {
  render(<ErrorBanner error={new Error("HTTP 503")} />);
  expect(screen.getByRole("status").textContent).toBe(
    "⚠ Collector unavailable. Displayed data is stale.",
  );
});
test("hides an empty error banner", () => {
  render(<ErrorBanner />);
  expect(screen.queryByRole("status")).toBeNull();
});
test("renders section entries as hash links", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  render(
    <SectionTabs
      entries={[
        { id: "overview", label: "Summary" },
        { id: "threads-section", label: "Threads" },
      ]}
    />,
  );
  expect(
    screen.getByRole("link", { name: "Summary" }).getAttribute("href"),
  ).toBe("#overview");
  expect(
    screen.getByRole("link", { name: "Threads" }).getAttribute("href"),
  ).toBe("#threads-section");
});
