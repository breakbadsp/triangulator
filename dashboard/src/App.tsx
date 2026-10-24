import { getJson } from "./api/client";
import type { LiveResponse, TargetsResponse } from "./api/types";
import { ErrorBanner } from "./components/ErrorBanner";
import { SectionTabs } from "./components/SectionTabs";
import { TopBar } from "./components/TopBar";
import { Help } from "./help/Help";
import { usePoll } from "./hooks/usePoll";
import { readPage, type Page } from "./page";

const loadTargets = (signal: AbortSignal) =>
  getJson<TargetsResponse>("/api/targets", signal);
const loadLive = (signal: AbortSignal) =>
  getJson<LiveResponse>("/api/live", signal);

function TargetPage({
  page,
  targets,
  targetsError,
}: {
  page: Extract<Page, { kind: "target" }>;
  targets?: TargetsResponse;
  targetsError?: Error;
}) {
  const live = usePoll(loadLive, 1000);
  return (
    <>
      <header className="topbar">
        <TopBar page={page} targets={targets?.targets ?? []} live={live.data} />
        <SectionTabs />
      </header>
      <ErrorBanner
        health={live.data?.health}
        error={live.error ?? targetsError}
      />
      <main aria-label="Dashboard" />
    </>
  );
}

export function App() {
  const page = readPage();
  const targets = usePoll(loadTargets, 2000);
  if (page.kind === "target")
    return (
      <TargetPage
        page={page}
        targets={targets.data}
        targetsError={targets.error}
      />
    );
  return (
    <>
      <header className="topbar">
        <TopBar page={page} targets={targets.data?.targets ?? []} />
      </header>
      <ErrorBanner error={targets.error} />
      <main aria-label="Dashboard">
        <Help topic="fleet" as="div">
          <h1>Targets</h1>
        </Help>
      </main>
    </>
  );
}
