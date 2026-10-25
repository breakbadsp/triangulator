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
import {
  helpTopics,
  isHelpTopicId,
  type HelpTopic,
  type HelpTopicId,
} from "./topics";
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

function hoverHelpEnabled() {
  try {
    return localStorage.getItem("triangulator:hover-help") !== "off";
  } catch {
    return true;
  }
}

// Hidden drawers keep their range state, but must dismiss their portalled help.
export const HelpEnabled = createContext(true);
// Native modal dialogs must contain their help cards in the top layer.
export const HelpPortalTarget = createContext<HTMLElement | null>(null);

const helpTimers = new Set<{ cancel: (block?: boolean) => void }>();

export function Help({
  topic,
  children,
  className,
  as: Tag = "span",
  id: anchorId,
  readout,
}: {
  topic: HelpTopicId;
  children: ReactNode;
  className?: string;
  as?: "span" | "div" | "tbody";
  id?: string;
  readout?: Readout;
}) {
  const active = useContext(HelpEnabled);
  const portalTarget = useContext(HelpPortalTarget);
  const anchor = useRef<HTMLElement>(null);
  const card = useRef<HTMLElement>(null);
  const pointerFocus = useRef(false);
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
    [],
  );

  useEffect(() => {
    helpTimers.add(timer);
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && timer.active) {
        // A pending hover can receive Escape before another card's listener.
        for (const helpTimer of helpTimers) helpTimer.cancel(true);
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
    if (!active || !readoutKey || !readoutPoint || !hoverHelpEnabled()) return;
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
    const { height } = element.getBoundingClientRect();
    element.style.top = `${String(Math.max(12, Math.min(position.top, innerHeight - height - 12)))}px`;
  }, [shown, shownReadout, position]);

  function showHelp(immediate: boolean) {
    if (!active) return;
    const bounds = anchor.current?.getBoundingClientRect();
    if (!bounds) return;
    setPosition({
      left: Math.max(8, Math.min(bounds.left, innerWidth - 392)),
      top: Math.max(8, Math.min(bounds.bottom + 8, innerHeight - 240)),
    });
    if (immediate) timer.show(topic, { topic });
    else timer.request(topic, { topic });
  }
  function keepFocus() {
    return !!(
      anchor.current?.contains(document.activeElement) ||
      card.current?.contains(document.activeElement)
    );
  }
  const content: HelpTopic | null = active && shown ? helpTopics[shown] : null;
  return (
    <Tag
      ref={(element) => {
        anchor.current = element;
      }}
      id={anchorId}
      className={className}
      data-help={topic}
      tabIndex={0}
      aria-describedby={content ? id : undefined}
      onMouseEnter={() => {
        if (hoverHelpEnabled()) showHelp(false);
      }}
      onMouseLeave={() => {
        pointerFocus.current = false;
        timer.leave(keepFocus);
      }}
      onPointerDownCapture={() => {
        pointerFocus.current = true;
      }}
      onPointerUpCapture={() => {
        pointerFocus.current = false;
      }}
      onPointerCancelCapture={() => {
        pointerFocus.current = false;
      }}
      onFocus={() => {
        // A card opened during pointer focus can cover the control before
        // pointerup and swallow its click. Click opens help after the action.
        if (!pointerFocus.current) showHelp(true);
        pointerFocus.current = false;
      }}
      onBlur={(event) => {
        pointerFocus.current = false;
        if (
          !card.current?.contains(event.relatedTarget) &&
          !event.currentTarget.contains(event.relatedTarget)
        )
          timer.leave();
      }}
      onClick={() => {
        showHelp(true);
      }}
    >
      {children}
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
                <p className="muted">At {date(shownReadout.stamp)}</p>
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
            {content.related.filter(isHelpTopicId).length > 0 && (
              <nav aria-label="Related help">
                {content.related.filter(isHelpTopicId).map((related) => (
                  <a
                    key={related}
                    href={`#help-${related}`}
                    onClick={(event) => {
                      event.preventDefault();
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
