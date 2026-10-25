// Past assessments are worked out from the recordings, not stored. The first
// period checks the last FIRST_S seconds. Each earlier period is twice as long
// as the one before, up to MAX_CHUNK_S. Each period checks up to SLOTS
// recordings spread evenly over it, so older periods are checked more
// coarsely. Outside recorded mode, newer recordings are added on each bounds
// read. A finding seen in consecutive checked recordings becomes one episode.
// A finding that starts and ends between two checked recordings is missed.
import type { ReplayBounds } from "../api/replay";
import type { Finding, FindingType, Level } from "./findings";
import { LEVEL_ORDER } from "./findings";

export const PAST = {
  slots: 120,
  parallel: 4,
  firstS: 900,
  maxChunkS: 21600,
} as const;

/** One checked time: the judged recording, or null when its slot had none. */
export type Sample = { at: number; findings: readonly Finding[] } | null;

export interface Episode {
  key: string;
  /** Stable while the episode keeps its first time. */
  id: string;
  type: FindingType;
  level: Level;
  /** The finding where the episode was worst, and its time. */
  item: Finding;
  at: number;
  first: number;
  last: number;
  count: number;
}

export interface Scan {
  /** Oldest first. */
  samples: readonly Sample[];
  oldest: number | null;
  newest: number | null;
  step: number | null;
  chunk: number;
  busy: Batch["kind"] | null;
  /** The oldest recording has been checked. */
  done: boolean;
  error: string;
}

export const initialScan: Scan = {
  samples: [],
  oldest: null,
  newest: null,
  step: null,
  chunk: PAST.firstS,
  busy: null,
  done: false,
  error: "",
};

export type Batch =
  | {
      kind: "older";
      times: readonly number[];
      step: number;
      start: number;
      end: number;
      first: boolean;
      reachesOldest: boolean;
    }
  | {
      kind: "newer";
      times: readonly number[];
      step: number;
      end: number;
      /** Slots were skipped because more than SLOTS were missing. */
      gap: boolean;
    };

export type ScanAction =
  | { type: "start"; kind: Batch["kind"] }
  | { type: "checked"; batch: Batch; samples: readonly Sample[] }
  | { type: "failed"; kind: Batch["kind"]; error: string }
  | { type: "exhausted" };

// The same finding in two views: same type, same title once numbers are
// ignored ("Packet loss 2.1%" and "Packet loss 3.4%"), and the same thread
// generation in the same sampler session. A reused TID is a different thread.
export const findingKey = (item: Finding) =>
  [
    item.type,
    item.title.replace(/\d+(?:[.,]\d+)*/g, "#"),
    item.action?.tid ?? "",
    item.action?.session ?? "",
    item.action?.generation ?? "",
  ].join("|");

const rank = (level: Level) => LEVEL_ORDER.indexOf(level);

/**
 * A missing sample ends every open episode: nothing is known then. An
 * episode keeps its worst level, and the time and wording where it was worst.
 * Newest first.
 */
export function episodes(samples: readonly Sample[]): Episode[] {
  const open = new Map<string, Episode>(),
    done: Episode[] = [];
  for (const sample of samples) {
    const seen = new Set<string>();
    for (const item of sample?.findings ?? []) {
      const key = findingKey(item);
      if (!sample || item.level === "good" || seen.has(key)) continue;
      seen.add(key);
      let episode = open.get(key);
      if (!episode) {
        episode = {
          key,
          id: `${key}@${String(sample.at)}`,
          type: item.type,
          level: item.level,
          item,
          at: sample.at,
          first: sample.at,
          last: sample.at,
          count: 0,
        };
        open.set(key, episode);
      }
      episode.last = sample.at;
      episode.count++;
      if (rank(item.level) < rank(episode.level))
        Object.assign(episode, { level: item.level, item, at: sample.at });
    }
    for (const [key, episode] of open)
      if (!seen.has(key)) {
        done.push(episode);
        open.delete(key);
      }
  }
  return [...done, ...open.values()].sort(
    (a, b) => b.first - a.first || rank(a.level) - rank(b.level),
  );
}

/** count times ending at end, step apart, none before start. */
export const slotTimes = (
  start: number,
  end: number,
  step: number,
  count: number,
) =>
  Array.from({ length: count }, (_, index) =>
    Math.max(start, end - (count - 1 - index) * step),
  );

/** The next earlier period, "done" when none is left, or null for no bounds. */
export function planOlder(
  scan: Scan,
  bounds: ReplayBounds | null | undefined,
): Extract<Batch, { kind: "older" }> | "done" | null {
  if (bounds?.first == null || bounds.last == null) return null;
  const first = scan.oldest === null,
    end = scan.oldest ?? bounds.last,
    start = Math.max(bounds.first, end - scan.chunk);
  if (!first && end <= bounds.first) return "done";
  const step = Math.max(
    bounds.interval_s || 1,
    (end - start) / (PAST.slots - 1),
  );
  // An earlier period stops one step before the oldest time already checked.
  const count = Math.min(
    PAST.slots,
    Math.floor((end - start) / step + 1e-9) + (first ? 1 : 0),
  );
  return {
    kind: "older",
    times: slotTimes(start, first ? end : end - step, step, count),
    step,
    start,
    end,
    first,
    reachesOldest: start <= bounds.first,
  };
}

/** The recordings made since the newest checked time, or null for none. */
export function planNewer(
  scan: Scan,
  bounds: ReplayBounds | null | undefined,
): Batch | null {
  if (scan.newest === null || scan.step === null || bounds?.last == null)
    return null;
  const step = scan.step,
    missing = Math.floor((bounds.last - scan.newest) / step + 1e-9);
  if (missing < 1) return null;
  const count = Math.min(PAST.slots, missing),
    end = scan.newest + missing * step;
  return {
    kind: "newer",
    times: slotTimes(scan.newest + step, end, step, count),
    step,
    end,
    gap: missing > count,
  };
}

export function scanReducer(scan: Scan, action: ScanAction): Scan {
  switch (action.type) {
    case "start":
      return {
        ...scan,
        busy: action.kind,
        error: action.kind === "older" ? "" : scan.error,
      };
    case "failed":
      // A newer batch is retried on the next bounds read without a message.
      return {
        ...scan,
        busy: null,
        error: action.kind === "older" ? action.error : scan.error,
      };
    case "exhausted":
      return { ...scan, busy: null, done: true };
    case "checked": {
      const { batch, samples } = action;
      if (batch.kind === "newer")
        return {
          ...scan,
          busy: null,
          samples: [...scan.samples, ...(batch.gap ? [null] : []), ...samples],
          newest: batch.end,
        };
      return {
        ...scan,
        busy: null,
        samples: [...samples, ...scan.samples],
        oldest: batch.start,
        newest: batch.first ? batch.end : scan.newest,
        step: batch.first ? batch.step : scan.step,
        chunk: Math.min(2 * scan.chunk, PAST.maxChunkS),
        done: batch.reachesOldest,
      };
    }
  }
}
