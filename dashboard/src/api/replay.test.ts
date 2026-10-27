import { expect, test } from "vitest";
import { parseLive, parseView } from "./replay";

const live = (overrides: Record<string, unknown> = {}) => ({
  health: {
    session: "7",
    pid: 42,
    last_seen: 1000,
    sampler_silent: false,
    target_absent: false,
  },
  threads: [
    {
      tid: 42,
      name: "main",
      state: "running",
      cpu_pct: 12.5,
      last_sample: 1000,
    },
  ],
  ...overrides,
});

test("a live reply is read like a recording", () => {
  expect(parseLive(live()).threads).toHaveLength(1);
});

test("a live reply before the first sampler packet has no session", () => {
  const waiting = live({
    health: {
      session: null,
      pid: 0,
      last_seen: null,
      sampler_silent: true,
      target_absent: null,
    },
    threads: [],
  });
  expect(parseLive(waiting).health.session).toBeNull();
  // A recording always names its session.
  expect(() => parseView(waiting)).toThrow();
});

test.each([
  [
    "a thread with a text CPU value",
    { threads: [{ tid: 1, name: "a", cpu_pct: "12" }] },
  ],
  ["a thread without a tid", { threads: [{ name: "a" }] }],
  ["threads that are not a list", { threads: {} }],
  [
    "a memory sample with a text value",
    { memory: { available: true, values: { rss: "1" } } },
  ],
  ["a health block without a pid", { health: { session: "7", last_seen: 1 } }],
])(
  "a live reply with %s fails with a message that names the live reply",
  (_name, change) => {
    expect(() => parseLive(live(change))).toThrow(/live reply/);
  },
);
