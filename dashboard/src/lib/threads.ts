import type { Thread } from "../api/types";
import { isNum } from "./format";
export const STATES = [
  "running",
  "futex",
  "poll",
  "socket",
  "pipe",
  "sleep",
  "stopped",
  "kernel",
  "other",
  "no_access",
] as const;
export const stateLabels: Readonly<Record<string, string>> = {
  running: "Running",
  futex: "Futex wait",
  poll: "Poll / epoll",
  socket: "Socket wait",
  pipe: "Pipe / eventfd",
  sleep: "Sleep",
  stopped: "Stopped",
  kernel: "Kernel wait (D)",
  other: "Other",
  no_access: "No access",
};
export const family = (name: string) =>
  (name || "?").replace(/[\s#:_.-]*\d+$/, "") || name;
export const isIdle = (thread: Thread) =>
  !(
    (thread.cpu_pct ?? 0) > 0 ||
    (thread.switches_per_s ?? 0) > 0 ||
    (thread.read_bps ?? 0) > 0 ||
    (thread.write_bps ?? 0) > 0 ||
    (thread.major_faults_per_s ?? 0) > 0 ||
    thread.state === "running" ||
    (thread.state_mix || {}).running ||
    thread.state === "kernel" ||
    thread.state === "stopped"
  );
export const futexShare = (thread: Thread) => {
  const mix = Object.values(thread.state_mix || {}),
    total = mix.reduce((sum, count) => sum + count, 0);
  return total ? ((thread.state_mix || {}).futex || 0) / total : 0;
};
const KERNEL_SHARE_MIN = 0.5,
  SPIN_SWITCHES_MIN = 100;
export function kernelShare(thread: Thread) {
  if (
    !(isNum(thread.cpu_pct) && thread.cpu_pct > 0) ||
    !(isNum(thread.system_pct) && thread.system_pct >= 0)
  )
    return null;
  const share = Math.min(1, thread.system_pct / thread.cpu_pct);
  return share >= KERNEL_SHARE_MIN &&
    (thread.switches_per_s || 0) >= SPIN_SWITCHES_MIN
    ? share
    : null;
}
export const threadLabel = (thread: Thread) =>
  `${thread.name} (${String(thread.tid)})`;
