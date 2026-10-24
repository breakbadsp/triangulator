import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { TimeChart } from "./TimeChart";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
const points = [
  { t: 0, a: 1, b: 2 },
  { t: 10, a: 3, b: null },
];
// jsdom has no layout: the chart is 600 px wide and its plot starts at 52 px,
// so sample t=0 is at x=52 and sample t=10 at x=586.
function chart() {
  const { container } = render(
    <TimeChart
      id="chart-test"
      topic="load"
      points={points}
      series={[
        { label: "A", color: "red", get: (point) => point.a },
        { label: "B", color: "blue", get: (point) => point.b },
      ]}
    />,
  );
  return container.querySelector("rect") as SVGRectElement;
}
const wait = () => {
  act(() => {
    vi.advanceTimersByTime(1200);
  });
};
const readings = () =>
  [...screen.getByRole("dialog").querySelectorAll(".help-reading")].map(
    (row) => row.textContent,
  );

test("the chart readout follows the pointer to each sample", () => {
  const hit = chart();
  fireEvent.pointerMove(hit, { clientX: 60, clientY: 40 });
  expect(screen.queryByRole("dialog")).toBeNull();
  wait();
  expect(readings()).toEqual(["1.0A", "2.0B"]);
  expect(screen.getByRole("dialog").style.left).toBe("68px");
  expect(screen.getByRole("dialog").style.top).toBe("40px");
  // A move inside the same sample keeps the card open.
  fireEvent.pointerMove(hit, { clientX: 70, clientY: 50 });
  expect(readings()).toEqual(["1.0A", "2.0B"]);
  // The next sample is a new request with its own delay and place.
  fireEvent.pointerMove(hit, { clientX: 900, clientY: 30 });
  wait();
  expect(readings()).toEqual(["3.0A", "Not availableB"]);
  const left = Number.parseFloat(screen.getByRole("dialog").style.left);
  // 908 + 380 would overflow the 1024 px viewport, so the card is on the left.
  expect(left).toBe(900 - 380 - 8);
  expect(screen.getByRole("dialog").style.top).toBe("30px");
});

test("a drag moves the crosshair but opens no readout", () => {
  const hit = chart();
  fireEvent.pointerMove(hit, { clientX: 60, clientY: 40, buttons: 1 });
  wait();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(
    hit.ownerSVGElement?.querySelector("line[stroke='var(--muted)']"),
  ).not.toBeNull();
});
