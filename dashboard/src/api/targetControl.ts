import { getJson } from "./client";

export type TargetControl =
  | { enabled: false; reason: string }
  | { enabled: true; host: string; error: string };
/** Add and Remove edit the exact names in process_names. */
export type TargetChange =
  | { action: "add"; target: string }
  | { action: "remove"; key: string; id: string; rule: string };
export type TargetWrite =
  | { kind: "done"; message: string }
  | { kind: "failed"; message: string; applied: boolean };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

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
    if (!response.ok || typeof body.error === "string")
      return {
        kind: "failed",
        message:
          typeof body.error === "string"
            ? body.error
            : `Unable to change targets (HTTP ${String(response.status)})`,
        applied: body.applied === true,
      };
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
