import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { LiveResponse } from "../api/types";
import { helpTopics } from "../help/topics";
import { Monitor } from "./Monitor";

afterEach(() => {
  localStorage.clear();
});

const view = (health: Partial<LiveResponse["health"]> = {}): LiveResponse => ({
  health: {
    session: "s1",
    pid: 7,
    last_seen: 95,
    sampler_silent: false,
    target_absent: false,
    packet_loss_pct: 0.5,
    sample_interval_ms: 200,
    bad_packets: 1,
    duplicates: 2,
    late_packets: 3,
    raw_samples: 12345,
    ...health,
  },
  threads: [],
});
const show = (live: LiveResponse | undefined, context: string | null) => (
  <Monitor view={live} now={100} context={context} />
);
const rows = (): Record<string, string> =>
  Object.fromEntries(
    [...document.querySelectorAll("#health > div")].map((row) => [
      row.querySelector("dt")?.textContent ?? "",
      row.querySelector("dd")?.textContent ?? "",
    ]),
  );

test("monitor health lists the sampler link and the raw health JSON", () => {
  render(show(view(), "t|s1|7"));
  expect(rows()).toEqual({
    Sampler: "Connected",
    "Last data": "5 s ago",
    "Sample interval": "200 ms",
    "Packet loss (1 min)": "0.5%",
    "Bad · duplicate · late": "1 · 2 · 3",
    "Raw samples held": "12.3K",
    "Sampler address": "—",
    Session: "s1",
  });
  expect(
    JSON.parse(document.getElementById("diagnostics")?.textContent ?? ""),
  ).toEqual(view().health);
  const section = document.getElementById("monitor");
  for (const element of section?.querySelectorAll<HTMLElement>("[data-help]") ??
    [])
    expect(Object.hasOwn(helpTopics, element.dataset.help ?? "")).toBe(true);
  // Every visible label has a help anchor.
  for (const text of [
    "Monitor",
    "Monitor health",
    "Monitor diagnostics (raw health JSON)",
    ...Object.keys(rows()),
  ])
    expect(screen.getByText(text).closest("[data-help]")).not.toBeNull();
});

test("the health fold opens by itself for a monitor warning", () => {
  const { rerender } = render(show(view(), "t|s1|7"));
  const fold = () => document.querySelector<HTMLDetailsElement>("details.fold");
  expect(fold()?.open).toBe(false);
  rerender(show(view({ sampler_silent: true }), "t|s1|7"));
  expect(fold()?.open).toBe(true);
  expect(rows().Sampler).toBe("Silent");
});

test("every help anchor starts again for a new process session", () => {
  const { rerender } = render(show(view(), "t|s1|7"));
  const before = [...document.querySelectorAll("#monitor [data-help]")];
  expect(before.length).toBeGreaterThan(10);
  rerender(show(view(), "t|s1|7"));
  expect(before.every((element) => element.isConnected)).toBe(true);
  rerender(show(view({ session: "s2" }), "t|s2|7"));
  expect(before.filter((element) => element.isConnected)).toEqual([]);
});

test("the rows stay still under the pointer and never show another process", () => {
  const { rerender } = render(show(view(), "t|s1|7"));
  const list = document.getElementById("health");
  if (!list) throw new Error("no health list");
  fireEvent.mouseEnter(list);
  rerender(show(view({ raw_samples: 20 }), "t|s1|7"));
  expect(rows()["Raw samples held"]).toBe("12.3K");
  rerender(show(view({ session: "s2", raw_samples: 20 }), "t|s2|7"));
  expect(rows().Session).toBe("s2");
  expect(rows()["Raw samples held"]).toBe("20");
  fireEvent.mouseLeave(list);
  rerender(show(view({ session: "s2", raw_samples: 30 }), "t|s2|7"));
  expect(rows()["Raw samples held"]).toBe("30");
});
