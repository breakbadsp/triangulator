import { memoryBytes } from "./format";

/** The smallest step × power of ten at or above value, for an axis top. */
export function niceMax(
  value: number,
  steps: readonly number[] = [1, 2, 2.5, 5, 10],
) {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of steps) if (value <= step * power) return step * power;
  return 10 * power;
}
// Byte axes round in binary units, so the top reads 500 MiB, not 476.8 MiB,
// and drop a trailing .0 so labels fit the axis. Byte axes skip the 2.5
// step: labels have one decimal, so half of 2.5 GiB would read 1.3 GiB.
export const axisBytes = (value: unknown) =>
  memoryBytes(value).replace(".0 ", " ");
export function niceBytes(value: number) {
  let unit = 1;
  while (value >= 1024 * unit && unit < 2 ** 40) unit *= 1024;
  const top = niceMax(value / unit, [1, 2, 5, 10]);
  return top >= 1000 && unit < 2 ** 40 ? 1024 * unit : unit * top;
}
export function medianStep(points: readonly { t: number }[]) {
  const steps: number[] = [];
  for (let index = 1; index < points.length; index++)
    steps.push((points[index]?.t ?? 0) - (points[index - 1]?.t ?? 0));
  steps.sort((a, b) => a - b);
  return steps[Math.floor(steps.length / 2)] || 1;
}
/**
 * Runs of points to draw as one line or band. A gap of more than 3.5 median
 * steps, or a point with no known value, ends a run.
 */
export function segments<T extends { t: number }>(
  points: readonly T[],
  unknown: (point: T) => boolean,
): T[][] {
  const gap = medianStep(points) * 3.5;
  const result: T[][] = [];
  let current: T[] = [];
  points.forEach((point, index) => {
    const previous = points[index - 1];
    if (unknown(point) || (previous && point.t - previous.t > gap)) {
      result.push(current);
      current = [];
    }
    if (!unknown(point)) current.push(point);
  });
  result.push(current);
  return result;
}
