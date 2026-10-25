import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { getJson } from "./api/client";
import type {
  LiveResponse,
  PressureScope,
  TargetsResponse,
  Thread,
} from "./api/types";
import { ErrorBanner } from "./components/ErrorBanner";
import { SectionTabs } from "./components/SectionTabs";
import { TopBar } from "./components/TopBar";
import { FleetPage } from "./components/FleetPage";
import { MemoryMap } from "./components/MemoryMap";
import { Monitor } from "./components/Monitor";
import { ProcessExit, ProcessInfo } from "./components/ProcessCards";
import { Resources, type ResourceRange } from "./components/Resources";
import { SocketIO } from "./components/SocketIO";
import { Summary, type ChartWindow } from "./components/Summary";
import { ThreadDrawer } from "./components/ThreadDrawer";
import { Threads } from "./components/Threads";
import { WatchRules } from "./components/WatchRules";
import { Timeline } from "./components/Timeline";
import { Help } from "./help/Help";
import { ObservationContext } from "./hooks/observationContext";
import { useObservation } from "./hooks/useObservation";
import { emptySeries } from "./lib/series";
import { initialMemory } from "./lib/memoryView";
import { exitReason } from "./lib/exit";
import { date } from "./lib/format";
import type { Finding } from "./lib/findings";
import { initialThreadView, threadView } from "./lib/threadView";
import type { Series } from "./lib/series";
import { usePoll } from "./hooks/usePoll";
import { useWatchRules } from "./hooks/useWatchRules";
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
  const [resourceRange, setResourceRange] = useState<ResourceRange>(900);
  const display = useObservation(page.key, live.data, resourceRange);
  const observation = display.observation;
  const view = observation?.view;
  const mode = observation?.mode ?? { kind: "live" as const };
  const now = observation?.now ?? 0;
  const series = observation?.series ?? emptySeries;
  const memory = observation?.memory ?? initialMemory;
  const watchRules = useWatchRules(
    view?.threads,
    mode.kind === "live",
    display.scope,
  );
  const captureRules = display.rules;
  useEffect(() => {
    captureRules(watchRules.rules);
  }, [captureRules, watchRules.rules]);
  // Selecting the Settings tab reads the rules again, as before.
  const [settingsOpened, openSettings] = useReducer(
    (count: number) => count + 1,
    0,
  );
  // The Summary charts and the Threads state chart share this window.
  const [windowSecs, setWindowSecs] = useState<ChartWindow>(300);
  const [threads, dispatch] = useReducer(threadView, initialThreadView);
  const session = view?.health.session;
  const context = display.scope;
  const [pressureScope, setPressureScope] = useState<PressureScope>("cgroup");
  const resourcePoints = useMemo(
    () => observation?.resources ?? [],
    [observation?.resources],
  );
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
    <ObservationContext
      value={{
        key: `${context ?? "waiting"}|${String(resourceRange)}|${pressureScope}|${String(windowSecs)}`,
        recorded: mode.kind === "recorded",
      }}
    >
      <header className="topbar">
        <TopBar
          page={page}
          targets={targets.data?.targets ?? []}
          live={view}
          mode={mode}
          onDepart={display.depart}
          now={now}
          onLive={() => {
            closeThread();
            display.live();
          }}
        />
        <SectionTabs
          onSelect={(id) => {
            if (id === "collector-settings") openSettings();
          }}
        />
      </header>
      <ErrorBanner
        health={view?.health}
        error={mode.kind === "live" ? (live.error ?? targets.error) : undefined}
      />
      <main aria-label="Dashboard">
        <Help topic="exited" as="div">
          <div id="exited" className="card" hidden={!display.state.final}>
            <p id="exited-text">
              {display.state.final &&
                `${display.state.final.view.process?.command || "Target process"} (PID ${String(display.state.final.view.health.pid)}) stopped reporting at ${date(display.state.final.now)}: ${display.state.final.mode.kind === "final" && display.state.final.mode.exit ? `it ended (${exitReason(display.state.final.mode.exit)[0]}).` : "it exited or is no longer the target."} Showing its final view${display.state.final.series.points.length > 1 ? " and the trends this tab kept before then." : ". This tab has no earlier trends; thread history and recordings remain available."}${display.unsaved ? " The view is too large to keep across a reload." : ""}${display.state.latest?.view.health.pid && display.state.latest.view.health.session !== display.state.final.view.health.session && !display.state.latest.view.health.target_absent ? ` A new process (PID ${String(display.state.latest.view.health.pid)}) is being monitored.` : ""}`}
            </p>
            <button
              id="exited-live"
              type="button"
              onClick={() => {
                closeThread();
                display.dismiss();
              }}
            >
              Show live
            </button>
          </div>
        </Help>
        <Timeline
          bounds={display.bounds}
          observation={observation}
          latestAt={display.state.latest?.view.health.last_seen ?? 0}
          note={display.note}
          onInspect={(at, direction) => {
            void display.inspect(at, direction).then((selected) => {
              if (selected) closeThread();
            });
          }}
          onLive={() => {
            closeThread();
            display.live();
          }}
        />
        <Summary
          view={view}
          mode={mode}
          series={series}
          now={now}
          windowSecs={windowSecs}
          onWindow={setWindowSecs}
          onFindingAction={findingAction}
          resourcePoints={resourcePoints}
          pressureScope={pressureScope}
          memoryLayout={memory.layout}
          memoryHistory={memory.history}
          watchRules={observation?.watchRules ?? null}
        >
          {view && (
            <>
              <ProcessInfo view={view} now={now} />
              <ProcessExit view={view} now={now} />
            </>
          )}
        </Summary>
        <Threads
          view={view}
          recorded={mode.kind === "recorded"}
          series={series}
          windowSecs={windowSecs}
          threadView={threads}
          dispatch={dispatch}
          onOpen={openThread}
        />
        <Resources
          view={view}
          now={now}
          points={resourcePoints}
          range={resourceRange}
          onRange={setResourceRange}
          scope={pressureScope}
          onScope={setPressureScope}
        />
        <SocketIO
          external
          view={view}
          context={context}
          mode={mode}
          heldReport={observation?.sockets}
          heldError={observation?.socketError}
        />
        <MemoryMap
          mode={mode}
          view={view}
          now={now}
          memory={memory}
          dispatch={display.memory}
          series={series}
          resourcePoints={resourcePoints}
          scope={pressureScope}
        />
        <Monitor view={view} now={now} context={context} mode={mode} />
        <WatchRules
          threads={display.state.latest?.view.threads ?? []}
          recorded={mode.kind === "recorded"}
          opened={settingsOpened}
          onChanged={() => void watchRules.refresh()}
        />
      </main>
      <ThreadDrawer
        context={context}
        recorded={mode.kind === "recorded"}
        view={view}
        series={series}
        selected={selected}
        now={now}
        onClose={closeThread}
      />
    </ObservationContext>
  );
}

export function App() {
  const page = readPage();
  return page.kind === "target" ? <TargetPage page={page} /> : <FleetPage />;
}
