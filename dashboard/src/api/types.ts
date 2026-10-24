// These fields come from collector/main.cpp and Engine::Snapshot.
export interface TargetsResponse {
  targets: Target[];
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
  health: {
    pid: number;
    last_seen: number | null;
    sampler_silent: boolean;
    target_absent: boolean | null;
  };
  threads: { tid: number; name: string }[];
}
