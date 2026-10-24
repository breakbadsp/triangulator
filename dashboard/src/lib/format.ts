export const isNum = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
export const pct = (value: unknown) =>
  !isNum(value)
    ? "—"
    : (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(1)) + "%";
const compact = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});
export const num = (value: unknown, digits = 1) =>
  !isNum(value)
    ? "—"
    : Math.abs(value) >= 10000
      ? compact.format(value)
      : value.toFixed(digits);
export const bytes = (value: unknown) => {
  if (!isNum(value)) return "—";
  if (value > 0 && value < 1) return "<1 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  while (Math.abs(value) >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return value.toFixed(index ? 1 : 0) + " " + String(units[index]);
};
export const perSec = (value: unknown) =>
  isNum(value) ? bytes(value) + "/s" : "—";
export const date = (value: number) => new Date(value * 1000).toLocaleString();
export const clock = (value: number) =>
  new Date(value * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
export const duration = (seconds: number) =>
  seconds < 90
    ? String(Math.max(1, Math.round(seconds))) + " s"
    : seconds < 5400
      ? String(Math.round(seconds / 60)) + " min"
      : (seconds / 3600).toFixed(1) + " h";
export const ago = (seconds: unknown) =>
  !isNum(seconds)
    ? "never"
    : seconds < 2
      ? "just now"
      : seconds < 90
        ? String(Math.round(seconds)) + " s ago"
        : seconds < 5400
          ? String(Math.round(seconds / 60)) + " min ago"
          : String(Math.round(seconds / 3600)) + " h ago";
export const memoryBytes = (value: unknown) =>
  bytes(value).replace(/\b(K|M|G|T)B\b/g, "$1iB");
export const signed = (value: number) =>
  (value > 0 ? "+" : value < 0 ? "−" : "") + memoryBytes(Math.abs(value));
