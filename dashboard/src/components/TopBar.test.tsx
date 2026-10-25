import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TopBar } from "./TopBar";
import type { Target } from "../api/types";
const target: Target = {
  key: "host/orders",
  host: "host",
  id: "orders",
  pid: 123,
  status: "live",
  process: null,
};
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

// Pinned 2958 and 2973. The selected target is excluded from attention counts.
test("shows access, shared budget and other-target attention, then a single identity", () => {
  const { rerender } = render(
    <TopBar
      page={{ kind: "target", key: target.key }}
      targets={[
        {
          ...target,
          access: "limited",
          throttled: true,
          effective_rate_hz: 2,
          sampler_cpu_pct: 0.9,
          cpu_budget_pct: 1,
        },
        { ...target, key: "host/billing", id: "billing", status: "absent" },
      ]}
    />,
  );
  expect(document.getElementById("target-access")?.textContent).toBe(
    "Limited access",
  );
  expect(document.getElementById("target-budget-value")?.textContent).toBe(
    "2.00 Hz",
  );
  expect(document.getElementById("target-budget")?.textContent).toContain(
    "CPU 0.90% of one core; budget 1.00%",
  );
  expect(document.getElementById("target-attention")?.textContent).toBe(
    "1 other target needs attention",
  );
  expect(
    screen.getByRole("option", { name: /Limited access · Sampler throttled/ }),
  ).toBeDefined();
  rerender(
    <TopBar page={{ kind: "target", key: target.key }} targets={[target]} />,
  );
  expect(
    screen.queryByRole("combobox", { name: "Selected monitoring target" }),
  ).toBeNull();
  expect(document.getElementById("target-key")?.textContent).toBe(
    "host · orders",
  );
  expect(document.getElementById("target-access")).toBeNull();
  expect(document.getElementById("target-budget")).toBeNull();
  expect(document.getElementById("target-attention")).toBeNull();
  rerender(
    <TopBar
      page={{ kind: "target", key: "host/missing" }}
      targets={[target]}
    />,
  );
  expect(
    screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Selected monitoring target",
    }).value,
  ).toBe("host/missing");
  rerender(
    <TopBar
      page={{ kind: "target", key: "host/missing" }}
      targets={[target]}
    />,
  );
  expect(
    screen.getByRole("option", { name: "Selected target unavailable" }),
  ).toBeDefined();
});

// The blocked-storage part of pinned 2902.
test("theme changes still apply when storage is blocked", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw Error("blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw Error("blocked");
  });
  render(<TopBar page={{ kind: "fleet" }} targets={[target]} />);
  const theme = screen.getByRole<HTMLSelectElement>("combobox", {
    name: "Color theme",
  });
  expect(theme.value).toBe("auto");
  fireEvent.change(theme, { target: { value: "dark" } });
  expect(document.documentElement.dataset.theme).toBe("dark");
  fireEvent.change(theme, { target: { value: "light" } });
  expect(document.documentElement.dataset.theme).toBe("light");
});
