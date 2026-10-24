import { useCallback, useEffect, useReducer, useState } from "react";
import { getJson } from "./api/client";
import type { LiveResponse, TargetsResponse, Thread } from "./api/types";
import { ErrorBanner } from "./components/ErrorBanner";
import { SectionTabs } from "./components/SectionTabs";
import { TopBar } from "./components/TopBar";
import { FleetPage } from "./components/FleetPage";
import { ProcessExit, ProcessInfo } from "./components/ProcessCards";
import { Summary, type ChartWindow } from "./components/Summary";
import { ThreadDrawer } from "./components/ThreadDrawer";
import { Threads } from "./components/Threads";
import type { Finding } from "./lib/findings";
import { initialThreadView, threadView } from "./lib/threadView";
import type { Series } from "./lib/series";
import { usePoll } from "./hooks/usePoll";
import { useSeries } from "./hooks/useSeries";
import { readPage, type Page } from "./page";

const loadTargets = (signal: AbortSignal) =>
  getJson<TargetsResponse>("/api/targets", signal);
// The view's clock is read once, when its response arrives.
const loadLive = async (signal: AbortSignal) => ({
  view: await getJson<LiveResponse>("/api/live", signal),
  now: Date.now() / 1000,
});

function TargetPage({ page }: { page: Extract<Page, { kind: "target" }> }) {
  const targets = usePoll(loadTargets, 2000);
  const live = usePoll(loadLive, 1000);
  const view = live.data?.view;
  const series = useSeries(page.key, view);
  // The Summary charts and the Threads state chart share this window.
  const [windowSecs, setWindowSecs] = useState<ChartWindow>(300);
  const [threads, dispatch] = useReducer(threadView, initialThreadView);
  const session = view?.health.session;
  const openThread = useCallback(
    (thread: Thread, threadSession: Series["session"]) => {
      history.replaceState(null, "", `#thread=${String(thread.tid)}`);
      dispatch({
        type: "open",
        selected: {
          session: threadSession,
          tid: thread.tid,
          generation: thread.generation,
          name: thread.name,
        },
      });
    },
    [],
  );
  const closeThread = useCallback(() => {
    // Only the thread fragment goes; the target query stays.
    history.replaceState(null, "", location.pathname + location.search);
    dispatch({ type: "close" });
  }, []);
  // A #thread=<tid> URL opens that thread once it is reported.
  const selected = threads.selected;
  useEffect(() => {
    if (selected || !location.hash.startsWith("#thread=")) return;
    const tid = Number(location.hash.slice(8));
    const thread = view?.threads.find((item) => item.tid === tid);
    if (thread) openThread(thread, session);
  }, [view, selected, openThread, session]);
  function findingAction(action: NonNullable<Finding["action"]>) {
    if (action.tid) {
      const thread = view?.threads.find((item) => item.tid === action.tid);
      if (thread) openThread(thread, session);
      return;
    }
    dispatch({
      type: "finding",
      state: action.state,
      activity: action.activity,
    });
    document
      .getElementById("thread-details")
      ?.scrollIntoView({ behavior: "smooth" });
  }
  return (
    <>
      <header className="topbar">
        <TopBar page={page} targets={targets.data?.targets ?? []} live={view} />
        <SectionTabs />
      </header>
      <ErrorBanner health={view?.health} error={live.error ?? targets.error} />
      <main aria-label="Dashboard">
        <Summary
          view={view}
          series={series}
          now={live.data?.now ?? 0}
          windowSecs={windowSecs}
          onWindow={setWindowSecs}
          onFindingAction={findingAction}
        >
          {view && (
            <>
              <ProcessInfo view={view} now={live.data?.now ?? 0} />
              <ProcessExit view={view} now={live.data?.now ?? 0} />
            </>
          )}
        </Summary>
        <Threads
          view={view}
          series={series}
          windowSecs={windowSecs}
          threadView={threads}
          dispatch={dispatch}
          onOpen={openThread}
        />
      </main>
      <ThreadDrawer
        view={view}
        series={series}
        selected={selected}
        now={live.data?.now ?? 0}
        onClose={closeThread}
      />
    </>
  );
}

export function App() {
  const page = readPage();
  return page.kind === "target" ? <TargetPage page={page} /> : <FleetPage />;
}
