import { useEffect, useState } from "react";
import { Help } from "../help/Help";

export interface Section {
  id: string;
  label: string;
}
export const sections: readonly Section[] = [
  { id: "overview", label: "Summary" },
  { id: "threads-section", label: "Threads" },
];

export function SectionTabs({
  entries = sections,
}: {
  entries?: readonly Section[];
}) {
  const [current, setCurrent] = useState(
    location.hash.slice(1) || entries[0]?.id,
  );
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
          >
            {section.label}
          </a>
        ))}
      </nav>
    </Help>
  );
}
