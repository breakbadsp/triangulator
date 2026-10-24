import { useState, type CSSProperties } from "react";
import type { LiveResponse } from "../api/types";
import { Help } from "../help/Help";
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
        summary={
          <Help topic="procinfo">
            <h3 id="process-title">Process details</h3>
          </Help>
        }
      >
        <Help topic="procinfo" as="div">
          <p id="process-sub" className="fold-note">
            What the target is. The sampler reads these once when it starts
            watching the process.
          </p>
        </Help>
        <dl id="process-facts" className="facts">
          {processFacts(info, now).map((fact) => (
            <Help
              key={fact.label}
              topic={fact.topic}
              as="div"
              className={fact.wide ? "wide" : undefined}
            >
              <dt className="help-fact">{fact.label}</dt>
              <dd
                className={fact.wide ? "wrap mono" : undefined}
                title={fact.value}
              >
                {fact.value}
              </dd>
            </Help>
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
          <Help topic="exitreason">
            <h3 id="exit-title">Last process exit</h3>
          </Help>
          <Help topic="exitreason">
            <span
              id="exit-reason"
              className="badge"
              style={{ "--lvl": `var(--${card.level})` } as CSSProperties}
            >
              {card.label}
            </span>
          </Help>
          <Help topic="exitreason">
            <span id="exit-brief" className="muted">
              {card.brief}
            </span>
          </Help>
        </summary>
        <Help topic="exitreason" as="div">
          <p id="exit-sub" className="muted">
            {card.sub}
          </p>
          <p id="exit-explain" className="profile">
            {card.explain}
          </p>
        </Help>
        <Help topic="exitstatus" as="div">
          <p id="exit-status" className="profile">
            {card.status}
          </p>
        </Help>
        {card.logRead && (
          <details id="exit-details">
            <summary>
              <Help topic="exitmessages">Kernel messages</Help>
            </summary>
            <pre id="exit-messages" className="exit-log mono">
              {card.messages}
            </pre>
          </details>
        )}
      </details>
    </section>
  );
}
