import type {
  Resources,
  ResourceSocket,
  Pressure,
  PressureEntry,
  NetworkCounter,
} from "../../api/types";
import type { Finding, Level } from "../findings";
import { isNum, pct, bytes, perSec, num, ago } from "../format";
const queueDrops: readonly NetworkCounter[] = [
  "tcp_rcvq_drop",
  "tcp_backlog_drop",
  "tcp_zero_window_drop",
];
const pressureKeys: readonly (keyof Pressure)[] = ["cpu", "memory", "io"];
export const hasCgroup = (r: Resources | null | undefined) =>
  pressureKeys.some(
    (key) =>
      isNum(r?.pressure?.cgroup?.[key]?.some?.pct) ||
      isNum(r?.pressure?.cgroup?.[key]?.some?.avg10),
  );
export const stall = (entry?: PressureEntry) =>
  isNum(entry?.pct) ? entry.pct : entry?.avg10;
export const socketName = (item: ResourceSocket) =>
  item.path !== undefined
    ? item.path || "unnamed"
    : item.remote
      ? `${String(item.local)} → ${item.remote}`
      : item.local;
const MOVES_DATA = new Set(["ESTAB", "CLOSE-WAIT", "FIN-WAIT-1", "LAST-ACK"]);
export const movesData = (item: ResourceSocket) =>
  !item.listener &&
  (item.kind === "tcp4" || item.kind === "tcp6") &&
  MOVES_DATA.has(item.state);
export const peerWindowZero = (item: ResourceSocket) =>
  movesData(item) && item.tcp?.peer_window === 0;
