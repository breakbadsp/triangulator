import type { ViewMode } from "../lib/assess";
import { date, num } from "../lib/format";
import { useEffect, useState } from "react";
import type { LiveResponse, Target } from "../api/types";
import { markDeparture } from "../api/viewStorage";
import { Help } from "../help/Help";
import type { Page } from "../page";

import { backHref } from "../lib/fleet";
import { viewTargetName } from "../lib/target";

type Theme = "auto" | "light" | "dark";
function readTheme(): Theme {
  try {
    const saved = localStorage.getItem("triangulator:theme");
    return saved === "light" || saved === "dark" ? saved : "auto";
  } catch {
    return "auto";
  }
}

export function TopBar({
  page,
  targets,
  live,
  mode = { kind: "live" },
  now = 0,
  onLive,
}: {
  page: Page;
  targets: readonly Target[];
  live?: LiveResponse;
  mode?: ViewMode;
  now?: number;
  onLive?: () => void;
}) {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    if (theme === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("triangulator:theme", theme);
    } catch {
      /* The selection still works when browser storage is unavailable. */
    }
  }, [theme]);

  const ordered = [...targets].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  const chosen =
    page.kind === "target"
      ? (ordered.find((target) => target.key === page.key) ??
        (!page.key
          ? (ordered.find((target) => target.id === "default") ?? ordered[0])
          : undefined))
      : undefined;
  const unavailable = page.kind === "target" && !!page.key && !chosen;
  const hidePicker =
    page.kind === "target" && ordered.length <= 1 && !unavailable;
  const attention = ordered.filter(
    (target) =>
      target.key !== chosen?.key &&
      (target.status === "absent" ||
        target.status === "silent" ||
        target.throttled),
  ).length;
  const health = live?.health;
  const state =
    mode.kind === "recorded"
      ? "Historical"
      : mode.kind === "final"
        ? "Stopped reporting"
        : health?.sampler_silent
          ? "Sampler silent"
          : health?.target_absent
            ? "Target absent"
            : health?.last_seen
              ? "Live"
              : "Waiting";
  const targetName = !health
    ? "Connecting…"
    : health.target_absent === null
      ? "No target yet"
      : viewTargetName(live);
  useEffect(() => {
    if (page.kind === "target")
      document.title = `${health?.pid ? `${targetName} · ` : ""}Thread monitor`;
    document.documentElement.dataset.page = page.kind;
  }, [page.kind, health?.pid, targetName]);

  function navigate(key: string) {
    // The destination starts fresh: its saved view may be from another visit.
    if (key && page.kind === "target" && key !== page.key)
      markDeparture(page.key, key);
    const query = new URLSearchParams(location.search);
    if (key) query.set("target", key);
    else query.delete("target");
    location.assign(
      location.pathname + (query.size ? `?${query.toString()}` : ""),
    );
  }

  return (
    <div className="topbar-inner">
      {page.kind === "target" && (
        <Help topic="fleet">
          <a
            id="fleet-back"
            className="fleet-back"
            href={backHref(location.search)}
          >
            ← All targets
          </a>
        </Help>
      )}
      <div className="target">
        <Help topic="target-switch" className="target-choice">
          <select
            id="target-select"
            hidden={hidePicker}
            aria-label="Selected monitoring target"
            value={page.kind === "fleet" ? "" : (chosen?.key ?? page.key)}
            onChange={(event) => {
              navigate(event.currentTarget.value);
            }}
          >
            <option value="">All targets</option>
            {page.kind === "target" && page.key && !chosen && (
              <option value={page.key}>Selected target unavailable</option>
            )}
            {ordered.map((target) => (
              <option key={target.key} value={target.key}>
                {target.status === "live" ? "●" : "○"} {target.host} ·{" "}
                {target.id}
                {target.process?.command
                  ? ` · ${target.process.command.split(" ")[0] ?? ""}`
                  : ""}
                {target.pid ? ` · PID ${String(target.pid)}` : ""} ·{" "}
                {target.status}
                {target.access === "limited" ? " · Limited access" : ""}
                {target.throttled ? " · Sampler throttled" : ""}
              </option>
            ))}
          </select>
          <span id="target-key" hidden={!hidePicker}>
            {chosen
              ? `${chosen.host} · ${chosen.id}`
              : page.kind === "target"
                ? page.key
                : ""}
          </span>
        </Help>
        {page.kind === "target" && attention > 0 && (
          <Help topic="target-attention">
            <span id="target-attention" className="target-badge">
              {attention} other target{attention === 1 ? " needs" : "s need"}{" "}
              attention
            </span>
          </Help>
        )}
        {page.kind === "target" && chosen?.access === "limited" && (
          <Help topic="target-access">
            <span id="target-access" className="target-badge">
              Limited access
            </span>
          </Help>
        )}
        {page.kind === "target" && chosen?.throttled && (
          <Help topic="sampler-budget">
            <span id="target-budget" className="target-badge">
              Sampler throttled ·{" "}
              <span id="target-budget-value">
                {num(chosen.effective_rate_hz, 2)} Hz
              </span>{" "}
              · CPU {num(chosen.sampler_cpu_pct, 2)}% of one core; budget{" "}
              {num(chosen.cpu_budget_pct, 2)}%
            </span>
          </Help>
        )}
        {page.kind === "target" && (
          <>
            <Help topic="health">
              <span
                aria-label={state}
                className={`status-dot ${mode.kind === "recorded" ? "warning" : mode.kind === "final" || health?.sampler_silent || health?.target_absent ? "critical" : health?.last_seen ? "live" : "warning"}`}
              />
            </Help>
            <Help topic="target">
              <strong id="target-name">{targetName}</strong>
            </Help>
            <Help topic="health">
              <span id="target-meta" className="muted">
                {health?.pid ? `PID ${String(health.pid)} · ` : ""}
                {state}
                {mode.kind === "final" ? ` · at ${date(now)}` : ""}
              </span>
            </Help>
          </>
        )}
      </div>
      {mode.kind === "recorded" && (
        <Help topic="timeline">
          <button
            id="history-pill"
            type="button"
            onClick={onLive}
            aria-label={`Viewing the recording at ${date(now)}. Back to live`}
          >
            {date(now)} · Back to live
          </button>
        </Help>
      )}
      <Help topic="appearance" className="theme-picker">
        <label htmlFor="theme">Theme</label>
        <select
          id="theme"
          aria-label="Color theme"
          value={theme}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setTheme(value === "light" || value === "dark" ? value : "auto");
          }}
        >
          <option value="auto">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </Help>
    </div>
  );
}
