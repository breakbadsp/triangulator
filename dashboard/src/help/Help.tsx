import { ViewIdentityContext } from "../hooks/viewIdentityContext";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { createHelpTimer } from "./createHelpTimer";
import { helpTopics, type HelpTopic, type HelpTopicId } from "./topics";
import { GuideContext } from "./guideContext";
import { date } from "../lib/format";
import "./help.css";

/** Values at one chart sample, shown in the help card at the pointer. */
type Position = { left: number; top: number };
export interface Readout {
  /** Changes for each sample, so each sample is a new request. */
  key: string;
  title: string;
  rows: readonly { color: string; value: string; label: string }[];
  stamp: number;
  /** The pointer, in viewport coordinates. */
  point: { x: number; y: number };
}

// Hidden drawers keep their range state, but must dismiss their portalled help.
export const HelpEnabled = createContext(true);
// Native modal dialogs must contain their help cards in the top layer.
export const HelpPortalTarget = createContext<HTMLElement | null>(null);

const helpTimers = new Set<{ cancel: (block?: boolean) => void }>();
export function cancelHelp() {
  for (const timer of helpTimers) timer.cancel(true);
}

export function Help(props: {
  topic: HelpTopicId;
  children: ReactNode;
  className?: string;
  as?: "span" | "div" | "tbody";
  id?: string;
  readout?: Readout;
}) {
  const {
    topic,
    children,
    className,
    as: Tag = "span",
    id: anchorId,
    readout,
  } = props;
  const { key: observation, recorded } = useContext(ViewIdentityContext);
  const [seen, setSeen] = useState(observation);
  const guide = useContext(GuideContext);
  const active = useContext(HelpEnabled) && !guide?.request;
  const dismissOwner = guide?.dismissOwner;
  const portalTarget = useContext(HelpPortalTarget);
  const anchor = useRef<HTMLElement>(null);
  useEffect(() => {
    const owner = anchor.current;
    return () => {
      if (owner) dismissOwner?.(owner);
    };
  }, [observation, dismissOwner]);
  const card = useRef<HTMLElement>(null);
  const id = useId();
  const [shown, setShown] = useState<HelpTopicId | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  // The readout as it was when the card opened, so the rows stay while the
  // pointer leaves the chart for the card.
  const [shownReadout, setShownReadout] = useState<Readout | null>(null);
  const timer = useMemo(
    () =>
      createHelpTimer<{
        topic: HelpTopicId;
        at?: Position;
        readout?: Readout;
      }>(
        (value) => {
          setShown(value.topic);
          setShownReadout(value.readout ?? null);
          if (value.at) setPosition(value.at);
        },
        () => {
          setShown(null);
          setShownReadout(null);
        },
      ),
    // Each observation owns its pending and visible Help.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [observation],
  );
  if (seen !== observation) {
    setSeen(observation);
    setShown(null);
    setShownReadout(null);
  }

  useEffect(() => {
    helpTimers.add(timer);
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && timer.active) {
        // A pending hover can receive Escape before another card's listener.
        cancelHelp();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }
    document.addEventListener("keydown", escape, true);
    return () => {
      helpTimers.delete(timer);
      document.removeEventListener("keydown", escape, true);
      timer.cancel();
    };
  }, [timer]);
  useEffect(() => {
    if (!shown) return;
    function dismiss(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target) &&
        !card.current?.contains(event.target)
      )
        timer.cancel();
    }
    document.addEventListener("pointerdown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
    };
  }, [shown, timer]);

  useEffect(() => {
    if (!active) timer.cancel(true);
  }, [active, timer]);

  const readoutKey = readout?.key,
    readoutPoint = readout?.point;
  useEffect(() => {
    if (!active || !readoutKey || !readoutPoint) return;
    // Beside the pointer, or on its left when the card would overflow.
    const width = Math.min(380, innerWidth - 24);
    let left = readoutPoint.x + 8;
    if (left + width > innerWidth - 12) left = readoutPoint.x - width - 8;
    const at = {
      left: Math.max(12, Math.min(left, innerWidth - width - 12)),
      // The layout effect below fits the top to the card's height.
      top: Math.max(12, readoutPoint.y),
    };
    timer.request(readoutKey, { topic, at, readout }, readoutPoint);
    // The point only places the card; a new request needs a new sample.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, readoutKey, topic, timer]);

  // Fit the card to the viewport by its measured size, as the old page did.
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    if (portalTarget instanceof HTMLDialogElement) {
      const bounds = portalTarget.getBoundingClientRect();
      const leftSpace = bounds.left - 16;
      const rightSpace = innerWidth - bounds.right - 16;
      const space = Math.max(leftSpace, rightSpace);
      if (space >= 200) {
        element.style.boxSizing = "border-box";
        element.style.width = `min(380px, ${String(space)}px)`;
        const { width } = element.getBoundingClientRect();
        if (leftSpace >= rightSpace)
          element.style.left = `${String(bounds.left - width - 8)}px`;
        else element.style.left = `${String(bounds.right + 8)}px`;
      }
    }
    const { height } = element.getBoundingClientRect();
    element.style.top = `${String(Math.max(12, Math.min(position.top, innerHeight - height - 12)))}px`;
  }, [shown, shownReadout, position, portalTarget]);

  function keepFocus() {
    return !!card.current?.contains(document.activeElement);
  }
  const content: HelpTopic | null = active && shown ? helpTopics[shown] : null;
  // A chart passes `readout` even before the pointer is on it, and explains
  // itself through the readout card. A table body cannot hold a button.
  const info = guide && !("readout" in props) && Tag !== "tbody";
  const infoButton = info && (
    <button
      type="button"
      className={Tag === "div" ? "help-info help-info-corner" : "help-info"}
      data-help={topic}
      aria-label={`Explain ${helpTopics[topic].title}`}
      onClick={(event) => {
        // Inside a summary, the click must not also toggle the details.
        event.preventDefault();
        event.stopPropagation();
        guide.open(topic, event.currentTarget, portalTarget);
      }}
    />
  );
  return (
    <Tag
      ref={(element) => {
        anchor.current = element;
      }}
      id={anchorId}
      className={className}
      data-help={topic}
      aria-describedby={content ? id : undefined}
      onMouseLeave={() => {
        timer.leave(keepFocus);
      }}
      onPointerDownCapture={(event) => {
        if (
          event.target instanceof Node &&
          card.current?.contains(event.target)
        )
          return;
        timer.cancel(true);
      }}
    >
      {Tag === "div" && infoButton}
      {children}
      {Tag !== "div" && infoButton}
      {content &&
        createPortal(
          <aside
            ref={card}
            id={id}
            className="help-card"
            role="dialog"
            aria-label={content.title}
            style={position}
            onMouseEnter={() => {
              // Keep the open request, whatever its key, so the card stays.
              const open = timer.visible;
              if (open) timer.request(open.key, open.payload);
              else timer.request(topic, { topic });
            }}
            onMouseLeave={() => {
              timer.leave(keepFocus);
            }}
            onFocus={(event) => {
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <button
              type="button"
              className="help-close"
              aria-label="Close help"
              onClick={() => {
                timer.cancel(true);
              }}
            >
              ×
            </button>
            <h2>{content.title}</h2>
            <p className="muted">{content.scope}</p>
            <p>{content.meaning}</p>
            {shownReadout && (
              <div className="help-readout">
                <p className="muted">{shownReadout.title}</p>
                {shownReadout.rows.map((row) => (
                  <div key={row.label} className="help-reading">
                    <strong>
                      {row.value === "—" ? "Not available" : row.value}
                    </strong>
                    <span>{row.label}</span>
                  </div>
                ))}
                <p className="muted">
                  {recorded ? "Recorded at" : "At"} {date(shownReadout.stamp)}
                </p>
              </div>
            )}
            {content.example && (
              <p>
                <strong>Example. </strong>
                {content.example}
              </p>
            )}
            <p>{content.reading}</p>
            <p>
              <strong>Limits. </strong>
              {content.limits}
            </p>
            {content.source && (
              <p>
                <strong>Source. </strong>
                {content.source}
                <br />
                {content.sourceDetail}
              </p>
            )}
            {guide && (
              <button
                type="button"
                className="help-open-guide"
                onClick={() => {
                  if (anchor.current)
                    guide.open(
                      shown ?? topic,
                      anchor.current,
                      portalTarget,
                      shownReadout ?? undefined,
                    );
                }}
              >
                Open metric guide
              </button>
            )}
            {content.related.length > 0 && (
              <nav aria-label="Related help">
                {content.related.map((related) => (
                  <a
                    key={related}
                    href={`#help-${related}`}
                    onClick={(event) => {
                      event.preventDefault();
                      setShownReadout(null);
                      setShown(related);
                    }}
                  >
                    {helpTopics[related].title}
                  </a>
                ))}
              </nav>
            )}
          </aside>,
          portalTarget ?? document.body,
        )}
    </Tag>
  );
}
