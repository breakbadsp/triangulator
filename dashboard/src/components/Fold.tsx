import { useState, type ReactNode } from "react";

const foldKey = (name: string) => `triangulator:fold:${name}`;
// Remembered in memory too, so a panel stays closed when storage is blocked.
const chosen = new Map<string, boolean>();
function savedChoice(name: string) {
  const choice = chosen.get(name);
  if (choice !== undefined) return choice;
  try {
    const saved = localStorage.getItem(foldKey(name));
    return saved === "open" ? true : saved === "closed" ? false : null;
  } catch {
    return null;
  }
}

/**
 * A folded panel (details[data-fold]) that keeps the open or closed choice
 * the user last made. Until then, it opens by itself while `autoOpen` is
 * true. It never closes by itself, so the page does not jump while someone
 * reads it.
 */
export function Fold({
  name,
  summary,
  children,
  autoOpen = false,
  className = "fold",
  summaryClassName = "fold-summary",
}: {
  name: string;
  summary: ReactNode;
  children: ReactNode;
  autoOpen?: boolean;
  className?: string;
  summaryClassName?: string;
}) {
  const [open, setOpen] = useState(() => savedChoice(name) === true);
  if (autoOpen && !open && savedChoice(name) === null) setOpen(true);
  return (
    <details
      className={className}
      data-fold={name}
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
      }}
    >
      <summary
        className={summaryClassName}
        onClick={(event) => {
          // A click or key on the summary is the user's choice; an automatic
          // open is not.
          event.preventDefault();
          const next = !open;
          chosen.set(name, next);
          try {
            localStorage.setItem(foldKey(name), next ? "open" : "closed");
          } catch {
            /* The choice still holds in memory. */
          }
          setOpen(next);
        }}
      >
        {summary}
      </summary>
      {children}
    </details>
  );
}
