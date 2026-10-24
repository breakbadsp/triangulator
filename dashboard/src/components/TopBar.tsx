import { useEffect, useState } from "react";
import type { LiveResponse, Target } from "../api/types";
import { Help } from "../help/Help";
import type { Page } from "../page";

import { clearViewCaches } from "../hooks/useSeries";
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
}: {
  page: Page;
  targets: readonly Target[];
  live?: LiveResponse;
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
  const health = live?.health;
  const state = health?.sampler_silent
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
      for (const target of [page.key, key]) clearViewCaches(target);
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
              </option>
            ))}
          </select>
        </Help>
        {page.kind === "target" && (
          <>
            <Help topic="health">
              <span
                aria-label={state}
                className={`status-dot ${health?.sampler_silent || health?.target_absent ? "critical" : health?.last_seen ? "live" : "warning"}`}
              />
            </Help>
            <Help topic="target">
              <strong id="target-name">{targetName}</strong>
            </Help>
            <Help topic="health">
              <span id="target-meta" className="muted">
                {health?.pid ? `PID ${String(health.pid)} · ` : ""}
                {state}
              </span>
            </Help>
          </>
        )}
      </div>
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
