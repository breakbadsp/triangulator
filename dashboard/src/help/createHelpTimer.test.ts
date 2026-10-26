import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createHelpTimer, HELP_DELAY } from "./createHelpTimer";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
function helpClock() {
  const events: string[] = [];
  const timer = createHelpTimer<string>(
    (value) => {
      events.push(value);
    },
    () => {
      events.push("closed");
    },
  );
  return { events, timer };
}

test("waits the full dwell time for each topic", () => {
  const { events, timer } = helpClock();
  timer.request("cpu", "CPU");
  vi.advanceTimersByTime(HELP_DELAY - 1);
  expect(events).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(events).toEqual(["CPU"]);
  timer.request("delay", "Run delay");
  vi.advanceTimersByTime(HELP_DELAY - 1);
  expect(events.at(-1)).toBe("closed");
  vi.advanceTimersByTime(1);
  expect(events.at(-1)).toBe("Run delay");
});

test("cancels pending help on leave and preserves focus or entry into the card", () => {
  const { events, timer } = helpClock();
  timer.request("cpu", "CPU");
  vi.advanceTimersByTime(700);
  timer.leave();
  vi.advanceTimersByTime(HELP_DELAY);
  expect(events).toEqual([]);
  timer.request("cpu", "CPU");
  vi.advanceTimersByTime(800);
  timer.leave(() => true);
  vi.advanceTimersByTime(HELP_DELAY - 800);
  expect(events).toEqual(["CPU"]);
  timer.leave();
  vi.advanceTimersByTime(249);
  expect(events.at(-1)).toBe("CPU");
  timer.request("cpu", "CPU");
  vi.advanceTimersByTime(1000);
  expect(events).toEqual(["CPU"]);
  timer.leave();
  vi.advanceTimersByTime(250);
  expect(events.at(-1)).toBe("closed");
});

test("suppresses the same target after Escape until it is left", () => {
  const { events, timer } = helpClock();
  timer.request("cpu", "CPU");
  vi.advanceTimersByTime(HELP_DELAY);
  timer.cancel(true);
  timer.request("cpu", "CPU");
  vi.advanceTimersByTime(2000);
  expect(events).toHaveLength(2);
  timer.leave();
  timer.request("cpu", "CPU");
  vi.advanceTimersByTime(HELP_DELAY);
  expect(events).toHaveLength(3);
});

test("resets dwell for another point or significant pointer movement", () => {
  const { events, timer } = helpClock();
  timer.request("chart:100", "first", { x: 10, y: 10 });
  vi.advanceTimersByTime(900);
  timer.request("chart:100", "latest", { x: 14, y: 12 });
  vi.advanceTimersByTime(HELP_DELAY - 900);
  expect(events).toEqual(["latest"]);
  timer.request("chart:101", "next", { x: 14, y: 12 });
  vi.advanceTimersByTime(900);
  timer.request("chart:101", "moved", { x: 30, y: 12 });
  vi.advanceTimersByTime(HELP_DELAY - 1);
  expect(events.at(-1)).toBe("closed");
  vi.advanceTimersByTime(1);
  expect(events.at(-1)).toBe("moved");
});

test("freezes an open explanation and does not open a rejected target", () => {
  const { events, timer } = helpClock();
  timer.request("cpu", "first");
  vi.advanceTimersByTime(HELP_DELAY);
  timer.request("cpu", "changed");
  vi.advanceTimersByTime(HELP_DELAY);
  expect(events).toEqual(["first"]);
  const rejected = createHelpTimer(
    () => false,
    () => {
      events.push("wrong close");
    },
  );
  rejected.request("gone", {});
  vi.advanceTimersByTime(HELP_DELAY);
  expect(rejected.visible).toBeNull();
  expect(events).toEqual(["first"]);
});
