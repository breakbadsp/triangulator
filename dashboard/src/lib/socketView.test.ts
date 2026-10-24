import { expect, it } from "vitest";
import type { AvailableSocketReport, SocketValues } from "../api/types";
import {
  socketRows,
  socketValue,
  socketChart,
  socketStatus,
  socketCoverage,
  socketRowIdentity,
} from "./socketView";
export const values: SocketValues = {
  total: "0",
  current: 0,
  average: null,
  minimum: 0,
  maximum: 12,
};
export const report: AvailableSocketReport = {
  available: true,
  pid: 42,
  observer: "9007199254740993",
  process_start: "9007199254740994",
  messages_enabled: true,
  stale: false,
  stopped: false,
  losses: "0",
  lower_bound: false,
  duration: 60,
  updated: 1000,
  gaps: 1,
  truncated: false,
  rate_windows: 20,
  coverage: "Observed paths only.",
  totals: { input: values, output: values, messages: values },
  rows: [
    {
      tid: 9,
      name: "retired",
      thread_start: "9007199254740995",
      kind: "TCP",
      kind_id: 1,
      metrics: { input: values, output: values, messages: values },
    },
  ],
  history: [
    { ts: 1, input: null, output: 0, messages: 3 },
    { ts: 2, input: 0, output: null, messages: null },
  ],
};
it("keeps unknown rates, measured zeroes and chart gaps", () => {
  expect(socketValue(null, "input", true)).toBe("—");
  expect(socketValue(0, "input", true)).toBe("0 B /s");
  expect(socketValue("9007199254740993", "messages")).toBe(
    "9,007,199,254,740,993",
  );
  expect(socketChart(report, "input")).toEqual({
    points: [
      { t: 1, v: null },
      { t: 2, v: 0 },
    ],
    peak: "Peak: 0 B /s",
  });
});
it("sorts exact totals and retains full thread generations", () => {
  const first = report.rows[0];
  if (!first) throw new Error("Missing report row");
  const rows = [
    {
      ...first,
      thread_start: "2",
      metrics: {
        ...first.metrics,
        input: { ...values, total: "9007199254740992" },
      },
    },
    {
      ...first,
      metrics: {
        ...first.metrics,
        input: { ...values, total: "9007199254740993" },
      },
    },
  ];
  expect(
    socketRows({ ...report, rows }, "input", "", "RETIR")[0]?.thread_start,
  ).toBe(first.thread_start);
  expect(socketRowIdentity(report, first)).toContain(
    "9007199254740993|9007199254740994|9|9007199254740995|1",
  );
  expect(socketRows(report, "messages", "1", "")).toEqual([]);
});
it("explains stopped, silent, lower-bound, cached and incomplete reports", () => {
  expect(socketStatus({ ...report, stopped: true })).toBe("Observation ended");
  expect(socketStatus({ ...report, stale: true })).toBe("Observer silent");
  expect(socketStatus({ ...report, lower_bound: true })).toBe(
    "Incomplete · lower-bound totals",
  );
  expect(socketStatus({ ...report, refresh_error: true })).toBe(
    "Report refresh failed · cached",
  );
  const text = socketCoverage({
    ...report,
    stale: true,
    refresh_error: true,
    lower_bound: true,
    losses: "9007199254740993",
    read_error: true,
  });
  for (const part of [
    "9007199254740993 counter updates",
    "averages are unavailable",
    "totals may be stale",
    "cached",
    "unreadable",
    "1 recent gaps",
  ])
    expect(text).toContain(part);
});
