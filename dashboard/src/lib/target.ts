import type { LiveResponse, Target } from "../api/types";
import { endedTarget } from "./exit";
export function viewTargetName(view: Partial<LiveResponse>) {
  const health = view.health;
  return (
    (view.threads || []).find((thread) => thread.tid === health?.pid)?.name ||
    (health?.pid
      ? "PID " + String(health.pid)
      : endedTarget(view)?.name || "the target")
  );
}
export function fleetName(target: Target, view?: Partial<LiveResponse>) {
  const main = view?.threads?.find(
    (thread) => thread.tid === view.health?.pid,
  )?.name;
  return (
    main ||
    target.process?.command.split(" ")[0]?.split("/").pop() ||
    endedTarget(view || {})?.name ||
    target.id
  );
}
