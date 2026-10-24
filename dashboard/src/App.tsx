import { useState } from "react";
import { getJson } from "./api/client";
import type { LiveResponse, TargetsResponse } from "./api/types";
import { ErrorBanner } from "./components/ErrorBanner";
import { SectionTabs } from "./components/SectionTabs";
import { TopBar } from "./components/TopBar";
import { FleetPage } from "./components/FleetPage";
import { ProcessExit, ProcessInfo } from "./components/ProcessCards";
import { Summary, type ChartWindow } from "./components/Summary";
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
  // The Threads state chart (phase 5) shares this window.
  const [windowSecs, setWindowSecs] = useState<ChartWindow>(300);
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
        >
          {view && (
            <>
              <ProcessInfo view={view} now={live.data?.now ?? 0} />
              <ProcessExit view={view} now={live.data?.now ?? 0} />
            </>
          )}
        </Summary>
      </main>
    </>
  );
}

export function App() {
  const page = readPage();
  return page.kind === "target" ? <TargetPage page={page} /> : <FleetPage />;
}
