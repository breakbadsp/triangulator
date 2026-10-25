import { createContext, type RefObject } from "react";
import type { HelpTopicId } from "./topics";
import type { Readout } from "./Help";

export interface GuideChart {
  key: string;
  topic: HelpTopicId;
  headers: readonly string[];
  rows: readonly (readonly string[])[];
}
export interface GuideRequest {
  topic: HelpTopicId;
  originalTopic: HelpTopicId;
  opener: HTMLElement;
  portal: HTMLElement | null;
  ancestors: readonly HTMLElement[];
  drawer: { element: HTMLElement; body: HTMLElement; scroll: number } | null;
  readout?: Readout;
  chart?: GuideChart;
}
export const GuideContext = createContext<{
  request: GuideRequest | null;
  restoring: RefObject<boolean>;
  open: (
    topic: HelpTopicId,
    opener: HTMLElement,
    portal?: HTMLElement | null,
    readout?: Readout,
  ) => void;
  close: (restore?: boolean) => void;
  dismissOwner: (owner: HTMLElement) => void;
} | null>(null);

// Chart elements register their displayed data. A guide copies the values
// once, so later polls cannot replace the evidence the reader opened.
const charts = new WeakMap<Element, () => GuideChart>();
export function registerGuideChart(element: Element, read: () => GuideChart) {
  charts.set(element, read);
  return () => {
    charts.delete(element);
  };
}
export function captureGuideChart(opener: HTMLElement, topic: HelpTopicId) {
  const enclosing = opener.closest(".chart");
  const contained = opener.querySelectorAll(".chart");
  const candidates = enclosing
    ? [enclosing]
    : [
        ...(contained.length
          ? contained
          : (opener.closest(".card")?.querySelectorAll(".chart") ?? [])),
      ];
  const matching = candidates
    .map((element) => charts.get(element)?.())
    .filter((chart) => chart?.topic === topic);
  // A shared card can contain several metrics, or repeated views of one metric.
  return matching.length === 1 ? matching[0] : undefined;
}
