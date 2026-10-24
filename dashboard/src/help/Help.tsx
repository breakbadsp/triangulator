import {
  useEffect,
  useId,
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
import "./help.css";

function hoverHelpEnabled() {
  try {
    return localStorage.getItem("triangulator:hover-help") !== "off";
  } catch {
    return true;
  }
}

export function Help({
  topic,
  children,
  className,
  as: Tag = "span",
}: {
  topic: HelpTopicId;
  children: ReactNode;
  className?: string;
  as?: "span" | "div";
}) {
  const anchor = useRef<HTMLElement>(null);
  const card = useRef<HTMLElement>(null);
  const id = useId();
  const [shown, setShown] = useState<HelpTopicId | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const timer = useMemo(
    () =>
      createHelpTimer<HelpTopicId>(
        (value) => {
          setShown(value);
        },
        () => {
          setShown(null);
        },
      ),
    [],
  );

  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") timer.cancel(true);
    }
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
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

  function showHelp(immediate: boolean) {
    const bounds = anchor.current?.getBoundingClientRect();
    if (!bounds) return;
    setPosition({
      left: Math.max(8, Math.min(bounds.left, innerWidth - 392)),
      top: Math.max(8, Math.min(bounds.bottom + 8, innerHeight - 240)),
    });
    if (immediate) timer.show(topic, topic);
    else timer.request(topic, topic);
  }
  function keepFocus() {
    return !!(
      anchor.current?.contains(document.activeElement) ||
      card.current?.contains(document.activeElement)
    );
  }
  const content: HelpTopic | null = shown ? helpTopics[shown] : null;
  return (
    <Tag
      ref={(element) => {
        anchor.current = element;
      }}
      className={className}
      data-help={topic}
      tabIndex={0}
      aria-describedby={shown ? id : undefined}
      onMouseEnter={() => {
        if (hoverHelpEnabled()) showHelp(false);
      }}
      onMouseLeave={() => {
        timer.leave(keepFocus);
      }}
      onFocus={() => {
        showHelp(true);
      }}
      onBlur={(event) => {
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
              timer.request(topic, topic);
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
          document.body,
        )}
    </Tag>
  );
}
