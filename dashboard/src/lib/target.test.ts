import { expect, test } from "vitest";
import { viewTargetName } from "./target";

test("an exit names only the absence that followed it", () => {
  const exit = {
    pid: 100,
    name: "app",
    ended_at: 1000,
    reason: "segfault",
    next_session: "x",
  };
  const health = {
    session: "x",
    target_absent: true,
    pid: 0,
    sampler_silent: false,
    last_seen: 1000,
  };
  expect(viewTargetName({ health, threads: [], exit })).toBe("app");
  expect(
    viewTargetName({ health: { ...health, session: "y" }, threads: [], exit }),
  ).toBe("the target");
});
