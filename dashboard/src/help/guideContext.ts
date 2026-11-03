import { createContext } from "react";
import type { HelpTopicId } from "./topics";

export interface GuideRequest {
  topic: HelpTopicId;
  opener: HTMLElement;
  portal: HTMLElement | null;
  ancestors: readonly HTMLElement[];
  drawer: { element: HTMLElement; body: HTMLElement; scroll: number } | null;
}
export const GuideContext = createContext<{
  request: GuideRequest | null;
  open: (
    topic: HelpTopicId,
    opener: HTMLElement,
    portal?: HTMLElement | null,
  ) => void;
  close: (restore?: boolean) => void;
  dismissOwner: (owner: HTMLElement) => void;
} | null>(null);
