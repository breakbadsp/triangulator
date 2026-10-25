import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ObservationContext } from "../hooks/observationContext";
import { date } from "../lib/format";
import { Help, cancelHelp, hoverHelpEnabled, setHoverHelp } from "./Help";
import {
  captureGuideChart,
  GuideContext,
  type GuideRequest,
} from "./guideContext";
import { helpTopics, helpTopicIds, type HelpTopicId } from "./topics";
import type { Readout } from "./Help";
import "./help.css";

export function CodeText({ text }: { text: string }) {
  return text
    .split("`")
    .map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part));
}

export function HelpGuideProvider({ children }: { children: ReactNode }) {
  const { key } = useContext(ObservationContext);
  const [request, setRequest] = useState<GuideRequest | null>(null);
  const current = useRef<GuideRequest | null>(null);
  const [returnFocus, setReturnFocus] = useState(false);
  const [scope, setScope] = useState(key);
  if (scope !== key) {
    setScope(key);
    setRequest(null);
    setReturnFocus(false);
  }
  const restoring = useRef(false);
  const guide = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [modal, setModal] = useState(() => innerWidth < 1200);
  const [hover, setHover] = useState(hoverHelpEnabled);
  const close = useCallback((focus = true) => {
    cancelHelp();
    setReturnFocus(focus);
    setRequest(null);
  }, []);
  const dismissOwner = useCallback(
    (owner: HTMLElement) => {
      if (current.current?.opener === owner) close(!owner.isConnected);
    },
    [close],
  );
  const open = useCallback(
    (
      topic: HelpTopicId,
      opener: HTMLElement,
      portal: HTMLElement | null = null,
      readout?: Readout,
    ) => {
      cancelHelp();
      setReturnFocus(false);
      const ancestors: HTMLElement[] = [];
      for (
        let node: HTMLElement | null = opener;
        node;
        node = node.parentElement
      )
        ancestors.push(node);
      const drawer = opener.closest<HTMLElement>("#drawer");
      const drawerBody = drawer?.querySelector<HTMLElement>(".drawer-body");
      setRequest({
        topic,
        originalTopic: topic,
        opener,
        portal,
        ancestors,
        drawer:
          drawer && drawerBody
            ? {
                element: drawer,
                body: drawerBody,
                scroll: drawerBody.scrollTop,
              }
            : null,
        readout,
        chart:
          opener.dataset.help === topic
            ? captureGuideChart(opener, topic)
            : undefined,
      });
      setHover(hoverHelpEnabled());
    },
    [],
  );
  useLayoutEffect(() => {
    const previous = current.current;
    current.current = request;
    if (!previous || request || !returnFocus) return;
    const destination = previous.opener.isConnected
      ? previous.opener
      : document.getElementById("page-help");
    destination?.closest("details")?.setAttribute("open", "");
    restoring.current = true;
    destination?.focus({ preventScroll: true });
    restoring.current = false;
    if (previous.drawer?.body.isConnected)
      previous.drawer.body.scrollTop = previous.drawer.scroll;
  }, [request, returnFocus]);
  useEffect(() => {
    const resize = () => {
      setModal(innerWidth < 1200);
    };
    addEventListener("resize", resize);
    return () => {
      removeEventListener("resize", resize);
    };
  }, []);
  const opener = request?.opener;
  useLayoutEffect(() => {
    if (!opener) return;
    document.body.classList.add("help-open");
    return () => {
      document.body.classList.remove("help-open");
    };
  }, [opener]);
  const portal = request?.portal;
  useLayoutEffect(() => {
    if (!opener) return;
    const blocked = modal
      ? [
          ...document.querySelectorAll<HTMLElement>(
            "header.topbar, main, #drawer, #error",
          ),
        ].filter(
          (element) =>
            !element.contains(guide.current) &&
            !(portal && element.contains(portal)),
        )
      : [];
    const previous = blocked.map((element) => element.inert);
    blocked.forEach((element) => {
      element.inert = true;
    });
    return () => {
      blocked.forEach((element, index) => {
        element.inert = previous[index] ?? false;
      });
    };
  }, [opener, modal, portal]);
  useLayoutEffect(() => {
    if (!opener) return;
    title.current?.focus();
    if (body.current) body.current.scrollTop = 0;
  }, [request?.topic, opener]);
  useLayoutEffect(() => {
    if (modal && opener && !guide.current?.contains(document.activeElement))
      title.current?.focus();
  }, [modal, opener]);
  useEffect(() => {
    if (!opener) return;
    function keyboard(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.key === "Tab" && modal) {
        const controls = [
          ...(guide.current?.querySelectorAll<HTMLElement>(
            "button, input, summary, a[href]",
          ) ?? []),
        ].filter(
          (element) =>
            !element.closest("[hidden]") && !element.matches(":disabled"),
        );
        const first = controls[0],
          last = controls.at(-1),
          focused = document.activeElement;
        if (
          event.shiftKey &&
          (focused === first ||
            focused === title.current ||
            !guide.current?.contains(focused))
        ) {
          event.preventDefault();
          last?.focus();
        } else if (
          !event.shiftKey &&
          (focused === last || !guide.current?.contains(focused))
        ) {
          event.preventDefault();
          first?.focus();
        }
      }
    }
    document.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("keydown", keyboard, true);
    };
  }, [opener, modal, close]);
  const content = request ? helpTopics[request.topic] : null;
  const navigate = (topic: HelpTopicId) => {
    setRequest((previous) => previous && { ...previous, topic });
  };
  return (
    <GuideContext value={{ request, restoring, open, close, dismissOwner }}>
      {children}
      {request &&
        content &&
        createPortal(
          <>
            {modal && (
              <div
                id="help-scrim"
                onClick={() => {
                  close();
                }}
              />
            )}
            <aside
              id="help-guide"
              ref={guide}
              role={modal ? "dialog" : "complementary"}
              aria-modal={modal || undefined}
              aria-labelledby="help-guide-title"
            >
              <div className="help-guide-head">
                <div className="help-guide-top">
                  <span>METRIC GUIDE</span>
                  <button
                    type="button"
                    aria-label="Close metric guide"
                    data-help="page"
                    onClick={() => {
                      close();
                    }}
                  >
                    Close ×
                  </button>
                </div>
                {request.drawer && (
                  <button
                    id="help-back-thread"
                    aria-label="Back to thread"
                    type="button"
                    data-help="thread"
                    onClick={() => {
                      close();
                    }}
                  >
                    ← Back to thread
                  </button>
                )}
                <h2 id="help-guide-title" ref={title} tabIndex={-1}>
                  {content.title}
                </h2>
              </div>
              <div id="help-guide-body" ref={body} key={request.topic}>
                <p className="muted">{content.scope}</p>
                <p className="help-intro">
                  <CodeText text={content.meaning} />
                </p>
                {request.readout && request.topic === request.originalTopic && (
                  <section className="help-example">
                    <h3>{request.readout.title}</h3>
                    {request.readout.rows.map((row) => (
                      <p key={row.label}>
                        {row.label}:{" "}
                        {row.value === "—" ? "Not available" : row.value}
                      </p>
                    ))}
                    <p>At {date(request.readout.stamp)}</p>
                  </section>
                )}
                {content.example && (
                  <section className="help-example">
                    <h3>Example</h3>
                    <p>
                      <CodeText text={content.example} />
                    </p>
                  </section>
                )}
                <section>
                  <h3>How to read it</h3>
                  <p>
                    <CodeText text={content.reading} />
                  </p>
                </section>
                <section>
                  <h3>Measurement limits</h3>
                  <p>
                    <CodeText text={content.limits} />
                  </p>
                </section>
                {content.sourceDetail && (
                  <section>
                    <h3>Source</h3>
                    <p>
                      <CodeText text={content.sourceDetail} />
                    </p>
                  </section>
                )}
                {request.chart && request.topic === request.originalTopic && (
                  <details data-help={request.topic}>
                    <summary>View chart data</summary>
                    {request.chart.rows.length === 0 ? (
                      <p>No chart samples are available in this view.</p>
                    ) : (
                      <div className="help-data">
                        <table>
                          <thead>
                            <tr>
                              {request.chart.headers.map((header) => (
                                <th key={header}>{header}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {request.chart.rows.map((row, index) => (
                              <tr key={index}>
                                {row.map((value, cell) => (
                                  <td key={cell}>{value}</td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </details>
                )}
                <nav aria-label="Related metrics" className="help-related">
                  {content.related.map((topic) => (
                    <button
                      key={topic}
                      type="button"
                      data-help={topic}
                      onClick={() => {
                        navigate(topic);
                      }}
                    >
                      {helpTopics[topic].title}
                    </button>
                  ))}
                </nav>
                {request.topic === "page" ? (
                  <nav className="help-topics" aria-label="All topics">
                    {helpTopicIds.map((topic) => (
                      <button
                        key={topic}
                        type="button"
                        data-help={topic}
                        onClick={() => {
                          navigate(topic);
                        }}
                      >
                        {helpTopics[topic].title}
                      </button>
                    ))}
                  </nav>
                ) : (
                  <button
                    type="button"
                    data-help="page"
                    onClick={() => {
                      navigate("page");
                    }}
                  >
                    All topics
                  </button>
                )}
              </div>
              <div className="help-preference">
                <label data-help="page">
                  <input
                    id="hover-help"
                    type="checkbox"
                    checked={hover}
                    onChange={(event) => {
                      const enabled = event.currentTarget.checked;
                      setHoverHelp(enabled);
                      setHover(enabled);
                      cancelHelp();
                    }}
                  />{" "}
                  Show help on hover
                </label>
              </div>
            </aside>
          </>,
          request.portal ?? document.body,
        )}
    </GuideContext>
  );
}

export function PageHelp() {
  const guide = useContext(GuideContext);
  return (
    <details className="page-help">
      <summary
        data-help="page"
        onClickCapture={(event) => {
          event.stopPropagation();
          cancelHelp();
        }}
      >
        <Help topic="page">How to read this page</Help>
      </summary>
      <p>
        Read the scope, unit, time interval, and data status before interpreting
        a metric. Open metric help for sources and measurement limits.
      </p>
      <button
        id="page-help"
        type="button"
        data-help="page"
        onClick={(event) => {
          guide?.open("page", event.currentTarget);
        }}
      >
        Open page guide
      </button>
    </details>
  );
}
