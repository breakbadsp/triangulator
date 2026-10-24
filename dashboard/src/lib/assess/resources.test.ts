import { assert, test } from "vitest";
import type { Resources } from "../../api/types";
import { assessResources } from "./resources";
import { resources, NOW } from "../test-fixtures";
const findingsOf = (sample: Resources | undefined) =>
  assessResources(sample, NOW);
test("healthy resources add no findings and missing ones add none", () => {
  assert.strictEqual(findingsOf(resources()).length, 0);
  assert.strictEqual(findingsOf({ available: false }).length, 0);
  assert.strictEqual(findingsOf(undefined).length, 0);
});

test("pressure, descriptor and TCP memory rules use the cgroup when it reports", () => {
  const sample = resources();
  sample.pressure.cgroup.io = { some: { pct: 40 }, full: { pct: 12 } };
  sample.pressure.host.memory = { some: { pct: 50 }, full: { pct: 50 } }; // host only: ignored
  sample.fds.open = 1000;
  sample.network.tcp_memory_pressures = { delta: 1, per_s: 0.2, total: 3 };
  const findings = findingsOf(sample);
  const titles = findings.map((item) => `${item.level}: ${item.title}`);
  assert.ok(
    titles.includes("serious: I/O is stalling all work 12.0% of the time"),
    titles.join("\n"),
  );
  assert.ok(
    titles.includes("critical: 97.7% of file descriptors in use"),
    titles.join("\n"),
  );
  assert.ok(
    titles.includes("serious: TCP is under memory pressure"),
    titles.join("\n"),
  );
  assert.ok(
    !titles.some(
      (title) => title.includes("memory") && title.includes("thrashing"),
    ),
    "host memory is not the cgroup",
  );
  // A first sample has no interval yet: the kernel's 10 s average stands in.
  const first = resources();
  first.pressure.cgroup.memory = {
    some: { pct: null, avg10: 8 },
    full: { pct: null, avg10: 0 },
  };
  assert.strictEqual(
    findingsOf(first)[0]?.title,
    "Tasks wait for memory 8.0% of the time",
  );
});

test("cgroup CPU pressure names the quota only when cpu.max may set one", () => {
  const detail = (cpu: NonNullable<Resources["cgroup_limits"]>["cpu"]) => {
    const sample = resources();
    sample.pressure.cgroup.cpu = { some: { pct: 40 }, full: { pct: 0 } };
    sample.cgroup_limits = { cpu };
    return (
      findingsOf(sample).find((item) =>
        item.title.startsWith("Runnable tasks wait for CPU"),
      )?.detail ?? ""
    );
  };
  assert.strictEqual(
    detail({ quota_us: null, period_us: 100000 }),
    "More tasks are runnable than the cores can run. The cgroup has no CPU quota (cpu.max is max).",
  );
  assert.match(
    detail({ quota_us: 50000, period_us: 100000 }),
    /CPU quota \(cpu\.max\)/,
  );
  assert.match(detail({}), /CPU quota \(cpu\.max\)/);
});

test("socket rules name the slow reader, the slow peer and overflowing listeners", () => {
  const sample = resources();
  sample.sockets.top = [
    {
      kind: "tcp4",
      state: "LISTEN",
      listener: true,
      local: "0.0.0.0:8080",
      rx_queue: 5,
      tx_queue: 4,
      accept_fill_pct: 125,
    },
    {
      kind: "tcp4",
      state: "ESTAB",
      listener: false,
      local: "10.0.0.1:8080",
      remote: "10.0.0.9:5000",
      rx_queue: 120000,
      tx_queue: 0,
      rx_fill_pct: 95,
      tx_fill_pct: 0,
      drops_delta: 3,
      tcp: {},
    },
    {
      kind: "tcp4",
      state: "ESTAB",
      listener: false,
      local: "10.0.0.1:41000",
      remote: "10.0.0.7:5432",
      rx_queue: 0,
      tx_queue: 500000,
      rx_fill_pct: 0,
      tx_fill_pct: 40,
      tcp: { peer_window: 0 },
    },
  ];
  sample.sockets.tcp_states.close_wait = 12;
  sample.network.listen_overflows = { delta: 4, per_s: 0.8, total: 9 };
  sample.network.listen_drops = { delta: 4, per_s: 0.8, total: 9 };
  sample.network.udp_rcvbuf_errors = { delta: 7, per_s: 1.4, total: 70 };
  sample.network.tcp_retrans_segs = { delta: 50, per_s: 10, total: 60 };
  const titles = findingsOf(sample).map(
    (item) => `${item.level}: ${item.title}`,
  );
  for (const expected of [
    "serious: 4 incoming connections dropped",
    "serious: The app is not keeping up reading 10.0.0.1:8080 → 10.0.0.9:5000",
    "warning: 10.0.0.7:5432 is not taking data",
    "serious: 7 UDP datagrams dropped: receive buffers full",
    "warning: 5.0% of TCP segments retransmitted",
    "warning: 12 connections in CLOSE-WAIT",
  ]) {
    assert.ok(
      titles.includes(expected),
      `${expected}\n--\n${titles.join("\n")}`,
    );
  }
});

