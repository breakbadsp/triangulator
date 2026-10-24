import { describe, expect, it } from "vitest";
import type { Resources, ResourceSocket } from "../api/types";
import {
  resourceTiles,
  socketNotes,
  networkRows,
  scopeOf,
} from "./resourceView";
import { asResourcePoints } from "./assess/memory";
const socket = (extra: Partial<ResourceSocket>): ResourceSocket => ({
  kind: "tcp4",
  state: "ESTAB",
  listener: false,
  rx_queue: 0,
  tx_queue: 0,
  ...extra,
});
describe("resource views", () => {
  it("explains slow readers, full listeners and zero-window peers (old 444)", () => {
    expect(
      socketNotes(socket({ listener: true, accept_fill_pct: 125 })),
    ).toContainEqual(["Accept queue full: new connections are dropped", "bad"]);
    expect(socketNotes(socket({ rx_fill_pct: 95 }))).toContainEqual([
      "Receive buffer nearly full: the app is not reading fast enough",
      "bad",
    ]);
    const notes = socketNotes(
      socket({ tx_queue: 500000, tcp: { peer_window: 0, probes: 2 } }),
    );
    expect(notes).toContainEqual([
      "Peer window is zero: the peer is not reading",
      "bad",
    ]);
    expect(notes).toContainEqual(["Zero-window probing (2)", "bad"]);
  });
  it("does not call handshake or unknown windows zero-window peers (old 485)", () => {
    for (const state of ["SYN-SENT", "SYN-RECV"]) {
      const notes = socketNotes(
        socket({
          state,
          tx_queue: 1,
          tcp: { peer_window: 0, rwnd_limited_pct: 50 },
        }),
      )
        .flat()
        .join(" ");
      expect(notes).toMatch(
        state === "SYN-SENT" ? /Connect unanswered/ : /Handshake not finished/,
      );
      expect(notes).not.toMatch(/window/i);
    }
    expect(
      socketNotes(socket({ tx_queue: 1, tcp: { peer_window: null } })),
    ).toEqual([]);
    for (const state of ["ESTAB", "CLOSE-WAIT"])
      expect(
        socketNotes(socket({ state, tx_queue: 1, tcp: { peer_window: 0 } })),
      ).toContainEqual(["Peer window is zero: the peer is not reading", "bad"]);
  });
  it("preserves unknown, partial and measured-zero socket queues (old 534)", () => {
    const queued = (rx_queue: number | null, tx_queue: number | null) => ({
      rx_queue,
      tx_queue,
    });
    const tile = (sockets: Resources["sockets"]) =>
      resourceTiles({ available: true, sockets }, [], "cgroup")
        .find((t) => t[0] === "Queued in sockets")
        ?.slice(1, 3);
    for (const sockets of [
      {},
      {
        tcp: queued(null, null),
        udp: queued(null, null),
        unix: queued(null, null),
      },
      { tcp: queued(10, 20), udp: queued(null, null), unix: queued(0, 0) },
    ])
      expect(tile(sockets)).toEqual(["—", "unread — · unsent —"]);
    expect(
      tile({ tcp: queued(0, 0), udp: queued(0, 0), unix: queued(0, 0) }),
    ).toEqual(["0 B", "unread 0 B · unsent 0 B"]);
    expect(
      tile({ tcp: queued(10, null), udp: queued(0, 0), unix: queued(0, 0) }),
    ).toEqual(["—", "unread 10 B · unsent —"]);
    expect(
      tile({ tcp: queued(10, 20), udp: queued(30, 40), unix: queued(50, 60) }),
    ).toEqual(["210 B", "unread 90 B · unsent 120 B"]);
  });
  it("uses stored deltas in the chosen range and falls back to host PSI", () => {
    const r: Resources = {
      available: true,
      network: { listen_drops: { delta: 0, total: 90, per_s: 0 } },
    };
    expect(networkRows(r, []).rows[0]?.range).toBeNull();
    expect(
      networkRows(
        r,
        asResourcePoints([
          {
            ts: 1,
            pid: 4,
            elapsed_s: 2,
            rss_bytes: null,
            listen_drops_delta: 3,
          },
          {
            ts: 2,
            pid: 5,
            elapsed_s: 2,
            rss_bytes: null,
            listen_drops_delta: 4,
          },
        ]),
      ).rows[0]?.range,
    ).toBe(7);
    expect(scopeOf(r, "cgroup")).toBe("host");
    expect(
      scopeOf(
        { ...r, pressure: { cgroup: { cpu: { some: { avg10: 0 } } } } },
        "cgroup",
      ),
    ).toBe("cgroup");
  });
});
