import type { LiveResponse } from "../api/types";
import { Help } from "../help/Help";
import type { HelpTopicId } from "../help/topics";
import { useHeld, useHolding } from "../hooks/useHeld";
import { monitorFindings } from "../lib/assess";
import { wantsFold } from "../lib/findings";
import { ago, num, pct } from "../lib/format";
import { Fold } from "./Fold";
import "./monitor.css";

type HealthRow = readonly [label: string, topic: HelpTopicId, value: string];

function healthRows(health: LiveResponse["health"], now: number): HealthRow[] {
  return [
    [
      "Sampler",
      "health",
      health.sampler_silent
        ? "Silent"
        : health.last_seen
          ? "Connected"
          : "Waiting",
    ],
    ["Last data", "health", ago(now - (health.last_seen || 0))],
    ["Sample interval", "interval", `${String(health.sample_interval_ms)} ms`],
    ["Packet loss (1 min)", "loss", pct(health.packet_loss_pct)],
    [
      "Bad · duplicate · late",
      "packetcounts",
      `${String(health.bad_packets)} · ${String(health.duplicates)} · ${String(health.late_packets)}`,
    ],
    ["Raw samples held", "rawsamples", num(health.raw_samples, 0)],
    ["Sampler address", "health", health.sampler_ip || "—"],
    ["Session", "session", health.session || "—"],
  ];
}

/**
 * The Monitor section: whether the data is trustworthy. Every help anchor
 * is keyed by the process identity, so a new session starts fresh.
 */
export function Monitor({
  view,
  now,
  context,
}: {
  view: LiveResponse | undefined;
  now: number;
  /** Target, session, and PID of the view. */
  context: string | null;
}) {
  const hold = useHolding();
  const rows = view ? healthRows(view.health, now) : [];
  // Under the pointer the rows stay still, but never show another process.
  const held = useHeld({ context, rows }, hold.holding);
  const shown = held.context === context ? held.rows : rows;
  const key = context ?? "";
  return (
    <section id="monitor" className="block">
      <div className="section-head">
        <Help key={key} topic="health" as="div">
          <h2>Monitor</h2>
        </Help>
      </div>
      <div className="card">
        <Fold
          name="health"
          autoOpen={
            !!view &&
            wantsFold(
              monitorFindings({ view, mode: { kind: "live" }, now }),
              "monitor",
            )
          }
          summary={
            <Help key={key} topic="health">
              <h3>Monitor health</h3>
            </Help>
          }
        >
          <Help key={key} topic="health" as="div">
            <p className="fold-note">
              Is the data trustworthy? Sampler link, packet loss and the
              collector&apos;s buffers.
            </p>
          </Help>
          <dl id="health" className="health-list" {...hold.handlers}>
            {shown.map(([label, topic, value]) => (
              <Help key={`${key}|${label}`} topic={topic} as="div">
                <dt className="help-fact">{label}</dt>
                <dd>{value}</dd>
              </Help>
            ))}
          </dl>
        </Fold>
      </div>
      <div className="notes">
        <details>
          <summary>
            <Help key={key} topic="health">
              Monitor diagnostics (raw health JSON)
            </Help>
          </summary>
          <pre id="diagnostics">
            {view ? JSON.stringify(view.health, null, 2) : ""}
          </pre>
        </details>
      </div>
    </section>
  );
}
