import { getJson } from "./api/client";
import type { LiveResponse, TargetsResponse } from "./api/types";
import { ErrorBanner } from "./components/ErrorBanner";
import { SectionTabs } from "./components/SectionTabs";
import { TopBar } from "./components/TopBar";
import { FleetPage } from "./components/FleetPage";
import { usePoll } from "./hooks/usePoll";
import { readPage, type Page } from "./page";

const loadTargets = (signal: AbortSignal) =>
  getJson<TargetsResponse>("/api/targets", signal);
const loadLive = (signal: AbortSignal) =>
  getJson<LiveResponse>("/api/live", signal);

function TargetPage({ page }: { page: Extract<Page, { kind: "target" }> }) {
  const targets = usePoll(loadTargets, 2000);
  const live = usePoll(loadLive, 1000);
  return (
    <>
      <header className="topbar">
        <TopBar
          page={page}
          targets={targets.data?.targets ?? []}
          live={live.data}
        />
        <SectionTabs />
      </header>
      <ErrorBanner
        health={live.data?.health}
        error={live.error ?? targets.error}
      />
      <main aria-label="Dashboard" />
    </>
  );
}

export function App() {
  const page = readPage();
  return page.kind === "target" ? <TargetPage page={page} /> : <FleetPage />;
}