test("TCP retransmissions become a finding at 2% of segments sent", () => {
  const sample = resources();
  const retransmitted = (delta: number) => {
    sample.network.tcp_retrans_segs = { delta, per_s: delta / 5, total: delta };
    return findingsOf(sample)
      .filter((item) => item.title.includes("TCP segments retransmitted"))
      .map((item) => `${item.level}: ${item.title}`)
      .join("\n");
  };
  assert.strictEqual(retransmitted(15), "");
  assert.strictEqual(
    retransmitted(20),
    "warning: 2.0% of TCP segments retransmitted",
  );
});

test("a socket that is not transferring data is never called a zero-window peer", () => {
  const sample = resources();
  const syn = {
    fd: 4,
    kind: "tcp4",
    state: "SYN-SENT",
    listener: false,
    local: "127.0.0.1:46242",
    remote: "127.0.0.1:49947",
    rx_queue: 0,
    tx_queue: 1,
    rx_fill_pct: 0,
    tx_fill_pct: 0,
    tcp: { peer_window: 0, rwnd_limited_pct: 50 },
  };
  const unreported = { ...syn, state: "ESTAB", tcp: { peer_window: null } };
  sample.sockets.top = [syn, { ...syn, state: "SYN-RECV" }, unreported];
  assert.ok(
    !findingsOf(sample).some((item) => /not taking data/.test(item.title)),
  );
  for (const state of ["ESTAB", "CLOSE-WAIT"]) {
    const open = { ...syn, state, tcp: { peer_window: 0 } };
    sample.sockets.top = [open];
    assert.ok(
      findingsOf(sample).some((item) => /not taking data/.test(item.title)),
      state,
    );
  }
});

const kinds: readonly (readonly [string, string])[] = [
  ["udp4", "UNCONN"],
  ["unix-stream", "ESTAB"],
  ["tcp4", "SYN-SENT"],
];
test("full send buffers still produce findings outside TCP data states", () => {
  for (const [kind, state] of kinds) {
    const socket = {
      fd: 8,
      kind,
      state,
      listener: false,
      local: "local",
      remote: "peer",
      tx_queue: 4096,
      tx_fill_pct: 95,
      tcp: { peer_window: 0 },
    };
    const finding = findingsOf(resources({ sockets: { top: [socket] } })).find(
      (item) => /not taking data/.test(item.title),
    );
    assert.ok(finding, `${kind} ${state}`);
    assert.match(finding.detail, /send buffer 95.0% full/);
    assert.notMatch(finding.detail, /zero window/);
  }
});

test("memory, CPU quota, process count and interface rules", () => {
  const sample = resources({
    memory: { rss: 900e6, swap: 0 },
    cgroup_limits: {
      memory: {
        current: 950e6,
        max: 1e9,
        oom_kill_delta: 0,
        max_events_delta: 0,
      },
      cpu: { quota_us: 50000, period_us: 100000, throttled_pct: 30 },
      pids: { current: 95, max: 100 },
    },
  });
  const network = sample.network ?? {};
  sample.network = network;
  network.if_rx_dropped = { delta: 4 };
  network.if_tx_dropped = { delta: 0 };
  network.if_rx_errors = { delta: 1 };
  network.if_tx_errors = { delta: 0 };
  let titles = findingsOf(sample).map((item) => `${item.level}: ${item.title}`);
  for (const expected of [
    "warning: Cgroup memory is 95.0% of its limit",
    "serious: CPU quota throttled 30.0% of periods",
    "warning: 95 of 100 processes and threads in use",
    "warning: Network interfaces dropped 4 and reported 1 errors",
  ]) {
    assert.ok(
      titles.includes(expected),
      `${expected}\n--\n${titles.join("\n")}`,
    );
  }
  if (!sample.cgroup_limits?.memory) throw Error("missing memory");
  sample.cgroup_limits.memory.max_events_delta = 3;
  titles = findingsOf(sample).map((item) => item.title);
  assert.ok(
    titles.includes("Memory limit reached") &&
      !titles.some((title) => title.startsWith("Cgroup memory is")),
  );
  sample.cgroup_limits.memory.oom_kill_delta = 1;
  assert.strictEqual(
    findingsOf(sample)[0]?.title,
    "1 process killed by the OOM killer",
  );
  // No limits (all null) and a healthy cgroup add nothing.
  const quiet = resources({
    cgroup_limits: {
      memory: { current: 5e8, max: null },
      cpu: { quota_us: null, throttled_pct: null },
      pids: { current: 3, max: null },
    },
  });
  assert.strictEqual(findingsOf(quiet).length, 0);
});
