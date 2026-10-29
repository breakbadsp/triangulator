import { useEffect, useRef, useState } from "react";
import { Help } from "../help/Help";

export interface Section {
  id: string;
  label: string;
}
export const sections: readonly Section[] = [
  { id: "timeline", label: "Timeline" },
  { id: "overview", label: "Summary" },
  { id: "threads-section", label: "Threads" },
  { id: "resources", label: "Resources" },
  { id: "memory-map", label: "Memory" },
  { id: "monitor", label: "Monitor" },
  { id: "collector-settings", label: "Settings" },
];

export function SectionTabs({
  entries = sections,
  onSelect,
}: {
  entries?: readonly Section[];
  /** A tab was selected, even the current one. */
  onSelect?: (id: string) => void;
}) {
  const [current, setCurrent] = useState(
    location.hash.slice(1) || entries[0]?.id,
  );
  // The browser handles the fragment of a fresh load before React creates
  // the sections, so it finds none. The page scrolls to that section, and
  // again each time the header or the sections above it change size, until
  // the user scrolls. A `#thread=` fragment is not a section; App handles it.
  const fragment = useRef<string | null>(null);
  useEffect(() => {
    const id = location.hash.slice(1);
    if (!entries.some((section) => section.id === id)) return;
    fragment.current = id;
    const events = ["wheel", "touchstart", "keydown", "pointerdown"];
    function release() {
      fragment.current = null;
    }
    for (const name of events) addEventListener(name, release, true);
    return () => {
      for (const name of events) removeEventListener(name, release, true);
    };
    // Only the fragment of the first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!entries.length) return;
    let frame: number | undefined;
    function update() {
      frame = undefined;
      const header = document.querySelector(".topbar");
      const line =
        (header && getComputedStyle(header).position === "sticky"
          ? header.getBoundingClientRect().bottom
          : 0) + 16;
      document.documentElement.style.setProperty(
        "--header-offset",
        `${String(line)}px`,
      );
      if (fragment.current)
        document.getElementById(fragment.current)?.scrollIntoView();
      let active = entries[0]?.id;
      for (const section of entries) {
        const element = document.getElementById(section.id);
        if (
          element?.getClientRects().length &&
          element.getBoundingClientRect().top <= line + 1
        )
          active = section.id;
      }
      if (
        scrollY > 0 &&
        Math.ceil(scrollY + innerHeight) >=
          document.documentElement.scrollHeight
      )
        active = entries.at(-1)?.id;
      setCurrent(active);
    }
    function schedule() {
      if (frame === undefined) frame = requestAnimationFrame(update);
    }
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule);
    addEventListener("hashchange", schedule);
    const observer = new ResizeObserver(schedule);
    const main = document.querySelector("main");
    const header = document.querySelector(".topbar");
    if (main) observer.observe(main);
    if (header) observer.observe(header);
    schedule();
    return () => {
      removeEventListener("scroll", schedule);
      removeEventListener("resize", schedule);
      removeEventListener("hashchange", schedule);
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [entries]);
  if (!entries.length) return null;
  return (
    <Help topic="section-navigation" as="div">
      <nav className="tabs" aria-label="Sections">
        {entries.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            aria-current={current === section.id ? "location" : undefined}
            onClick={() => onSelect?.(section.id)}
          >
            {section.label}
          </a>
        ))}
      </nav>
    </Help>
  );
}
