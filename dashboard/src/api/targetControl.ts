import { getJson } from "./client";

export type ManagedTarget = { id: string; target: string };
/** "tables": [[target]] tables with IDs. "names": discovery lists. */
export type ControlMode = "tables" | "names";
export type TargetControl =
  | { enabled: false; reason: string }
  | {
      enabled: true;
      host: string;
      mode: ControlMode;
      targets: ManagedTarget[] | null;
      error: string;
    };
export type TargetChange =
  | ({ action: "add" } & ManagedTarget)
  | { action: "add"; target: string }
  | { action: "remove"; key: string; id: string; target: string }
  /** A discovered target: Remove deletes its exact name from process_names. */
  | { action: "remove"; key: string; id: string; rule: string };
export type ProcessCandidate = {
  pid: number;
  user: string;
  started_at: number | null;
  command: string;
};
export type TargetWrite =
  | { kind: "done"; message: string }
  | {
      kind: "failed";
      message: string;
      applied: boolean;
      candidates: ProcessCandidate[];
      total: number;
    };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const managed = (value: unknown): value is ManagedTarget =>
  record(value) &&
  typeof value.id === "string" &&
  typeof value.target === "string";
const candidate = (value: unknown): value is ProcessCandidate =>
  record(value) &&
  typeof value.pid === "number" &&
  Number.isSafeInteger(value.pid) &&
  value.pid > 0 &&
  typeof value.user === "string" &&
  typeof value.command === "string" &&
  (value.started_at === null ||
    (typeof value.started_at === "number" &&
      Number.isFinite(value.started_at)));

export function parseTargetControl(value: unknown): TargetControl {
  if (!record(value) || value.enabled !== true)
    return {
      enabled: false,
      reason:
        record(value) && typeof value.error === "string" ? value.error : "",
    };
  return {
    enabled: true,
    host: typeof value.host === "string" ? value.host : "",
    mode: value.mode === "names" ? "names" : "tables",
    targets:
      Array.isArray(value.targets) && value.targets.every(managed)
        ? value.targets
        : null,
    error: typeof value.error === "string" ? value.error : "",
  };
}
export async function readTargetControl(
  signal: AbortSignal,
): Promise<TargetControl> {
  try {
    return parseTargetControl(
      await getJson<unknown>("/api/targets/control", signal),
    );
  } catch {
    return { enabled: false, reason: "" };
  }
}
export async function changeTargets(
  change: TargetChange,
  check = false,
): Promise<TargetWrite> {
  const failed = (message: string): TargetWrite => ({
    kind: "failed",
    message,
    applied: false,
    candidates: [],
    total: 0,
  });
  try {
    const response = await fetch("/api/targets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Triangulator": "1" },
      body: JSON.stringify(check ? { ...change, check: true } : change),
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failed(
        `Unable to change targets (HTTP ${String(response.status)})`,
      );
    }
    if (!record(body))
      return failed(
        `Unable to change targets (HTTP ${String(response.status)})`,
      );
    if (!response.ok || typeof body.error === "string") {
      const candidates: ProcessCandidate[] = Array.isArray(body.candidates)
        ? body.candidates.filter(candidate)
        : [];
      return {
        kind: "failed",
        message:
          typeof body.error === "string"
            ? body.error
            : `Unable to change targets (HTTP ${String(response.status)})`,
        applied: body.applied === true,
        candidates,
        total:
          typeof body.total === "number" &&
          Number.isSafeInteger(body.total) &&
          body.total >= candidates.length
            ? body.total
            : candidates.length,
      };
    }
    return {
      kind: "done",
      message:
        typeof body.message === "string"
          ? body.message
          : "Reload requested. The target change applies to every viewer.",
    };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}
