import { useState, type CSSProperties } from "react";
import type { LiveResponse } from "../api/types";
import { exitCard, processFacts, viewProcess } from "../lib/summary";
import { Fold } from "./Fold";

// What the target is, from the sampler's one-time /proc reads. Info from
// another session is hidden rather than shown for the wrong process.
export function ProcessInfo({
  view,
  now,
}: {
  view: LiveResponse;
  now: number;
}) {
  const info = viewProcess(view);
  if (!info) return null;
  return (
    <section
      id="process-info"
      className="card"
      aria-labelledby="process-title"
      style={{ marginBottom: 14 }}
    >
      <Fold
        name="process"
        summary={<h3 id="process-title">Process details</h3>}
      >
        <p id="process-sub" className="fold-note">
          What the target is. The sampler reads these once when it starts
          watching the process.
        </p>

        <dl id="process-facts" className="facts">
          {processFacts(info, now).map((fact) => (
            <div key={fact.label} className={fact.wide ? "wide" : undefined}>
              <dt className="help-fact">{fact.label}</dt>
              <dd
                className={fact.wide ? "wrap mono" : undefined}
                title={fact.value}
              >
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      </Fold>
    </section>
  );
}

// Why the most recent target process ended. The card is open while its exit
// describes what the page shows; once another process is the target, it
// folds to one line. A reader's toggle stays until that state changes.
export function ProcessExit({
  view,
  now,
}: {
  view: LiveResponse;
  now: number;
}) {
  const ended = view.exit;
  const card = ended ? exitCard(ended, view, now) : null;
  const [choice, setChoice] = useState<{ key: string; open: boolean } | null>(
    null,
  );
  if (!card) return null;
  if (choice?.key !== card.key)
    setChoice({ key: card.key, open: card.current });
  const open = choice?.key === card.key ? choice.open : card.current;
  return (
    <section
      id="process-exit"
      className="card"
      aria-labelledby="exit-title"
      style={{ marginBottom: 14 }}
    >
      <details
        id="exit-card"
        open={open}
        onToggle={(event) => {
          setChoice({ key: card.key, open: event.currentTarget.open });
        }}
      >
        <summary className="exit-summary">
          <h3 id="exit-title">Last process exit</h3>

          <span
            id="exit-reason"
            className="badge"
            style={{ "--lvl": `var(--${card.level})` } as CSSProperties}
          >
            {card.label}
          </span>

          <span id="exit-brief" className="muted">
            {card.brief}
          </span>
        </summary>
        <div>
          <p id="exit-sub" className="muted">
            {card.sub}
          </p>
          <p id="exit-explain" className="profile">
            {card.explain}
          </p>
        </div>

        <p id="exit-status" className="profile">
          {card.status}
        </p>

        {card.logRead && (
          <details id="exit-details">
            <summary>Kernel messages</summary>
            <pre id="exit-messages" className="exit-log mono">
              {card.messages}
            </pre>
          </details>
        )}
      </details>
    </section>
  );
}
