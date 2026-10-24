import type {
  LiveResponse,
  Resources,
  ResourceSocket,
  NetworkCounter,
  PressureEntry,
  MemorySummary,
  ResourceRow,
} from "../api/types";
import { asResourcePoints } from "./assess/memory";
export const NOW = 10000;
export function view(extra: Partial<LiveResponse> = {}): LiveResponse {
  return {
    health: {
      session: "s",
      pid: 1,
      last_seen: NOW,
      sampler_silent: false,
      target_absent: false,
    },
    threads: [],
    ...extra,
  };
}
function emptyCgroupLimits(): NonNullable<Resources["cgroup_limits"]> {
  return {};
}
function healthyResources() {
  const stall = (
    some: number,
    full = 0,
  ): { some: PressureEntry; full: PressureEntry } => ({
    some: { pct: some, avg10: some },
    full: { pct: full, avg10: full },
  });
  const top: ResourceSocket[] = [];
  const network: Partial<
    Record<NetworkCounter, { delta: number; per_s?: number; total?: number }>
  > = {
    tcp_out_segs: { delta: 1000, per_s: 200, total: 9 },
    tcp_retrans_segs: { delta: 0, per_s: 0, total: 1 },
  };
  return {
    available: true,
    stale: false,
    updated: NOW,
    pressure: {
      cgroup: { cpu: stall(1), memory: stall(0), io: stall(0) },
      host: { cpu: stall(2), memory: stall(0), io: stall(0) },
    },
    fds: { open: 10, soft_limit: 1024 },
    io: { read_bps: 0, write_bps: 0 },
    sockets: { top, tcp_states: { close_wait: 0 } },
    network,
    cgroup_limits: emptyCgroupLimits(),
    sockstat: { tcp_mem: 10 },
    limits: { tcp_mem: [100, 200, 300] },
    flags: {},
  };
}
export function resources(): ReturnType<typeof healthyResources>;
export function resources(overrides: Partial<Resources>): Resources;
export function resources(overrides: Partial<Resources> = {}) {
  return { ...healthyResources(), ...overrides };
}
export const memorySummary = (
  values: MemorySummary["values"] = {},
  extra: Partial<MemorySummary> = {},
): MemorySummary => ({
  available: true,
  stale: false,
  pid: 1,
  values: {
    vma_count: 100,
    max_map_count: 65530,
    vm_size_bytes: 1e9,
    address_space_limit_bytes: 0,
    stack_limit_bytes: 8 << 20,
    ...values,
  },
  ...extra,
});
export function rssHistory(
  parts: readonly (readonly [number, number, number, number])[],
  { step = 5, wobble = 0, dip = 0 } = {},
) {
  const total = parts.reduce((sum, part) => sum + part[1], 0),
    start = NOW - total;
  const rows: ResourceRow[] = [];
  let at = 0;
  for (const [pid, seconds, mib, rate] of parts)
    for (let t = 0; t < seconds; t += step, at += step)
      rows.push({
        ts: start + at,
        pid,
        elapsed_s: step,
        rss_bytes:
          (mib +
            rate * t +
            (rows.length % 2 ? wobble : 0) -
            (rows.length % 6 === 5 ? dip : 0)) *
          2 ** 20,
      });
  const latest = rows.at(-1);
  return {
    now: NOW,
    points: asResourcePoints(rows),
    view: view({
      health: { ...view().health, pid: parts.at(-1)?.[0] ?? 1 },
      resources: {
        available: true,
        memory: { rss: latest?.rss_bytes ?? null, anon: 1 },
      },
    }),
  };
}
