import type {
  Resources,
  ResourceSocket,
  PressureScope,
  ResourceRow,
} from "../api/types";
import type { ResourcePoint } from "./assess/memory";
import {
  hasCgroup,
  socketName,
  stall,
  peerWindowZero,
  movesData,
} from "./assess/resources";
import { bytes, perSec, pct, num as number, isNum, duration } from "./format";
export const PRESSURE_SERIES = [
  ["cpu", "CPU", "var(--s-running)"],
  ["memory", "Memory", "var(--s-futex)"],
  ["io", "I/O", "var(--s-poll)"],
] as const;
export const KIND_LABELS: Readonly<Record<string, string>> = {
  tcp4: "TCP",
  tcp6: "TCP6",
  udp4: "UDP",
  udp6: "UDP6",
  unix_stream: "Unix stream",
  unix_dgram: "Unix datagram",
  unix_seqpacket: "Unix seqpacket",
};
export const scopeOf = (r: Resources, scope: PressureScope): PressureScope =>
  scope === "cgroup" && hasCgroup(r) ? "cgroup" : "host";
export const fillLevel = (value: number) =>
  value >= 90 ? "critical" : value >= 75 ? "warning" : "";
export const socketLabel = (item: ResourceSocket) =>
  `${KIND_LABELS[item.kind] || item.kind} ${item.state} · fd ${String(item.fd)}`;
