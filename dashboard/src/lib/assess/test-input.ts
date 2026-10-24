import type { AssessInput } from "./index";
import type { LiveResponse } from "../../api/types";
import type { Point } from "../series";
import { emptySeries } from "../series";
import { NOW, view } from "../test-fixtures";
export function input(
  live: LiveResponse = view(),
  extra: Partial<AssessInput> = {},
): AssessInput {
  return {
    view: live,
    mode: { kind: "live" },
    now: NOW,
    series: emptySeries,
    watchRules: null,
    resourcePoints: [],
    memoryLayout: null,
    memoryHistory: [],
    pressureScope: "cgroup",
    ...extra,
  };
}
export function point(t: number, n = 0, extra: Partial<Point> = {}): Point {
  return {
    t,
    n,
    cpu: 0,
    rd: null,
    sw: 0,
    rb: 0,
    wb: 0,
    mf: null,
    busy: 0,
    active: 0,
    s: {},
    born: 0,
    died: 0,
    rss: null,
    vm: null,
    ...extra,
  };
}
