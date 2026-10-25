import { describe, expect, it } from "vitest";
import type { LiveResponse } from "../api/types";
import { parseFrozen, parseReplay, timelineAtLive } from "../api/replay";
import {
  displayed,
  initialObservations,
  receiveLive,
  selectRecording,
  returnToLive,
  dismissFinal,
} from "./observation";
export function frame(
  at: number,
  session = "old",
  pid = 9,
): LiveResponse & { recorded_at: number } {
  return {
    recorded_at: at,
    health: {
      session,
      pid,
      last_seen: at,
      target_absent: false,
      sampler_silent: false,
      sample_interval_ms: 1000,
    },
    threads: [
      {
        tid: pid,
        name: "worker",
        generation: 1,
        last_sample: at,
        state: "running",
        cpu_pct: 25,
        run_delay_pct: 0,
      },
    ],
  };
}
describe("displayed observations", () => {
  it("keeps live CPU analysis isolated during replay and resumes it", () => {
    let state = receiveLive(
      initialObservations("host/app"),
      frame(2000, "live"),
      2000,
    );
    state = receiveLive(state, frame(2001, "live"), 2001);
    const kept = state.live;
    state = selectRecording(state, frame(1000), []);
    state = receiveLive(state, frame(2002, "live"), 2002);
    expect(displayed(state)?.now).toBe(1000);
    expect(state.live).toBe(kept);
    expect(displayed(state)?.series.points).toHaveLength(1);
    expect(displayed(state)?.memory.history).toEqual([]);
    state = returnToLive(state);
    expect(state.live?.series.cpu.get(9)).toHaveLength(3);
    expect(displayed(state)?.view.health.session).toBe("live");
  });
  it("discards old analysis when returning to a new populated session", () => {
    let state = receiveLive(
      initialObservations("x"),
      frame(2000, "live"),
      2000,
    );
    state = selectRecording(state, frame(1000), []);
    state = receiveLive(state, frame(2001, "new", 10), 2001);
    state = returnToLive(state);
    expect(state.live?.series.points).toHaveLength(1);
    expect(state.live?.series.cpu.has(9)).toBe(false);
  });
  it("settles empty sessions for ten seconds and freezes on confirmed absence", () => {
    let state = receiveLive(initialObservations("x"), frame(2000), 2000);
    const empty = { ...frame(2001, "new"), threads: [] };
    state = receiveLive(state, empty, 2001);
    state = receiveLive(state, empty, 2010);
    expect(displayed(state)?.now).toBe(2000);
    state = receiveLive(
      state,
      { ...empty, health: { ...empty.health, target_absent: true } },
      2010,
    );
    expect(displayed(state)?.mode.kind).toBe("final");
    state = receiveLive(state, frame(2011, "restart", 10), 2011);
    expect(displayed(state)?.view.health.session).toBe("old");
    expect(displayed(dismissFinal(state))?.view.health.session).toBe("restart");
  });
  it("expires settling and retains the matching late exit through replay and unrelated exits", () => {
    let state = receiveLive(initialObservations("x"), frame(2000), 2000);
    const empty = { ...frame(2001, "new"), threads: [] };
    let expired = receiveLive(state, empty, 2001);
    expired = receiveLive(expired, empty, 2011);
    expect(displayed(expired)?.view.threads).toEqual([]);
    state = selectRecording(state, frame(1000, "recorded"), []);
    state = receiveLive(
      state,
      { ...empty, health: { ...empty.health, target_absent: true } },
      2001,
    );
    expect(state.final?.now).toBe(2000);
    const exit = {
      pid: 9,
      session: "old",
      name: "worker",
      ended_at: 2001,
      reason: "exit",
      next_session: "new",
    };
    state = receiveLive(state, { ...empty, exit: { ...exit, pid: 10 } }, 2002);
    expect(state.final?.view.exit).toBeNull();
    state = receiveLive(state, { ...empty, exit }, 2003);
    state = receiveLive(
      state,
      { ...empty, exit: { ...exit, session: "unrelated" } },
      2004,
    );
    expect(state.final?.view.exit).toEqual(exit);
    expect(displayed(returnToLive(state))?.mode.kind).toBe("final");
    expect(displayed(dismissFinal(state))?.mode.kind).toBe("recorded");
  });
});
describe("replay boundaries", () => {
  it("accepts the collector clock ahead and missing snapshots but rejects malformed identities and time", () => {
    const snapshot = frame(4000000000);
    expect(
      parseReplay({ first: 1, last: snapshot.recorded_at, snapshot }).snapshot,
    ).toEqual(snapshot);
    expect(
      parseReplay({ first: null, last: null, snapshot: null }).snapshot,
    ).toBeNull();
    for (const bad of [
      {},
      { ...snapshot, recorded_at: -1 },
      { ...snapshot, health: null },
      { ...snapshot, threads: [{}] },
    ])
      expect(() =>
        parseReplay({ first: 1, last: 100, snapshot: bad }),
      ).toThrow();
  });
  it("validates frozen storage and discards the current session", () => {
    expect(
      parseFrozen({ at: 1000, live: frame(1000) }, "new")?.live.health.session,
    ).toBe("old");
    expect(parseFrozen({ at: 1000, live: frame(1000) }, "old")).toBeNull();
    expect(parseFrozen({ at: "bad", live: frame(1000) }, "new")).toBeNull();
    expect(parseFrozen({ at: 1000, live: { health: {} } }, "new")).toBeNull();
  });
  it("treats only the last selectable step as Live with fractional endpoints", () => {
    expect(timelineAtLive(999, 1000.5, 1)).toBe(false);
    expect(timelineAtLive(1000, 1000.5, 1)).toBe(true);
  });
});
