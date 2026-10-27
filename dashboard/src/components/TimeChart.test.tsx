import { HELP_DELAY } from "../help/createHelpTimer";
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
const element = (data: typeof points) => (
  <TimeChart
    id="chart-test"
    topic="load"
    points={data}
    series={[
      { label: "A", color: "red", get: (point) => point.a },
      { label: "B", color: "blue", get: (point) => point.b },
    ]}
  />
);
function chart() {
  const { container } = render(element(points));
  return container.querySelector("rect") as SVGRectElement;
}
const wait = () => {
  act(() => {
    vi.advanceTimersByTime(HELP_DELAY);
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

test("a live update under a still pointer keeps the sample and its delay", () => {
  const { container, rerender } = render(element(points));
  const hit = container.querySelector("rect") as SVGRectElement;
  // x=200 is nearest to t=0 now, but nearest to t=10 once t=20 stretches the axis.
  fireEvent.pointerMove(hit, { clientX: 200, clientY: 40 });
  act(() => {
    vi.advanceTimersByTime(HELP_DELAY / 2);
  });
  rerender(element([...points, { t: 20, a: 5, b: 6 }]));
  act(() => {
    vi.advanceTimersByTime(HELP_DELAY / 2);
  });
  expect(readings()).toEqual(["1.0A", "2.0B"]);
});

test("the pointer can move from the chart into its readout card", () => {
  const hit = chart();
  fireEvent.pointerMove(hit, { clientX: 60, clientY: 40 });
  wait();
  const card = screen.getByRole("dialog");
  fireEvent.pointerLeave(hit);
  // The pointer goes from the chart straight into the card, as in a browser.
  fireEvent.mouseOut(hit, { relatedTarget: card });
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(screen.getByRole("dialog")).toBe(card);
  expect(readings()).toEqual(["1.0A", "2.0B"]);
});

test("the readout card stays inside the viewport at its measured height", () => {
  const measure = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const height = this.classList.contains("help-card") ? 400 : 0;
      return {
        height,
        width: 380,
        top: 0,
        left: 0,
        right: 380,
        bottom: height,
      } as DOMRect;
    });
  try {
    const hit = chart();
    fireEvent.pointerMove(hit, { clientX: 60, clientY: 650 });
    wait();
    expect(screen.getByRole("dialog").style.top).toBe(
      `${String(innerHeight - 400 - 12)}px`,
    );
  } finally {
    measure.mockRestore();
  }
});

test("a hover moves the crosshair without drawing the chart again", () => {
  const many = Array.from({ length: 400 }, (_, index) => ({
    t: index,
    a: index,
    b: 1,
  }));
  const get = vi.fn((point: { a: number }) => point.a);
  const series = [{ label: "A", color: "red", get }];
  const { container } = render(
    <TimeChart id="scene" topic="load" points={many} series={series} />,
  );
  const hit = container.querySelector("rect") as SVGRectElement;
  const drawn = get.mock.calls.length;
  expect(drawn).toBeGreaterThanOrEqual(many.length);
  for (let move = 0; move < 10; move++)
    fireEvent.pointerMove(hit, { clientX: 60 + move * 50, clientY: 40 });
  // Each hover reads the hovered sample, not the whole series.
  expect(get.mock.calls.length - drawn).toBeLessThan(many.length);
});
