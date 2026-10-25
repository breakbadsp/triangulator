import type { HelpTopicId } from "../help/topics";
export type Level = "critical" | "serious" | "warning" | "info" | "good";
export type FindingType =
  "monitor" | "threads" | "watched" | "resources" | "memory";
export interface Finding {
  type: FindingType;
  level: Level;
  title: string;
  detail: string;
  topic?: string;
  help?: HelpTopicId;
  hint?: string;
  action?: {
    tid?: number;
    state?: string;
    activity?: string;
    session?: string | null;
    generation?: number;
  };
}
export const LEVEL_ORDER: readonly Level[] = [
  "critical",
  "serious",
  "warning",
  "info",
  "good",
];
export const LEVEL_ICONS = {
  good: "✓",
  info: "i",
  warning: "!",
  serious: "▲",
  critical: "✕",
};
export const VERDICTS = {
  critical: "Needs attention now",
  serious: "Something is struggling",
  warning: "Worth a look",
  info: "Healthy",
  good: "Healthy",
};
export function worstLevel(findings: readonly Finding[]): Level {
  return (
    LEVEL_ORDER.find((level) =>
      findings.some((item) => item.level === level),
    ) ?? "good"
  );
}
/** A folded panel of this type opens for a warning or worse of its type. */
export const wantsFold = (findings: readonly Finding[], type: FindingType) =>
  findings.some(
    (item) =>
      item.type === type &&
      LEVEL_ORDER.indexOf(item.level) <= LEVEL_ORDER.indexOf("warning"),
  );
