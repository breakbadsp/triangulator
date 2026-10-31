// These fields come from collector/main.cpp and Engine::Snapshot.
export interface TargetsResponse {
  targets: readonly Target[];
  /** Packets dropped because the collector had max_targets targets. */
  capacity_drops?: number;
  max_targets?: number;
}
/** The target list and each target's live view, from one publication. */
export interface FleetResponse {
  list: TargetsResponse;
  /** Unchecked live views by target key; the page parses each one. */
  live: Readonly<Record<string, unknown>>;
}

export interface Target {
  key: string;
  host: string;
  id: string;
  pid: number;
  status: "live" | "silent" | "absent";
  process: { command: string } | null;
  access?: "full" | "limited";
  throttled?: boolean;
  effective_rate_hz?: number | null;
  sampler_cpu_pct?: number | null;
  cpu_budget_pct?: number | null;
  /** Its packets come from a loopback address: the collector host's sampler. */
  local?: boolean;
  /** Discovery rules that select it: the exact name in its ID, or another
   * rule (a pattern, another name after a rename, or its parent's rule). */
  name_selected?: boolean;
  other_rule_selected?: boolean;
  /** The exact process name that selects it, without an ID suffix. */
  rule?: string | null;
  /** Matching processes that its sampler could not admit. */
  excluded?: number;
}

export interface LiveResponse {
  recorded_at?: number;
  recording_interval_s?: number;
  process?: ProcessInfo | null;
  health: {
    session?: string | null;
    packet_loss_pct?: number | null;
    sample_interval_ms?: number | null;
    pid: number;
    last_seen: number | null;
    sampler_silent: boolean;
    target_absent: boolean | null;
    last_target?: { session: string; pid?: number; at?: number } | null;
    bad_packets?: number;
    duplicates?: number;
    late_packets?: number;
    raw_samples?: number;
    /** Not written by this collector; Monitor health shows "—". */
    sampler_ip?: string | null;
  };
  threads: readonly Thread[];
  /** Thread count by config group. */
  groups?: Readonly<Record<string, number>>;
  /** [step start, smallest thread count] for each 5 s step of the last 300 s. */
  thread_counts?: readonly (readonly [number, number])[];
  resources?: Resources;
  memory?: MemorySummary;
  exit?: ProcessExit | null;
}

// Read fields only. Sources: Engine::Health/Snapshot, ResourceStore::SampleJson,
// MemoryStore::Snapshot/Layout, ExitStore::Snapshot, and WatchRulesJson.
export interface Thread {
  tid: number;
  name: string;
  /** The thread group from the collector config. */
  group?: string;
  /** The CPU core the thread last ran on. */
  cpu?: number;
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
  total_us?: number | null;
}
export type Pressure = Partial<
  Record<
    "cpu" | "memory" | "io",
    { some?: PressureEntry; full?: PressureEntry }
  >
