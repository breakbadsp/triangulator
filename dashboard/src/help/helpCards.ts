import { createContext } from "react";

interface CardTimer {
  readonly active: unknown;
  cancel: (block?: boolean) => void;
}

// The open and pending Help cards of one page. A provider owns the set, so a
// test or a second root cannot cancel another page's cards.
export function createHelpCards() {
  const timers = new Set<CardTimer>();
  function cancelAll() {
    for (const timer of timers) timer.cancel(true);
  }
  return {
    add(timer: CardTimer) {
      timers.add(timer);
      return () => {
        timers.delete(timer);
      };
    },
    cancelAll,
    /** One Escape listener for every card of the page. */
    listen() {
      function escape(event: KeyboardEvent) {
        if (event.key !== "Escape") return;
        if (![...timers].some((timer) => timer.active)) return;
        // A pending hover can receive Escape before another card's listener.
        cancelAll();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      document.addEventListener("keydown", escape, true);
      return () => {
        document.removeEventListener("keydown", escape, true);
      };
    },
  };
}
export type HelpCards = ReturnType<typeof createHelpCards>;
export const HelpCardsContext = createContext<HelpCards | null>(null);
