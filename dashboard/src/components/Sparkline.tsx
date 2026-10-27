import { memo, useMemo } from "react";
import type { CpuSample } from "../lib/series";
import { isNum } from "../lib/format";

/** A small line over a 12% wash, stretched to its box. Gaps are skipped. */
export const Sparkline = memo(function Sparkline({
  values,
  color,
  min = 0,
  width = 100,
  height = 30,
  className,
}: {
  values: readonly (number | null)[];
  color: string;
  min?: number;
  width?: number;
  height?: number;
  className?: string;
}) {
  const numbers = values.filter(isNum);
  let marks = null;
  if (numbers.length >= 2) {
    const max = Math.max(min, ...numbers) || 1,
      step = width / (values.length - 1);
    const points = values
      .map((value, index) =>
        isNum(value)
          ? `${(index * step).toFixed(1)},${(height - 2 - (value / max) * (height - 4)).toFixed(1)}`
          : null,
      )
      .filter(Boolean)
      .join(" ");
    marks = (
      <>
        <polygon
          points={`0,${String(height)} ${points} ${String(width)},${String(height)}`}
          fill={color}
          fillOpacity={0.12}
        />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth={1.6}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
      </>
    );
  }
  return (
    <svg
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      className={className}
    >
      {marks}
    </svg>
  );
});

/**
 * A thread's CPU line. The samples array changes only when the thread gets a
 * new sample, so a redraw for another reason (hover, sort, selection) keeps
 * the same values and skips the SVG.
 */
export function CpuSparkline({
  samples,
  className,
}: {
  samples: readonly CpuSample[];
  className?: string;
}) {
  const values = useMemo(() => samples.map((sample) => sample.v), [samples]);
  return (
    <Sparkline
      className={className}
      values={values}
      color="var(--series-1)"
      min={5}
    />
  );
}