>;
export interface ResourceSocket {
  fd?: number;
  inode?: number;
  rmem_alloc?: number;
  rcvbuf?: number;
  wmem_alloc?: number;
  wmem_queued?: number;
  sndbuf?: number;
  drops?: number;
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
  tcp?: {
    peer_window?: number | null;
    rwnd_limited_pct?: number | null;
    sndbuf_limited_pct?: number | null;
    probes?: number;
    retransmits?: number;
    backoff?: number;
    retrans?: number;
    retrans_delta?: number | null;
    rtt_ms?: number;
  };
}
export interface Resources {
  sequence?: number;
  interval_s?: number;
  cgroup?: string | null;
  available: boolean;
  reason?: string;
  stale?: boolean;
  updated?: number;
  pid?: number;
  session?: string | null;
  pressure?: { host?: Pressure; cgroup?: Pressure };
  io?: { read_bps?: number | null; write_bps?: number | null };
  fds?: {
    open?: number | null;
    soft_limit?: number | null;
    hard_limit?: number | null;
    sockets?: number | null;
  };
  memory?: {
    rss?: number | null;
    anon?: number | null;
    file?: number | null;
    shmem?: number | null;
    swap?: number | null;
    peak?: number | null;
    rss_growth_per_s?: number | null;
  };
  cgroup_limits?: {
    memory?: {
      current?: number | null;
      max?: number | null;
      high?: number | null;
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
  sockstat?: Partial<
    Record<
      "tcp_mem" | "udp_mem" | "tcp_inuse" | "tcp_orphan" | "tcp_tw",
      number | null
    >
  >;
  limits?: {
    tcp_mem?: readonly (number | null)[];
    udp_mem?: readonly (number | null)[];
    page_size?: number | null;
    rmem_max?: number | null;
    wmem_max?: number | null;
    somaxconn?: number | null;
  };
  network?: Partial<
    Record<
      NetworkCounter,
      { delta?: number | null; per_s?: number | null; total?: number | null }
    >
  >;
  sockets?: {
    top?: readonly ResourceSocket[];
    tcp_states?: {
      close_wait?: number | null;
      established?: number | null;
      listen?: number | null;
    };
    tcp?: SocketQueues;
    udp?: SocketQueues;
    unix?: SocketQueues;
    matched?: number | null;
    unmatched?: number | null;
    complete?: boolean;
  };
  flags?: {
    other_network_namespace?: boolean;
    descriptors_hidden?: boolean;
    socket_diag_failed?: boolean;
    descriptor_scan_truncated?: boolean;
    sockets_truncated?: boolean;
  };
}
export interface SocketQueues {
  sockets?: number | null;
  rx_queue?: number | null;
  tx_queue?: number | null;
}
export type NetworkCounter =
  | "tcp_req_q_full_drop"
  | "syncookies_sent"
  | "prune_called"
  | "rcv_pruned"
  | "ofo_pruned"
  | "tcp_timeouts"
  | "tcp_abort_on_timeout"
  | "tcp_estab_resets"
  | "tcp_attempt_fails"
  | "tcp_abort_on_memory"
  | "udp_in_errors"
  | "udp_mem_errors"
  | "udp_no_ports"
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
  reason?: string;
  stale?: boolean;
  pid?: number;
  updated?: number;
  interval_s?: number;
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
    vm_peak_bytes?: number | null;
    vm_data_bytes?: number | null;
    vm_pte_bytes?: number | null;
    vm_locked_bytes?: number | null;
    minor_faults?: number | null;
    major_faults?: number | null;
    maps_reads?: number | null;
    maps_read_us?: number | null;
    maps_read_max_us?: number | null;
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
  updated?: number;
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
/** WatchSettings::Describe in collector/watch.hpp. */
export interface WatchLimits {
  prefix_max_bytes: number;
  wake_ms_min: number;
  wake_ms_max: number;
  max_rules: number;
}
export interface WatchInfo {
  rules: readonly WatchRule[];
  source: "config" | "dashboard";
  /** Why the saved file was not used at startup. */
  saved_error: string | null;
  /** Missing from a collector older than edit revisions. */
  revision?: string;
  limits: WatchLimits;
}
export interface ResourceRow {
  fd_open?: number | null;
  read_bps?: number | null;
  write_bps?: number | null;
  rx_queue_bytes?: number | null;
  tx_queue_bytes?: number | null;
  tcp_close_wait?: number | null;
  tcp_retrans_segs_delta?: number | null;
  tcp_timeouts_delta?: number | null;
  tcp_estab_resets_delta?: number | null;
  listen_overflows_delta?: number | null;
  listen_drops_delta?: number | null;
  tcp_backlog_drop_delta?: number | null;
  tcp_rcvq_drop_delta?: number | null;
  tcp_zero_window_drop_delta?: number | null;
  tcp_abort_on_memory_delta?: number | null;
  tcp_memory_pressures_delta?: number | null;
  udp_rcvbuf_errors_delta?: number | null;
  udp_sndbuf_errors_delta?: number | null;
  udp_in_errors_delta?: number | null;
  cgroup_cpu_some_pct?: number | null;
  cgroup_cpu_full_pct?: number | null;
  cgroup_memory_some_pct?: number | null;
  cgroup_memory_full_pct?: number | null;
  cgroup_io_some_pct?: number | null;
  cgroup_io_full_pct?: number | null;
  host_cpu_some_pct?: number | null;
  host_cpu_full_pct?: number | null;
  host_memory_some_pct?: number | null;
  host_memory_full_pct?: number | null;
  host_io_some_pct?: number | null;
  host_io_full_pct?: number | null;

  ts: number;
  pid: number;
  elapsed_s: number | null;
  rss_bytes: number | null;
}
// Source: History and HistoryRow (collector/http.hpp, collector/storage.hpp).
export interface HistoryRow {
  ts: number;
  cpu_pct: number | null;
  run_delay_pct: number | null;
  read_bps: number | null;
  write_bps: number | null;
  sample_counts: Readonly<Record<string, number>>;
  samples: number;
  expected_samples: number;
  /** 1 when the bucket has enough samples. */
  valid: number;
}
export interface HistoryResponse {
  rows: readonly HistoryRow[];
  limit: number;
  truncated: boolean;
}

export interface ResourceHistory {
  rows: readonly ResourceRow[];
  bucket_s: number;
  truncated: boolean;
  read_error: boolean;
}
export type PressureScope = "cgroup" | "host";
