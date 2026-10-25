import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { getJson } from "../api/client";
import { parseReplay, type ReplayBounds } from "../api/replay";
import type {
  MemoryLayout,
  PressureScope,
  ResourceHistory,
} from "../api/types";
import { assessRecorded } from "../lib/assess";
import {
  asResourcePoints,
  RSS_TREND_WINDOWS,
  type ResourcePoint,
} from "../lib/assess/memory";
import { compatibleLayout } from "../lib/observation";
import {
  episodes,
  initialScan,
  PAST,
  planNewer,
  planOlder,
  scanReducer,
  type Batch,
  type Sample,
  type ScanAction,
} from "../lib/pastAssessments";

interface Judge {
  layout: MemoryLayout | null;
  pressureScope: PressureScope;
}

// Slot i covers (times[i] - step, times[i]]; a view from an earlier slot is a
// gap. An invalid recording is a gap too, as in the old page.
async function checkSlot(
  at: number,
  step: number,
  points: readonly ResourcePoint[],
  judge: Judge,
  signal: AbortSignal,
): Promise<Sample> {
  const raw = await getJson<unknown>(
    `/api/replay?${new URLSearchParams({ at: String(at), direction: "at" })}`,
    signal,
  );
  let view;
  try {
    view = parseReplay(raw).snapshot;
  } catch {
    return null;
  }
  if (!view || view.recorded_at <= at - step) return null;
  return {
    at: view.recorded_at,
    findings: assessRecorded(
      view,
      view.recorded_at,
      points.filter((point) => point.pid === view.health.pid),
      {
        memoryLayout: compatibleLayout(judge.layout, view),
        pressureScope: judge.pressureScope,
      },
    ),
  };
}

// One read of resource samples serves the RSS trend of every recording. The
// first failed read stops the batch.
async function checkBatch(batch: Batch, judge: Judge, signal: AbortSignal) {
  const { times, step } = batch;
  const from = times[0],
    to = times.at(-1);
  if (from === undefined || to === undefined) return [];
  const history = await getJson<ResourceHistory>(
    `/api/resources?${new URLSearchParams({
      start: String(from - step - (RSS_TREND_WINDOWS.at(-1) ?? 0)),
      end: String(to),
    })}`,
    signal,
  );
  const points = asResourcePoints(history.rows);
  const samples: Sample[] = new Array<Sample>(times.length).fill(null);
  let next = 0,
    failed = false;
  const worker = async () => {
    while (!failed && !signal.aborted && next < times.length) {
      const index = next++;
      try {
        samples[index] = await checkSlot(
          times[index] ?? 0,
          step,
          points,
          judge,
          signal,
        );
      } catch (cause) {
        failed = true;
        throw cause;
      }
    }
  };
  // Keep this batch busy while its remaining reads finish. A retry must not
  // overlap those reads and exceed the four-request limit.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(PAST.parallel, times.length) }, worker),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  return samples;
}

/**
 * Past assessments over the recordings. Each new bounds read starts the
 * first period until it succeeds, or, outside recorded mode, adds newer
 * recordings. One batch runs at a time. It reads only its own requests and
 * never selects, changes or stores an observation.
 */
export function usePastAssessments({
  bounds,
  recorded,
  layout,
  pressureScope,
}: {
  bounds: ReplayBounds | null | undefined;
  recorded: boolean;
  layout: MemoryLayout | null;
  pressureScope: PressureScope;
}) {
  const [scan, setScan] = useState(initialScan);
  // The scan as of the last action, ahead of the render, so two quick
  // requests for an earlier period start one batch.
  const current = useRef(initialScan);
  const running = useRef<AbortController | null>(null);
  function apply(action: ScanAction) {
    current.current = scanReducer(current.current, action);
    setScan(current.current);
  }
  function run(batch: Batch) {
    const controller = new AbortController();
    running.current = controller;
    apply({ type: "start", kind: batch.kind });
    checkBatch(batch, { layout, pressureScope }, controller.signal).then(
      (samples) => {
        if (!controller.signal.aborted)
          apply({ type: "checked", batch, samples });
      },
      (cause: unknown) => {
        if (!controller.signal.aborted)
          apply({
            type: "failed",
            kind: batch.kind,
            error:
              cause instanceof Error && cause.message
                ? cause.message
                : "Unable to read recordings.",
          });
      },
    );
  }
  function loadOlder() {
    if (current.current.busy || current.current.done) return;
    const plan = planOlder(current.current, bounds);
    if (plan === "done") apply({ type: "exhausted" });
    else if (plan) run(plan);
  }
  const onBounds = useEffectEvent(() => {
    if (current.current.busy) return;
    if (current.current.oldest === null) loadOlder();
    else if (!recorded) {
      const plan = planNewer(current.current, bounds);
      if (plan) run(plan);
    }
  });
  useEffect(() => {
    onBounds();
  }, [bounds]);
  useEffect(
    () => () => {
      // Unmount: nothing more is sent or applied. A remount starts again.
      running.current?.abort();
      if (current.current.busy)
        current.current = { ...current.current, busy: null };
    },
    [],
  );
  const found = useMemo(() => episodes(scan.samples), [scan.samples]);
  return { scan, episodes: found, loadOlder };
}