export const DROP_COLUMNS: readonly (keyof ResourceRow)[] = [
  "listen_drops_delta",
  "tcp_backlog_drop_delta",
  "tcp_rcvq_drop_delta",
  "tcp_zero_window_drop_delta",
  "udp_in_errors_delta",
  "udp_sndbuf_errors_delta",
];
export const NET_COUNTERS = [
  [
    "listen_overflows",
    "Accept queue overflows",
    "A listener’s accept queue was full and a new connection was dropped. The app is not calling accept() fast enough, or the backlog (listen(), somaxconn) is too small.",
    "listen_overflows_delta",
    "`/proc/PID/net/netstat` TcpExt: ListenOverflows",
  ],
  [
    "listen_drops",
    "Listen drops",
    "Every dropped incoming connection attempt, overflows included.",
    "listen_drops_delta",
    "`/proc/PID/net/netstat` TcpExt: ListenDrops",
  ],
  [
    "tcp_req_q_full_drop",
    "SYN queue full",
    "Half-open connections were dropped because the SYN queue was full.",
    null,
    "`/proc/PID/net/netstat` TcpExt: TCPReqQFullDrop",
  ],
  [
    "syncookies_sent",
    "SYN cookies sent",
    "The SYN queue overflowed and the kernel fell back to SYN cookies: a connection burst, a flood, or a slow accept loop.",
    null,
    "`/proc/PID/net/netstat` TcpExt: SyncookiesSent",
  ],
  [
    "tcp_backlog_drop",
    "Socket backlog drops",
    "Packets dropped while the app held the socket lock and the socket backlog was full.",
    "tcp_backlog_drop_delta",
    "`/proc/PID/net/netstat` TcpExt: TCPBacklogDrop",
  ],
  [
    "tcp_rcvq_drop",
    "Receive queue drops",
    "Packets dropped because a TCP receive buffer was full: a slow reader.",
    "tcp_rcvq_drop_delta",
    "`/proc/PID/net/netstat` TcpExt: TCPRcvQDrop",
  ],
  [
    "tcp_zero_window_drop",
    "Zero-window drops",
    "Packets dropped because the receiver had advertised a zero window.",
    "tcp_zero_window_drop_delta",
    "`/proc/PID/net/netstat` TcpExt: TCPZeroWindowDrop",
  ],
  [
    "prune_called",
    "Receive queue pruning",
    "The kernel had to collapse receive queues to stay within buffer limits: a slow reader or a small SO_RCVBUF.",
    null,
    "`/proc/PID/net/netstat` TcpExt: PruneCalled",
  ],
  [
    "rcv_pruned",
    "Packets pruned",
    "Packets thrown away from receive queues under memory limits.",
    null,
    "`/proc/PID/net/netstat` TcpExt: RcvPruned",
  ],
  [
    "ofo_pruned",
    "Out-of-order pruned",
    "Out-of-order packets thrown away under memory limits.",
    null,
    "`/proc/PID/net/netstat` TcpExt: OfoPruned",
  ],
  [
    "tcp_retrans_segs",
    "Retransmitted segments",
    "Segments sent again: packet loss or congestion on some path.",
    "tcp_retrans_segs_delta",
    "`/proc/PID/net/snmp` Tcp: RetransSegs",
  ],
  [
    "tcp_timeouts",
    "Retransmission timeouts",
    "A retransmission timer fired: a peer went quiet or the loss was severe.",
    "tcp_timeouts_delta",
    "`/proc/PID/net/netstat` TcpExt: TCPTimeouts",
  ],
  [
    "tcp_abort_on_timeout",
    "Aborted after timeouts",
    "Connections given up after repeated timeouts.",
    null,
    "`/proc/PID/net/netstat` TcpExt: TCPAbortOnTimeout",
  ],
  [
    "tcp_estab_resets",
    "Connections reset",
    "Established connections reset, by the peer or locally.",
    "tcp_estab_resets_delta",
    "`/proc/PID/net/snmp` Tcp: EstabResets",
  ],
  [
    "tcp_attempt_fails",
    "Failed connection attempts",
    "Outgoing connections that failed (refused or timed out).",
    null,
    "`/proc/PID/net/snmp` Tcp: AttemptFails",
  ],
  [
    "tcp_memory_pressures",
    "TCP memory pressure",
    "The kernel entered TCP memory pressure and started shrinking socket buffers (net.ipv4.tcp_mem).",
    "tcp_memory_pressures_delta",
    "`/proc/PID/net/netstat` TcpExt: TCPMemoryPressures",
  ],
  [
    "tcp_abort_on_memory",
    "Aborted for memory",
    "Connections aborted because TCP memory was exhausted.",
    "tcp_abort_on_memory_delta",
    "`/proc/PID/net/netstat` TcpExt: TCPAbortOnMemory",
  ],
  [
    "udp_rcvbuf_errors",
    "UDP receive buffer full",
    "Datagrams dropped because a receive buffer was full: a UDP reader is too slow or its SO_RCVBUF too small.",
    "udp_rcvbuf_errors_delta",
    "`/proc/PID/net/snmp` Udp: RcvbufErrors, plus Udp6RcvbufErrors in `snmp6`",
  ],
  [
    "udp_sndbuf_errors",
    "UDP send buffer full",
    "Sends that failed because the send buffer was full.",
    "udp_sndbuf_errors_delta",
    "`/proc/PID/net/snmp` Udp: SndbufErrors, plus Udp6SndbufErrors in `snmp6`",
  ],
  [
    "udp_in_errors",
    "UDP input errors",
    "Datagrams that could not be delivered, including receive-buffer drops.",
    "udp_in_errors_delta",
    "`/proc/PID/net/snmp` Udp: InErrors, plus Udp6InErrors in `snmp6`",
  ],
  [
    "udp_mem_errors",
    "UDP memory errors",
    "Datagrams dropped because UDP memory (net.ipv4.udp_mem) was exhausted.",
    null,
    "`/proc/PID/net/snmp` Udp: MemErrors, plus Udp6MemErrors in `snmp6`",
  ],
  [
    "udp_no_ports",
    "UDP to closed ports",
    "Datagrams to ports nobody listens on.",
    null,
    "`/proc/PID/net/snmp` Udp: NoPorts, plus Udp6NoPorts in `snmp6`",
  ],
  [
    "if_rx_dropped",
    "Interface receive drops",
    "A network interface dropped incoming packets before any socket saw them (ring or queue full). Summed over the namespace’s interfaces except lo.",
    null,
    "`/proc/PID/net/dev` receive drop, summed over interfaces except lo",
  ],
  [
    "if_tx_dropped",
    "Interface transmit drops",
    "A network interface dropped outgoing packets (queue full or link trouble).",
    null,
    "`/proc/PID/net/dev` transmit drop, summed over interfaces except lo",
  ],
  [
    "if_rx_errors",
    "Interface receive errors",
    "Bad frames, CRC or length errors on a network interface: cabling, driver or hardware.",
    null,
    "`/proc/PID/net/dev` receive errs, summed over interfaces except lo",
  ],
  [
    "if_tx_errors",
    "Interface transmit errors",
    "Transmit errors on a network interface: driver or hardware.",
    null,
    "`/proc/PID/net/dev` transmit errs, summed over interfaces except lo",
  ],
] as const;
export function socketNotes(item: ResourceSocket) {
  const notes: [string, string?][] = [],
    tcp = item.tcp || {};
  if (item.state === "SYN-SENT")
    notes.push(["Connect unanswered: check accept queue"]);
  else if (item.state === "SYN-RECV")
    notes.push(["Handshake not finished: waiting for the peer’s final ACK"]);
  if (item.listener) {
    if ((item.accept_fill_pct || 0) >= 100)
      notes.push(["Accept queue full: new connections are dropped", "bad"]);
    else if ((item.accept_fill_pct || 0) >= 50)
      notes.push(["Connections wait for accept()"]);
  }
  if ((item.rx_fill_pct || 0) >= 80)
    notes.push([
      "Receive buffer nearly full: the app is not reading fast enough",
      "bad",
    ]);
  else if ((item.rx_queue ?? 0) > 0 && !item.listener)
    notes.push(["Unread data waiting"]);
  if (item.tx_queue > 0 && peerWindowZero(item))
    notes.push(["Peer window is zero: the peer is not reading", "bad"]);
  else if ((item.tx_fill_pct || 0) >= 80)
    notes.push([
      "Send buffer nearly full: the peer or network is behind",
      "bad",
    ]);
  if (movesData(item) && (tcp.rwnd_limited_pct || 0) >= 20)
    notes.push([
      `Limited by the peer’s window ${pct(tcp.rwnd_limited_pct)} of the time`,
    ]);
  if ((tcp.sndbuf_limited_pct || 0) >= 20)
    notes.push([
      `Limited by its own send buffer ${pct(tcp.sndbuf_limited_pct)} of the time: raise SO_SNDBUF`,
    ]);
  if ((tcp.probes ?? 0) > 0)
    notes.push([`Zero-window probing (${String(tcp.probes)})`, "bad"]);
  if ((tcp.retransmits ?? 0) > 0)
    notes.push([`Retransmitting now (backoff ${String(tcp.backoff)})`, "bad"]);
  if ((item.drops_delta || 0) > 0)
    notes.push([
      `${String(item.drops_delta)} dropped in the last interval`,
      "bad",
    ]);
  if (item.state === "CLOSE-WAIT")
    notes.push(["Peer closed; the app has not closed its socket", "bad"]);
  return notes;
}

