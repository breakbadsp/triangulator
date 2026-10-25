import type { WatchRead, WatchWrite } from "../lib/watchEditor";
import { ApiError, getJson, postJson } from "./client";
import type { WatchInfo, WatchRule } from "./types";

// The boundary of the watch rule endpoints. Replies become domain results
// here; the editor never sees a Response or an HTTP status.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isRule = (rule: unknown): rule is WatchRule =>
  isRecord(rule) &&
  typeof rule.prefix === "string" &&
  typeof rule.wake_ms === "number" &&
  Number.isFinite(rule.wake_ms);

/**
 * The rules of a `/api/watches` reply for the assessment: the usable rules,
 * or null when the reply has no rule list.
 */
export function parseWatchRules(reply: unknown): WatchRule[] | null {
  const rules = isRecord(reply) ? reply.rules : undefined;
  if (!Array.isArray(rules)) return null;
  const list: unknown[] = rules;
  return list.filter(
    (rule): rule is WatchRule => isRule(rule) && rule.prefix !== "",
  );
}

/** A whole `/api/watches` reply, or null when it is not one. */
function parseWatchInfo(reply: unknown): WatchInfo | null {
  if (!isRecord(reply) || !Array.isArray(reply.rules)) return null;
  const { rules, source, saved_error, revision, limits } = reply;
  return rules.every(isRule) &&
    (source === "config" || source === "dashboard") &&
    (saved_error === null || typeof saved_error === "string") &&
    (revision === undefined || typeof revision === "string") &&
    isRecord(limits) &&
    ["prefix_max_bytes", "wake_ms_min", "wake_ms_max", "max_rules"].every(
      (name) => typeof limits[name] === "number",
    )
    ? (reply as unknown as WatchInfo)
    : null;
}
const UNEXPECTED = "The collector answered with an unexpected reply.";
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function readWatches(): Promise<WatchRead> {
  try {
    const info = parseWatchInfo(
      await getJson<unknown>("/api/watches", new AbortController().signal),
    );
    return info ? { kind: "ok", info } : { kind: "error", message: UNEXPECTED };
  } catch (error) {
    if (!(error instanceof ApiError))
      return { kind: "error", message: messageOf(error) };
    return error.status === 404
      ? { kind: "missing" }
      : {
          kind: "error",
          message: `The collector answered HTTP ${String(error.status)}.`,
        };
  }
}

/**
 * Saves the whole rule list, or resets to the config file rules. The
 * collector accepts the write only if `revision` is the one in force.
 */
export async function writeWatches(
  change: "save" | "reset",
  revision: string,
  rules: readonly WatchRule[],
): Promise<WatchWrite> {
  let reply: unknown;
  try {
    reply = await postJson<unknown>(
      change === "save" ? "/api/watches" : "/api/watches/reset",
      change === "save" ? { rules } : {},
      { ifMatch: `"${revision}"` },
    );
  } catch (error) {
    if (!(error instanceof ApiError))
      return {
        kind: "failed",
        message: `Could not reach the collector: ${messageOf(error)}`,
        conflict: false,
      };
    const body = isRecord(error.body) ? error.body : {};
    const message =
      typeof body.error === "string"
        ? body.error
        : error.status === 403
          ? "The collector refused the change (HTTP 403)."
          : `The change failed (HTTP ${String(error.status)}).`;
    if (body.applied === true) {
      const state = parseWatchInfo(body.applied_state);
      return {
        kind: "applied",
        message,
        state: state?.revision ? { ...state, revision: state.revision } : null,
      };
    }
    return {
      kind: "failed",
      message,
      conflict: error.status === 409 || error.status === 428,
    };
  }
  const info = parseWatchInfo(reply);
  return info
    ? { kind: "done", info }
    : { kind: "failed", message: UNEXPECTED, conflict: false };
}
