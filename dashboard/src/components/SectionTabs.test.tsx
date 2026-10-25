import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SectionTabs } from "./SectionTabs";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

// Pinned 9. Geometry and observer events are browser inputs to the component.
test("the current section follows scroll, hidden sections, resize and layout changes", () => {
  let resize: (() => void) | undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = () => {
          callback([], this);
        };
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  let sticky = true;
  vi.stubGlobal("getComputedStyle", () => ({
    position: sticky ? "sticky" : "static",
  }));
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(
    6000,
  );
  vi.stubGlobal("innerHeight", 800);
  vi.stubGlobal("scrollY", 0);
  const entries = [
    { id: "overview", label: "Summary" },
    { id: "threads-section", label: "Threads" },
    { id: "collector-settings", label: "Settings" },
  ];
  const { container } = render(
    <>
      <header className="topbar" />
      <SectionTabs entries={entries} />
      <main>
        {entries.map((entry) => (
          <section key={entry.id} id={entry.id} />
        ))}
      </main>
    </>,
  );
  const header = container.querySelector("header");
  if (!header) throw Error("Missing header");
  vi.spyOn(header, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 0, 60),
  );
  let tops = [100, 1000, 5000];
  let hidden = false;
  entries.forEach((entry, index) => {
    const section = document.getElementById(entry.id);
    if (!section) throw Error(entry.id);
    vi.spyOn(section, "getBoundingClientRect").mockImplementation(
      () => new DOMRect(0, tops[index]),
    );
    vi.spyOn(section, "getClientRects").mockImplementation(() =>
      Object.assign(hidden && index === 1 ? [] : [new DOMRect()], {
        item: () => null,
      }),
    );
  });
  const flush = () => {
    act(() => {
      while (frames.length) frames.shift()?.(0);
    });
  };
  const active = () =>
    container.querySelector('[aria-current="location"]')?.getAttribute("href");
  flush();
  expect(active()).toBe("#overview");
  expect(
    document.documentElement.style.getPropertyValue("--header-offset"),
  ).toBe("76px");
  tops = [-1000, -20, 500];
  fireEvent.scroll(window);
  flush();
  expect(active()).toBe("#threads-section");
  hidden = true;
  act(() => {
    resize?.();
  });
  flush();
  expect(active()).toBe("#overview");
  hidden = false;
  sticky = false;
  fireEvent.resize(window);
  flush();
  expect(
    document.documentElement.style.getPropertyValue("--header-offset"),
  ).toBe("16px");
  vi.stubGlobal("scrollY", 5200);
  fireEvent.scroll(window);
  flush();
  expect(active()).toBe("#collector-settings");
  vi.stubGlobal("scrollY", 0);
  tops = [-1000, 100, 1000];
  fireEvent(window, new HashChangeEvent("hashchange"));
  flush();
  expect(active()).toBe("#overview");
});
