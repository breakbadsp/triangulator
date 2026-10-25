import { ObservationContext } from "./observationContext";
import { useContext, useState, type MouseEvent } from "react";
import type { Readout } from "../help/Help";
import type { HelpTopicId } from "../help/topics";
import type { TipRow } from "../lib/threads";

/**
 * A help readout for the hovered part of a dense surface. One `Help` serves
 * the whole surface, so a target with thousands of threads mounts one card.
 */
export function useReadout(selection = "") {
  const { key } = useContext(ObservationContext);
  const context = `${key}|${selection}`;
  const [seen, setSeen] = useState(context);
  const [readout, setReadout] = useState<
    (Readout & { topic?: HelpTopicId }) | null
  >(null);
  if (seen !== context) {
    setSeen(context);
    setReadout(null);
  }
  return {
    readout: seen === context ? readout : null,
    show: (
      event: MouseEvent,
      key: string,
      title: string,
      rows: readonly TipRow[],
      stamp: number,
      topic?: HelpTopicId,
    ) => {
      // Drags open no card.
      if (event.buttons) return;
      const point = { x: event.clientX, y: event.clientY };
      setReadout((current) =>
        current?.key === key
          ? current
          : { key, title, rows, stamp, point, topic },
      );
    },
    clear: () => {
      setReadout(null);
    },
  };
}