export function resourceTiles(
  r: Resources,
  points: readonly ResourcePoint[],
  chosen: PressureScope,
) {
  const scope = scopeOf(r, chosen),
    p = r.pressure?.[scope] || {},
    fds = r.fds || {},
    io = r.io || {},
    kinds = r.sockets || {},
    net = r.network || {};
  const queued = (key: "rx_queue" | "tx_queue") => {
    const values = (["tcp", "udp", "unix"] as const).map(
      (kind) => kinds[kind]?.[key],
    );
    return values.every(isNum)
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  };
  const receiveQueue = queued("rx_queue"),
    sendQueue = queued("tx_queue");
  const drops = (
    [
      "listen_drops",
      "tcp_backlog_drop",
      "tcp_rcvq_drop",
      "tcp_zero_window_drop",
      "udp_in_errors",
      "udp_sndbuf_errors",
    ] as const
  ).reduce<number | null>(
    (sum, key) => (isNum(net[key]?.per_s) ? (sum ?? 0) + net[key].per_s : sum),
    null,
  );
  const retrans = net.tcp_retrans_segs?.per_s,
    sent = net.tcp_out_segs?.per_s;
  const tiles: [
    string,
    string,
    string,
    readonly (number | null | undefined)[],
  ][] = [];
  for (const [key, label] of PRESSURE_SERIES.slice().reverse())
    tiles.push([
      label + " pressure",
      pct(stall(p[key]?.some)),
      `full ${pct(stall(p[key]?.full))} · ${scope === "cgroup" ? "cgroup" : "host"}`,
      points.map((point) => point[`${scope}_${key}_some_pct`]),
    ]);
  const memory = r.memory || {};
  tiles.push([
    "Memory (RSS)",
    bytes(memory.rss),
    `peak ${bytes(memory.peak)} · swap ${bytes(memory.swap)}` +
      (isNum(memory.rss_growth_per_s) &&
      Math.abs(memory.rss_growth_per_s) >= 1024
        ? ` · ${memory.rss_growth_per_s > 0 ? "+" : "−"}${bytes(Math.abs(memory.rss_growth_per_s))}/s`
        : ""),
    points.map((point) => point.rss_bytes),
  ]);
  tiles.push([
    "Open files",
    isNum(fds.open) ? String(fds.open) : "—",
    isNum(fds.soft_limit) && isNum(fds.open)
      ? `${pct((100 * fds.open) / fds.soft_limit)} of limit ${String(fds.soft_limit)} · ${String(fds.sockets ?? "?")} sockets`
      : "limit unknown",
    points.map((point) => point.fd_open),
  ]);
  tiles.push([
    "Disk I/O",
    isNum(io.read_bps) || isNum(io.write_bps)
      ? perSec((io.read_bps || 0) + (io.write_bps || 0))
      : "—",
    `read ${perSec(io.read_bps)} · write ${perSec(io.write_bps)} (block layer)`,
    points.map((point) =>
      isNum(point.read_bps) ? point.read_bps + (point.write_bps || 0) : null,
    ),
  ]);
  tiles.push([
    "Queued in sockets",
    bytes(
      isNum(receiveQueue) && isNum(sendQueue) ? receiveQueue + sendQueue : null,
    ),
    `unread ${bytes(receiveQueue)} · unsent ${bytes(sendQueue)}`,
    points.map((point) =>
      isNum(point.rx_queue_bytes) && isNum(point.tx_queue_bytes)
        ? point.rx_queue_bytes + point.tx_queue_bytes
        : null,
    ),
  ]);
  tiles.push([
    "Network drops",
    isNum(drops) ? number(drops, drops < 10 ? 2 : 1) + "/s" : "—",
    "connections and packets, namespace-wide",
    points.map((point) => {
      let sum = null;
      for (const key of DROP_COLUMNS) {
        const value = point.per(key);
        if (isNum(value)) sum = (sum || 0) + value;
      }
      return sum;
    }),
  ]);
  tiles.push([
    "TCP retransmits",
    isNum(retrans) ? number(retrans, retrans < 10 ? 2 : 1) + "/s" : "—",
    isNum(retrans) && isNum(sent) && sent > 0
      ? `${pct((100 * retrans) / sent)} of segments sent`
      : "namespace-wide",
    points.map((point) => point.per("tcp_retrans_segs_delta")),
  ]);
  const closeWait = kinds.tcp_states?.close_wait;
  if (
    (closeWait ?? 0) > 0 ||
    points.some((point) => (point.tcp_close_wait ?? 0) > 0)
  )
    tiles.push([
      "CLOSE-WAIT",
      String(closeWait ?? "—"),
      "closed by the peer, not by the app",
      points.map((point) => point.tcp_close_wait),
    ]);
  return tiles;
}

