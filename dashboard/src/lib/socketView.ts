import type {
  AvailableSocketReport,
  SocketMetric,
  SocketRow,
} from "../api/types";
import { bytes, isNum } from "./format";
export const SOCKET_TITLES = {
  input: "Received bytes",
  output: "Sent bytes",
  messages: "Messages processed",
} as const;
export function socketValue(
  value: string | number | null | undefined,
  metric: SocketMetric,
  rate = false,
) {
  if (value === null || value === undefined) return "—";
  return metric === "messages"
    ? new Intl.NumberFormat(undefined, {
        maximumFractionDigits: rate ? 1 : 0,
      }).format(typeof value === "string" ? BigInt(value) : value) +
        (rate ? " /s" : "")
    : bytes(Number(value)) + (rate ? " /s" : "");
}
export const observerIdentity = (data: AvailableSocketReport) =>
  `${data.observer}|${data.process_start}`;
export const socketRowIdentity = (
  data: AvailableSocketReport,
  row: SocketRow,
) =>
  `${observerIdentity(data)}|${String(row.tid)}|${row.thread_start}|${String(row.kind_id)}`;
export function socketKinds(data: AvailableSocketReport) {
  return [
    ...new Map(
      data.rows
        .filter((r) => r.kind_id !== 6)
        .map((r) => [String(r.kind_id), r.kind]),
    ).entries(),
  ];
}
export function socketRows(
  data: AvailableSocketReport,
  metric: SocketMetric,
  kind: string,
  search: string,
) {
  return data.rows
    .filter(
      (r) =>
        (metric === "messages" ? r.kind_id === 6 : r.kind_id !== 6) &&
        (!kind || metric === "messages" || String(r.kind_id) === kind) &&
        (!search ||
          `${String(r.tid)} ${r.name}`
            .toLowerCase()
            .includes(search.toLowerCase())),
    )
    .sort((a, b) => {
      const av = BigInt(a.metrics[metric].total || "0"),
        bv = BigInt(b.metrics[metric].total || "0");
      return av < bv ? 1 : av > bv ? -1 : 0;
    });
}
export function socketStatus(data: AvailableSocketReport) {
  return data.refresh_error
    ? "Report refresh failed · cached"
    : data.stopped
      ? "Observation ended"
      : data.stale
        ? "Observer silent"
        : data.lower_bound
          ? "Incomplete · lower-bound totals"
          : "Observing supported paths";
}
export function socketCoverage(data: AvailableSocketReport) {
  let text =
    data.coverage +
    ` Average covers the monitoring period; min/max cover ${String(data.rate_windows)} valid nominal 1-second windows in the most recent 60 intervals. Idle covered windows count as zero.`;
  if (data.gaps) text += ` ${String(data.gaps)} recent gaps were excluded.`;
  if (data.lower_bound)
    text += ` ${data.losses} counter updates were lost: totals are lower bounds and averages are unavailable.`;
  if (data.stale && !data.stopped)
    text += " Observer is silent; totals may be stale.";
  if (data.refresh_error)
    text += " Report refresh failed; displayed totals and history are cached.";
  if (data.truncated || data.read_error)
    text +=
      " Report is incomplete because observations were limited or unreadable.";
  return text;
}
export function socketChart(data: AvailableSocketReport, metric: SocketMetric) {
  const points = data.history.map((p) => ({ t: p.ts, v: p[metric] }));
  const values = points.map((p) => p.v).filter(isNum);
  return {
    points,
    peak: values.length
      ? "Peak: " + socketValue(Math.max(...values), metric, true)
      : "No covered rate windows yet",
  };
}
