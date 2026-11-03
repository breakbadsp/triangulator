import type { LiveResponse } from "../api/types";

export function ErrorBanner({
  health,
  error,
}: {
  health?: LiveResponse["health"];
  error?: Error;
}) {
  const message = health?.sampler_silent
    ? "⚠ Sampler is silent. Displayed thread data may be stale."
    : error
      ? "⚠ Collector unavailable. Displayed data is stale."
      : undefined;
  if (!message) return null;
  return (
    <div id="error" className="banner" role="status" data-help="health">
      {message}
    </div>
  );
}