const busySocket = (item: ResourceSocket) =>
  (item.rx_queue ?? 0) > 0 ||
  (item.tx_queue > 0 && !item.listener) ||
  (item.drops_delta ?? 0) > 0 ||
  (item.tcp?.retrans_delta ?? 0) > 0 ||
  Math.max(item.rx_fill_pct || 0, item.tx_fill_pct || 0) >= 10 ||
  item.state === "CLOSE-WAIT";
/** The Fullest sockets rows and their count, as the old table showed them. */
export function fullestSockets(r: Resources, busyOnly: boolean) {
  const all = r.sockets?.top || [],
    rows = busyOnly ? all.filter(busySocket) : all;
  return {
    rows,
    count: `(${String(rows.length)} of ${String(all.length)} reported${r.flags?.sockets_truncated ? ", more not listed" : ""})`,
    empty: all.length
      ? "No socket has queued data, drops or retransmits right now."
      : "The target has no sockets the sampler could list.",
  };
}
const fill = (value: number | null | undefined, hint: string) =>
  isNum(value) ? { value, text: pct(value), hint } : null;
/** The displayed cells of one Fullest sockets row. A null fill shows —. */
export function socketCells(item: ResourceSocket) {
  const tcp = item.tcp,
    peer = socketName(item) ?? "";
  return {
    label: socketLabel(item),
    peer,
    recvQ: item.listener
      ? `${String(item.rx_queue)} pending`
      : bytes(item.rx_queue),
    receiveBuffer: item.listener
      ? fill(
          item.accept_fill_pct,
          `${String(item.rx_queue)} waiting for accept(), backlog ${String(item.tx_queue)}`,
        )
      : fill(
          item.rx_fill_pct,
          isNum(item.rcvbuf)
            ? `${bytes(item.rmem_alloc)} of ${bytes(item.rcvbuf)} receive buffer`
            : "",
        ),
    sendQ: item.listener ? "—" : bytes(item.tx_queue),
    sendBuffer: item.listener
      ? null
      : fill(
          item.tx_fill_pct,
          isNum(item.sndbuf)
            ? `${bytes(Math.max(item.wmem_queued || 0, item.wmem_alloc || 0))} of ${bytes(item.sndbuf)} send buffer`
            : "",
        ),
    drops: isNum(item.drops)
      ? String(item.drops) +
        ((item.drops_delta || 0) > 0 ? ` (+${String(item.drops_delta)})` : "")
      : "—",
    dropsBad: (item.drops_delta || 0) > 0,
    rtt: tcp && !item.listener ? number(tcp.rtt_ms, 2) + " ms" : "—",
    retrans: tcp
      ? String(tcp.retrans) +
        ((tcp.retrans_delta || 0) > 0 ? ` (+${String(tcp.retrans_delta)})` : "")
      : "—",
    notes: socketNotes(item),
  };
}
export function networkRows(r: Resources, points: readonly ResourcePoint[]) {
  const rows = NET_COUNTERS.flatMap(([key, label, meaning, column]) => {
    const entry = r.network?.[key];
    if (!entry || !isNum(entry.total)) return [];
    const range =
      column && points.length
        ? points.reduce((sum, p) => sum + (p[column] || 0), 0)
        : null;
    const active = (entry.delta || 0) > 0 || (range || 0) > 0;
    return [
      {
        key,
        label,
        meaning,
        entry,
        range,
        active,
        now: isNum(entry.per_s)
          ? number(entry.per_s, entry.per_s < 10 ? 2 : 1) + "/s"
          : "—",
        nowBad: active && (entry.per_s ?? 0) > 0,
        inRange: range === null ? "—" : number(range, 0),
        total: number(entry.total, 0),
      },
    ];
  });
  rows.sort(
    (a, b) =>
      Number((b.entry.delta || 0) > 0) - Number((a.entry.delta || 0) > 0) ||
      Number(b.active) - Number(a.active),
  );
  const zero = rows.filter((r) => !r.entry.total && !r.active).length;
  return {
    rows: rows.filter((r) => r.entry.total || r.active),
    zero: zero
      ? `${String(zero)} other counter${zero > 1 ? "s are" : " is"} zero.`
      : "",
  };
}
export function resourceCoverage(r: Resources) {
  const flags = r.flags || {};
  let text =
    `Sample ${String(r.sequence)} · every ${duration(r.interval_s || 0)} · ${String(r.sockets?.matched ?? "?")} sockets listed` +
    (r.sockets?.unmatched
      ? `, ${String(r.sockets.unmatched)} not listable (netlink, raw, packet or unbound UDP sockets)`
      : "") +
    ".";
  if (!r.sockets?.complete)
    text +=
      " Part of this sample was lost in transit; some sockets may be missing.";
  if (flags.other_network_namespace)
    text +=
      " The target is in another network namespace: its sockets are not visible to the sampler.";
  if (flags.descriptors_hidden)
    text +=
      " The sampler cannot read the target’s descriptor links, so its sockets cannot be identified.";
  if (flags.descriptor_scan_truncated)
    text += " The target has too many descriptors to inspect each one.";
  if (r.cgroup) text += " Cgroup: " + r.cgroup + ".";
  return text;
}