export function assessResources(r: Resources | null | undefined, now: number) {
  const findings: Finding[] = [];
  if (!r?.available) return findings;
  const add = (level: Level, title: string, detail: string) =>
    findings.push({ type: "resources", level, title, detail });
  if (r.stale)
    add(
      "warning",
      "Resource samples are stale",
      `No resource sample since ${ago(now - (r.updated || 0))}; pressure and socket figures below may be out of date.`,
    );
  const scope = hasCgroup(r) ? "cgroup" : "host",
    where = scope === "cgroup" ? "in the target’s cgroup" : "on the host",
    p = r.pressure?.[scope] || {};
  const io = p.io || {},
    memory = p.memory || {},
    cpu = p.cpu || {};
  if ((stall(io.full) ?? 0) >= 5)
    add(
      "serious",
      `I/O is stalling all work ${pct(stall(io.full))} of the time`,
      `Every non-idle task ${where} was waiting for I/O at once. Look at disk latency, fsync-heavy code, or a noisy neighbour on the device.`,
    );
  else if ((stall(io.some) ?? 0) >= 10)
    add(
      "warning",
      `Tasks wait for I/O ${pct(stall(io.some))} of the time`,
      `Some tasks ${where} were stalled on I/O. Storage reads ${perSec(r.io?.read_bps)}, writes ${perSec(r.io?.write_bps)} by this process.`,
    );
  if ((stall(memory.full) ?? 0) >= 2)
    add(
      "serious",
      `Memory is thrashing (${pct(stall(memory.full))} full stall)`,
      `All tasks ${where} were waiting on reclaim or swap at once. The workload needs more memory or a higher memory.high.`,
    );
  else if ((stall(memory.some) ?? 0) >= 5)
    add(
      "warning",
      `Tasks wait for memory ${pct(stall(memory.some))} of the time`,
      `Reclaim, swap-in or refaults ${where}. Check memory limits and growth.`,
    );
  // Name the quota only when cpu.max sets one; "max" has a period and no quota.
  const cpuLimit = r.cgroup_limits?.cpu || {},
    noQuota = !isNum(cpuLimit.quota_us) && isNum(cpuLimit.period_us);
  if ((stall(cpu.some) ?? 0) >= 20)
    add(
      "warning",
      `Runnable tasks wait for CPU ${pct(stall(cpu.some))} of the time`,
      scope !== "cgroup"
        ? "The host is oversubscribed."
        : noQuota
          ? "More tasks are runnable than the cores can run. The cgroup has no CPU quota (cpu.max is max)."
          : "CPU contention or the cgroup’s CPU quota (cpu.max) is throttling the target.",
    );
  const fds = r.fds || {};
  if (isNum(fds.open) && isNum(fds.soft_limit) && fds.soft_limit > 0) {
    const used = (100 * fds.open) / fds.soft_limit;
    if (used >= 75)
      add(
        used >= 90 ? "critical" : "warning",
        `${pct(used)} of file descriptors in use`,
        `${String(fds.open)} of ${String(fds.soft_limit)} (soft RLIMIT_NOFILE). At the limit, accept(), open() and socket() fail with EMFILE. Look for a descriptor leak or raise LimitNOFILE.`,
      );
  }
  const network = r.network || {},
    grew = (key: NetworkCounter) => network[key]?.delta || 0;
  const top = r.sockets?.top || [];
  const overflowing = top.filter(
    (item) => item.listener && (item.accept_fill_pct || 0) >= 80,
  );
  if (grew("listen_overflows") || grew("listen_drops"))
    add(
      "serious",
      `${String(grew("listen_drops") || grew("listen_overflows"))} incoming connections dropped`,
      (overflowing[0]
        ? `Accept queue of ${String(overflowing[0].local)} is ${pct(overflowing[0].accept_fill_pct)} full. `
        : "") +
        "A listener’s accept queue overflowed in the last interval (namespace-wide counter). The app is not accepting fast enough, or the backlog is too small.",
    );
  else if (overflowing[0])
    add(
      "warning",
      `Accept backlog of ${String(overflowing[0].local)} is ${pct(overflowing[0].accept_fill_pct)} full`,
      `${String(overflowing[0].rx_queue)} connections wait for accept() with a backlog of ${String(overflowing[0].tx_queue)}.`,
    );
  const reading = top
    .filter((item) => !item.listener && (item.rx_fill_pct || 0) >= 80)
    .sort((a, b) => (b.rx_fill_pct ?? 0) - (a.rx_fill_pct ?? 0));
  if (reading[0]) {
    const item = reading[0];
    add(
      (item.drops_delta || 0) > 0 ? "serious" : "warning",
      `The app is not keeping up reading ${String(socketName(item))}`,
      `Receive buffer ${pct(item.rx_fill_pct)} full with ${bytes(item.rx_queue)} unread` +
        ((item.drops_delta || 0) > 0
          ? `; ${String(item.drops_delta)} packet${(item.drops_delta ?? 0) > 1 ? "s" : ""} dropped.`
          : ".") +
        (reading.length > 1
          ? ` ${String(reading.length - 1)} more socket${reading.length > 2 ? "s" : ""} likewise.`
          : ""),
    );
  }
  const stuck = top
    .filter(
      (item) =>
        !item.listener &&
        item.tx_queue > 0 &&
        ((item.tx_fill_pct || 0) >= 80 || peerWindowZero(item)),
    )
    .sort((a, b) => b.tx_queue - a.tx_queue);
  if (stuck[0]) {
    const item = stuck[0];
    add(
      "warning",
      `${String(item.remote || socketName(item))} is not taking data`,
      `${bytes(item.tx_queue)} waiting to be sent` +
        (peerWindowZero(item)
          ? "; the peer advertises a zero window, so it is not reading."
          : `; send buffer ${pct(item.tx_fill_pct)} full.`) +
        " Writers to this socket will block or see EAGAIN.",
    );
  }
  const udp = grew("udp_rcvbuf_errors");
  if (udp)
    add(
      "serious",
      `${String(udp)} UDP datagrams dropped: receive buffers full`,
      "A UDP reader in the target’s namespace is too slow or its SO_RCVBUF is too small (net.core.rmem_max caps it).",
    );
  const queued = queueDrops.reduce((sum, key) => sum + grew(key), 0);
  if (queued)
    add(
      "warning",
      `${String(queued)} TCP packets dropped at full socket queues`,
      "Receive buffers or socket backlogs were full in the last interval: a reader is too slow.",
    );
  const sent = grew("tcp_out_segs"),
    retrans = grew("tcp_retrans_segs");
  if (sent >= 100 && retrans / sent >= 0.02)
    add(
      "warning",
      `${pct((100 * retrans) / sent)} of TCP segments retransmitted`,
      "Packet loss or congestion on some path; expect latency spikes. Check the sockets with retransmits below.",
    );
  const tcpMemory = r.sockstat?.tcp_mem,
    pressureAt = r.limits?.tcp_mem?.[1];
  if (
    grew("tcp_memory_pressures") ||
    (isNum(tcpMemory) &&
      isNum(pressureAt) &&
      pressureAt > 0 &&
      tcpMemory >= pressureAt)
  )
    add(
      "serious",
      "TCP is under memory pressure",
      "The kernel is shrinking socket buffers (net.ipv4.tcp_mem), which slows every TCP connection on the host.",
    );
  const closeWait = r.sockets?.tcp_states?.close_wait || 0;
  if (closeWait >= 10)
    add(
      "warning",
      `${String(closeWait)} connections in CLOSE-WAIT`,
      "Peers closed these connections but the app never closed its end. Usually a missing close() on an error path: a descriptor leak.",
    );
  const cg = r.cgroup_limits || {},
    mem = cg.memory || {},
    quota = cg.cpu || {},
    pids = cg.pids || {};
  if ((mem.oom_kill_delta ?? 0) > 0)
    add(
      "critical",
      `${String(mem.oom_kill_delta)} process${(mem.oom_kill_delta ?? 0) > 1 ? "es" : ""} killed by the OOM killer`,
      `The target’s cgroup reached its memory limit (${bytes(mem.max)}) and the kernel killed a process in it. Raise memory.max or find what grew.`,
    );
  else if ((mem.max_events_delta ?? 0) > 0)
    add(
      "warning",
      "Memory limit reached",
      `The cgroup hit memory.max ${String(mem.max_events_delta)} time${(mem.max_events_delta ?? 0) > 1 ? "s" : ""} in the last interval, forcing reclaim before allocations could continue (${bytes(mem.current)} of ${bytes(mem.max)}).`,
    );
  else if (
    isNum(mem.current) &&
    isNum(mem.max) &&
    mem.max > 0 &&
    mem.current >= 0.9 * mem.max
  )
    add(
      "warning",
      `Cgroup memory is ${pct((100 * mem.current) / mem.max)} of its limit`,
      `${bytes(mem.current)} of ${bytes(mem.max)}. This includes reclaimable page cache; it is a problem if the process’s own memory (RSS ${bytes(r.memory?.rss)}) is most of it.`,
    );
  if ((quota.throttled_pct ?? 0) >= 5)
    add(
      (quota.throttled_pct ?? 0) >= 25 ? "serious" : "warning",
      `CPU quota throttled ${pct(quota.throttled_pct)} of periods`,
      `The cgroup’s CPU quota (${num((quota.quota_us ?? 0) / (quota.period_us ?? 0), 2)} cores) ran out, so runnable threads waited for the next period even if cores were idle. Raise cpu.max or reduce CPU use.`,
    );
  if (
    isNum(pids.current) &&
    isNum(pids.max) &&
    pids.max > 0 &&
    pids.current >= 0.9 * pids.max
  )
    add(
      "warning",
      `${String(pids.current)} of ${String(pids.max)} processes and threads in use`,
      "At the cgroup’s pids.max, fork() and thread creation fail with EAGAIN.",
    );
  const dropped =
      (network.if_rx_dropped?.delta || 0) + (network.if_tx_dropped?.delta || 0),
    errored =
      (network.if_rx_errors?.delta || 0) + (network.if_tx_errors?.delta || 0);
  if (dropped > 0 || errored > 0)
    add(
      "warning",
      `Network interfaces dropped ${String(dropped)} and reported ${String(errored)} errors`,
      "Counted at the network card, before any socket (namespace-wide, last interval). Check interface queues, driver and cabling.",
    );
  const flags = r.flags || {};
  if (flags.other_network_namespace)
    add(
      "info",
      "Socket queues unavailable",
      "The target is in another network namespace; run the sampler inside it to list its sockets.",
    );
  else if (flags.descriptors_hidden)
    add(
      "info",
      "Socket details hidden",
      "The sampler cannot read the target’s descriptor links; run it as the target’s user.",
    );
  else if (flags.socket_diag_failed)
    add(
      "info",
      "Socket diagnostics failed",
      "The kernel’s sock_diag interface did not answer; socket queues are missing from this sample.",
    );
  return findings;
}
