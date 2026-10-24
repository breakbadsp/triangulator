// These fields come from collector/main.cpp and Engine::Snapshot.
export interface TargetsResponse {
  targets: readonly Target[];
}

export interface Target {
  key: string;
  host: string;
  id: string;
  pid: number;
  status: "live" | "silent" | "absent";
  process: { command: string } | null;
}

export interface LiveResponse {
  process?: ProcessInfo | null;
  health: {
    session?: string | null;
    packet_loss_pct?: number | null;
    sample_interval_ms?: number | null;
    pid: number;
    last_seen: number | null;
    sampler_silent: boolean;
    target_absent: boolean | null;
  };
  threads: readonly Thread[];
  resources?: Resources;
  memory?: MemorySummary;
  exit?: ProcessExit | null;
}

// Read fields only. Sources: Engine::Health/Snapshot, ResourceStore::SampleJson,
// MemoryStore::Snapshot/Layout, ExitStore::Snapshot, and WatchRulesJson.
export interface Thread {
  tid: number;
  name: string;
  generation?: number;
  state?: string;
  state_mix?: Readonly<Record<string, number>>;
  wchan?: string;
  stale?: boolean;
  last_sample?: number;
  last_ran?: number;
  wake_ms?: number | null;
  cpu_pct?: number | null;
  system_pct?: number | null;
  run_delay_pct?: number | null;
  switches_per_s?: number | null;
  major_faults_per_s?: number | null;
  read_bps?: number | null;
  write_bps?: number | null;
}
// Source: ProcessStore::Snapshot (collector/process.hpp).
export interface ProcessInfo {
  session: string;
  pid?: number;
  started_at: number | null;
  parent_pid?: number | null;
  uid?: number | null;
  euid?: number | null;
  gid?: number | null;
  egid?: number | null;
  command: string;
  executable?: string;
  working_directory?: string;
  cpus_allowed?: string;
  exe_deleted?: boolean;
  exe_hidden?: boolean;
  cwd_hidden?: boolean;
  command_truncated?: boolean;
  executable_truncated?: boolean;
  working_directory_truncated?: boolean;
  cpus_truncated?: boolean;
}
export interface ProcessExit {
  pid: number;
  process_start?: number;
  session?: string;
  name: string;
  ended_at: number;
  reason: string;
  next_session: string;
  signal?: number | null;
  signal_name?: string | null;
  core_dumped?: boolean | null;
  exit_code?: number | null;
  kernel_log?: string;
  error?: string | null;
  messages?: readonly string[];
  count?: number;
}
export interface PressureEntry {
  pct?: number | null;
  avg10?: number | null;
}
export type Pressure = Partial<
  Record<
    "cpu" | "memory" | "io",
    { some?: PressureEntry; full?: PressureEntry }
  >
>;
export interface ResourceSocket {
  kind: string;
  state: string;
  listener: boolean;
  local?: string;
  remote?: string | null;
  path?: string;
  rx_queue?: number;
  tx_queue: number;
  rx_fill_pct?: number | null;
  tx_fill_pct?: number | null;
  accept_fill_pct?: number | null;
  drops_delta?: number | null;
  tcp?: { peer_window?: number | null };
}
export interface Resources {
  available: boolean;
  stale?: boolean;
  updated?: number;
  pid?: number;
  session?: string | null;
  pressure?: { host?: Pressure; cgroup?: Pressure };
  io?: { read_bps?: number | null; write_bps?: number | null };
  fds?: { open?: number | null; soft_limit?: number | null };
  memory?: { rss?: number | null; anon?: number | null; swap?: number | null };
  cgroup_limits?: {
    memory?: {
      current?: number | null;
      max?: number | null;
      max_events_delta?: number | null;
      oom_kill_delta?: number | null;
    };
    cpu?: {
      quota_us?: number | null;
      period_us?: number | null;
      throttled_pct?: number | null;
    };
    pids?: { current?: number | null; max?: number | null };
  };
  sockstat?: { tcp_mem?: number | null };
  limits?: { tcp_mem?: readonly (number | null)[] };
  network?: Partial<Record<NetworkCounter, { delta?: number | null }>>;
  sockets?: {
    top?: readonly ResourceSocket[];
    tcp_states?: { close_wait?: number | null };
  };
  flags?: {
    other_network_namespace?: boolean;
    descriptors_hidden?: boolean;
    socket_diag_failed?: boolean;
  };
}
export type NetworkCounter =
  | "tcp_rcvq_drop"
  | "tcp_backlog_drop"
  | "tcp_zero_window_drop"
  | "listen_overflows"
  | "listen_drops"
  | "udp_rcvbuf_errors"
  | "udp_sndbuf_errors"
  | "tcp_retrans_segs"
  | "tcp_out_segs"
  | "tcp_memory_pressures"
  | "if_rx_dropped"
  | "if_tx_dropped"
  | "if_rx_errors"
  | "if_tx_errors";
export interface MemorySummary {
  available: boolean;
  stale?: boolean;
  pid?: number;
  layout_id?: string | null;
  flags?: {
    maps_hidden?: boolean;
    maps_partial?: boolean;
    regions_truncated?: boolean;
  };
  values?: {
    vm_size_bytes?: number | null;
    vma_count?: number | null;
    max_map_count?: number | null;
    address_space_limit_bytes?: number | null;
    stack_limit_bytes?: number | null;
  };
}
export interface MemoryRegion {
  start: string;
  end: string;
  size: number;
  vmas: number;
  kind: string;
  permissions: string;
  name: string;
}
export interface MemoryLayout {
  available: boolean;
  id?: string;
  pid?: number;
  flags?: {
    maps_hidden?: boolean;
    maps_partial?: boolean;
    regions_truncated?: boolean;
  };
  regions?: readonly MemoryRegion[];
}
export interface WatchRule {
  prefix: string;
  wake_ms: number;
}
export interface ResourceRow {
  ts: number;
  pid: number;
  elapsed_s: number | null;
  rss_bytes: number | null;
}
