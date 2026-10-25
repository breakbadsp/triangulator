import type { WatchRule } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The rules of a `/api/watches` reply for the assessment: the usable rules,
 * or null when the reply has no rule list.
 */
export function parseWatchRules(reply: unknown): WatchRule[] | null {
  const rules = isRecord(reply) ? reply.rules : undefined;
  if (!Array.isArray(rules)) return null;
  return rules.filter(
    (rule): rule is WatchRule =>
      isRecord(rule) &&
      typeof rule.prefix === "string" &&
      rule.prefix !== "" &&
      typeof rule.wake_ms === "number" &&
      Number.isFinite(rule.wake_ms),
  );
}
