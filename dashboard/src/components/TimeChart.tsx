import {
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { GuideContext, registerGuideChart } from "../help/guideContext";
import { useHeld } from "../hooks/useHeld";
import { Help, type Readout } from "../help/Help";
import type { HelpTopicId } from "../help/topics";
import { niceMax, segments } from "../lib/chart";
import { clock, isNum, num } from "../lib/format";

export interface ChartSeries<P> {
  label: string;
  color: string;
  get: (point: P) => number | null | undefined;
  format?: (value: unknown) => string;
}
const PAD = { l: 52, r: 14, t: 10, b: 22 };

/**
 * A time-series chart drawn at the host's pixel width. Stacked charts fill
 * bands; others draw a 2px line over a 12% wash. Gaps over 3.5 sample steps
 * break the line. Hover snaps a crosshair to the nearest sample, and the help
 * card lists every series there.
 */
interface TimeChartProps<P extends { t: number }> {
  id?: string;
  topic: HelpTopicId;
  points: readonly P[];
  series: readonly ChartSeries<P>[];
  stacked?: boolean;
  overlay?: ChartSeries<P> | null;
  format?: (value: unknown) => string;
  height?: number;
  minMax?: number;
  nice?: (value: number) => number;
  from?: number | undefined;
  to?: number | undefined;
  empty?: string;
}
export function TimeChart<P extends { t: number }>(props: TimeChartProps<P>) {
  const chartKey = useId();
  const guide = useContext(GuideContext);
  const held = useHeld(props, guide?.request?.chart?.key === chartKey);
  return <Chart {...held} chartKey={chartKey} />;
}
function Chart<P extends { t: number }>({
  id,
  topic,
  points,
  series,
  stacked = false,
  overlay = null,
  format = num,
  height = 160,
  minMax = 0,
  nice = niceMax,
  from,
  to,
  empty = "Collecting data…",
  chartKey,
}: TimeChartProps<P> & { chartKey: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    return registerGuideChart(element, () => {
      const columns = overlay ? [...series, overlay] : series;
      return {
        key: chartKey,
        headers: ["Time", ...columns.map((item) => item.label)],
        rows: points.map((point) => [
          clock(point.t),
          ...columns.map((item) => {
            const value = item.get(point);
            return isNum(value)
              ? (item.format ?? format)(value)
              : "Not available";
          }),
        ]),
      };
    });
  }, [chartKey, points, series, overlay, format]);

  // The hovered sample's time, not the pointer's x: a live update moves the
  // axis, and the readout must stay on the sample the reader chose.
  const [hover, setHover] = useState<{
    at: number;
    point: { x: number; y: number } | null;
  } | null>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      setWidth(Math.max(240, element.clientWidth || 600));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  let body: ReactNode, readout: Readout | undefined;
  if (points.length < 2) {
    body = (
      <div className="chart-empty" style={{ height }}>
        {empty}
      </div>
    );
  } else {
    const plotW = width - PAD.l - PAD.r,
      plotH = height - PAD.t - PAD.b;
    const t0 = from ?? points[0]?.t ?? 0,
      t1 = to ?? points.at(-1)?.t ?? 0;
    const x = (t: number) =>
      PAD.l + (t1 > t0 ? (t - t0) / (t1 - t0) : 0.5) * plotW;
    let max = minMax;
    for (const point of points) {
      if (stacked) {
        let sum = 0;
        for (const item of series) sum += item.get(point) || 0;
        max = Math.max(max, sum);
      } else
        for (const item of series) {
          const value = item.get(point);
          if (isNum(value)) max = Math.max(max, value);
        }
      const value = overlay?.get(point);
      if (isNum(value)) max = Math.max(max, value);
    }
    const nearest = (t: number) => {
      let best = 0;
      points.forEach((point, index) => {
        if (Math.abs(point.t - t) < Math.abs((points[best]?.t ?? 0) - t))
          best = index;
      });
      return points[best] as P;
    };
    const top = nice(max),
      y = (value: number) => PAD.t + (1 - value / top) * plotH;
    const marks: ReactNode[] = [];
    for (const fraction of [0, 0.5, 1]) {
      const py = y(top * fraction);
      marks.push(
        <line
          key={`grid${String(fraction)}`}
          x1={PAD.l}
          x2={width - PAD.r}
          y1={py}
          y2={py}
          stroke={fraction ? "var(--grid)" : "var(--axis)"}
          strokeWidth={1}
        />,
        <text
          key={`value${String(fraction)}`}
          x={PAD.l - 8}
          y={py + 4}
          textAnchor="end"
          className="axis-label"
        >
          {format(top * fraction)}
        </text>,
      );
    }
    for (const [t, anchor] of [
      [t0, "start"],
      [(t0 + t1) / 2, "middle"],
      [t1, "end"],
    ] as const)
      marks.push(
        <text
          key={`time${anchor}`}
          x={x(t)}
          y={height - 5}
          textAnchor={anchor}
          className="axis-label"
        >
          {clock(t)}
        </text>,
      );
    const unknown = (point: P) =>
      stacked && series.every((item) => !isNum(item.get(point)));
    const runs = segments(points, unknown);
    const line = (run: readonly P[], get: (point: P) => number) =>
      run.map((point) => `${String(x(point.t))},${String(y(get(point)))}`);
    if (stacked) {
      runs.forEach((segment, index) => {
        if (segment.length < 2) return;
        const base = segment.map(() => 0);
        series.forEach((item, band) => {
          const upper = segment.map(
            (point, i) => (base[i] ?? 0) + (item.get(point) || 0),
          );
          if (upper.some((value, i) => value > (base[i] ?? 0)))
            marks.push(
              <polygon
                key={`band${String(index)}-${String(band)}`}
                points={segment
                  .map(
                    (point, i) =>
                      `${String(x(point.t))},${String(y(upper[i] ?? 0))}`,
                  )
                  .concat(
                    segment
                      .map(
                        (point, i) =>
                          `${String(x(point.t))},${String(y(base[i] ?? 0))}`,
                      )
                      .reverse(),
                  )
                  .join(" ")}
                fill={item.color}
                stroke="var(--surface)"
                strokeWidth={1}
                strokeLinejoin="round"
              />,
            );
          upper.forEach((value, i) => (base[i] = value));
        });
      });
      if (overlay)
        runs.forEach((segment, index) => {
          const run = segment.filter((point) => isNum(overlay.get(point)));
          if (run.length > 1)
            marks.push(
              <polyline
                key={`overlay${String(index)}`}
                points={line(run, (point) => overlay.get(point) ?? 0).join(" ")}
                fill="none"
                stroke={overlay.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />,
            );
        });
    } else {
      series.forEach((item, band) => {
        runs.forEach((segment, index) => {
          let run: P[] = [],
            part = 0;
          const flush = () => {
            const key = `${String(band)}-${String(index)}-${String(part++)}`;
            const first = run[0],
              last = run.at(-1);
            if (run.length > 1 && first && last) {
              const points = line(run, (point) => item.get(point) ?? 0).join(
                " ",
              );
              if (series.length === 1)
                marks.push(
                  <polygon
                    key={`wash${key}`}
                    points={`${String(x(first.t))},${String(y(0))} ${points} ${String(x(last.t))},${String(y(0))}`}
                    fill={item.color}
                    fillOpacity={0.12}
                  />,
                );
              marks.push(
                <polyline
                  key={`line${key}`}
                  points={points}
                  fill="none"
                  stroke={item.color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />,
              );
            } else if (first)
              marks.push(
                <circle
                  key={`dot${key}`}
                  cx={x(first.t)}
                  cy={y(item.get(first) ?? 0)}
                  r={2.5}
                  fill={item.color}
                />,
              );
            run = [];
          };
          for (const point of segment) {
            if (isNum(item.get(point))) run.push(point);
            else flush();
          }
          flush();
        });
      });
    }

    // Hover layer: a crosshair at the nearest sample, a dot for each series.
    let hoverMarks: ReactNode = null;
    if (hover) {
      const point = nearest(hover.at),
        cx = x(point.t);
      const dots: ReactNode[] = [];
      let sum = 0;
      const rows = series.map((item, index) => {
        const value = item.get(point);
        let cy: number | null = null;
        if (stacked) {
          sum += value || 0;
          cy = y(sum);
        } else if (isNum(value)) cy = y(value);
        if (cy !== null && (!stacked || value))
          dots.push(
            <circle
              key={String(index)}
              cx={cx}
              cy={cy}
              r={4}
              fill={item.color}
              stroke="var(--surface)"
              strokeWidth={2}
            />,
          );
        return {
          color: item.color,
          value: (item.format ?? format)(value),
          label: item.label,
        };
      });
      const shown = stacked
        ? rows.reverse().filter((_, index) => {
            const value = series.at(-1 - index)?.get(point);
            return !isNum(value) || value !== 0;
          })
        : rows;
      const value = overlay?.get(point);
      if (overlay && isNum(value)) {
        dots.push(
          <circle
            key="overlay"
            cx={cx}
            cy={y(value)}
            r={4}
            fill={overlay.color}
            stroke="var(--surface)"
            strokeWidth={2}
          />,
        );
        shown.unshift({
          color: overlay.color,
          value: format(value),
          label: overlay.label,
        });
      }
      hoverMarks = (
        <>
          <line
            x1={cx}
            x2={cx}
            y1={PAD.t}
            y2={PAD.t + plotH}
            stroke="var(--muted)"
            strokeWidth={1}
          />
          <g>{dots}</g>
        </>
      );
      if (hover.point)
        readout = {
          key: `${id ?? topic}|${String(point.t)}`,
          title: clock(point.t),
          rows: shown,
          stamp: point.t,
          point: hover.point,
        };
    }
    body = (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${String(width)} ${String(height)}`}
      >
        {marks}
        {hoverMarks}
        <rect
          x={PAD.l}
          y={0}
          width={plotW}
          height={height}
          fill="transparent"
          onPointerMove={(event) => {
            const box =
              event.currentTarget.ownerSVGElement?.getBoundingClientRect();
            // Touch and drags move the crosshair but open no card.
            const px = event.clientX - (box?.left ?? 0);
            setHover({
              at: nearest(t0 + ((px - PAD.l) / plotW) * (t1 - t0)).t,
              point:
                event.buttons || event.pointerType === "touch"
                  ? null
                  : { x: event.clientX, y: event.clientY },
            });
          }}
          onPointerLeave={() => {
            setHover(null);
          }}
        />
      </svg>
    );
  }
  return (
    <Help topic={topic} as="div" readout={readout}>
      <div ref={host} id={id} className="chart">
        {body}
      </div>
    </Help>
  );
}
