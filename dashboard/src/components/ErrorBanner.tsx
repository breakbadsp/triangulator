import type { LiveResponse } from "../api/types";
import { Help } from "../help/Help";

export function ErrorBanner({
  health,
  error,
}: {
  health?: LiveResponse["health"];
  error?: Error;
}) {
  const message = health?.sampler_silent
    ? "⚠ Sampler is silent. Displayed thread data may be stale."
    : error?.message;
  if (!message) return null;
  return (
    <div id="error" className="banner" role="status" data-help="health">
      <Help topic="health">{message}</Help>
    </div>
  );
}
