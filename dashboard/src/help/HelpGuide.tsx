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
import { ViewIdentityContext } from "../hooks/viewIdentityContext";
import { createHelpCards, HelpCardsContext } from "./helpCards";
import { GuideContext, type GuideRequest } from "./guideContext";
import { helpTopics, type HelpTopicId } from "./topics";
import "./help.css";

export function CodeText({ text }: { text: string }) {
  return text
    .split("`")
    .map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part));
}

export function HelpGuideProvider({ children }: { children: ReactNode }) {
  const { key } = useContext(ViewIdentityContext);
  const [request, setRequest] = useState<GuideRequest | null>(null);
  const current = useRef<GuideRequest | null>(null);
  const [returnFocus, setReturnFocus] = useState(false);
  const [scope, setScope] = useState(key);
  if (scope !== key) {
    setScope(key);
    setRequest(null);
    setReturnFocus(false);
  }
  const guide = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [modal, setModal] = useState(() => innerWidth < 760);
  const [cards] = useState(createHelpCards);
  useEffect(() => cards.listen(), [cards]);
  const close = useCallback(
    (focus = true) => {
      cards.cancelAll();
      setReturnFocus(focus);
      setRequest(null);
    },
    [cards],
  );
  const dismissOwner = useCallback(
    (owner: HTMLElement) => {
      const opener = current.current?.opener;
      if (opener && owner.contains(opener)) close(!owner.isConnected);
    },
    [close],
  );
  const open = useCallback(
    (
      topic: HelpTopicId,
      opener: HTMLElement,
      portal: HTMLElement | null = null,
    ) => {
      cards.cancelAll();
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
      });
    },
    [cards],
  );
  useLayoutEffect(() => {
    const previous = current.current;
    current.current = request;
    if (!previous || request || !returnFocus) return;
    const destination = previous.opener.isConnected
      ? previous.opener
      : document.getElementById("page-help");
    destination?.closest("details")?.setAttribute("open", "");
    destination?.focus({ preventScroll: true });
    if (previous.drawer?.body.isConnected)
      previous.drawer.body.scrollTop = previous.drawer.scroll;
  }, [request, returnFocus]);
  useEffect(() => {
    const resize = () => {
      setModal(innerWidth < 760);
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
  return (
    <HelpCardsContext value={cards}>
      <GuideContext value={{ request, open, close, dismissOwner }}>
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
                    <span>SOURCE</span>
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
                  {content.meaning && (
                    <p>
                      <CodeText text={content.meaning} />
                    </p>
                  )}
                  {content.source && (
                    <section>
                      <h3>Source</h3>
                      <p>
                        <CodeText text={content.source} />
                      </p>
                      <p>
                        <CodeText text={content.sourceDetail} />
                      </p>
                    </section>
                  )}
                </div>
              </aside>
            </>,
            request.portal ?? document.body,
          )}
      </GuideContext>
    </HelpCardsContext>
  );
}

export function PageHelp() {
  const guide = useContext(GuideContext);
  return (
    <details className="page-help">
      <summary data-help="page">Data sources</summary>
      <p>Open an info button for the source of a value.</p>
      <button
        id="page-help"
        type="button"
        data-help="page"
        onClick={(event) => {
          guide?.open("page", event.currentTarget);
        }}
      >
        Page source
      </button>
    </details>
  );
}
