import { expect, test } from "vitest";
import type { ProcessExit } from "../api/types";
import { exitReason, exitStatusText } from "./exit";

test("the exit status names unlogged crashes", () => {
  const exit: ProcessExit = {
    pid: 100,
    name: "app",
    ended_at: 1000,
    reason: "crashed",
    signal: 6,
    signal_name: "SIGABRT",
    core_dumped: true,
    exit_code: null,
    kernel_log: "unreadable",
    next_session: "x",
  };
  const reason = (value: Partial<ProcessExit>) =>
    exitReason({ ...exit, ...value }).slice(0, 2);
  expect(reason({})).toEqual(["Crashed: SIGABRT", "critical"]);
  expect(
    reason({
      reason: "killed",
      signal: 9,
      signal_name: "SIGKILL",
      core_dumped: false,
    }),
  ).toEqual(["Killed by SIGKILL", "warning"]);
  expect(reason({ reason: "exited", signal: null, exit_code: 3 })).toEqual([
    "Exited with code 3",
    "warning",
  ]);
  expect(reason({ reason: "exited", signal: null, exit_code: 0 })).toEqual([
    "Exited normally",
    "good",
  ]);
  expect(reason({ reason: "segfault" })).toEqual([
    "Segmentation fault",
    "critical",
  ]);
  expect(exitStatusText(exit)).toBe(
    "Exit status: SIGABRT (signal 6), core dumped.",
  );
});
