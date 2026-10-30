import { assert, expect, test } from "vitest";
import type { Thread } from "../../api/types";
import { assess, fleetAssessment, lockHints } from "./index";
import { lockThread, view } from "../test-fixtures";
import { input } from "./test-input";
// The collector last saw each thread run `age` seconds before its sample.
const waited = (threads: readonly Thread[], age: number) =>
  threads.map((thread) => ({
    ...thread,
    last_ran: (thread.last_sample ?? 0) - age,
  }));
const hintsFor = (threads: readonly Thread[], age: number) =>
  lockHints(waited(threads, age)).map((item) => item.title + "|" + item.detail);
test("threads stuck on a futex while others run raise a hint, not a verdict", () => {
  const beat = lockThread(1, "misc-heartbeat", "sleep", { cpu: 0.2, sw: 2 });
  const stuck = [
    lockThread(2, "worker-a", "futex"),
    lockThread(3, "worker-b", "futex"),
  ];
  const hints = hintsFor([beat, ...stuck], 45);
  assert.strictEqual(hints.length, 1, hints.join("\n"));
  assert.match(
    hints[0] ?? "",
    /^2 threads have waited on a futex for over 45 s while other threads are active\|Possible deadlock/,
  );
  assert.match(hints[0] ?? "", /worker-a \(2\), worker-b \(3\)/);
  expect(
    assess(input(view({ threads: waited([beat, ...stuck], 45) }))).map(
      (item) => item.level,
    ),
  ).toEqual(["good", "info"]);
  // Not long enough yet, or only one thread, or nothing else running: quiet.
  assert.deepEqual(hintsFor([beat, ...stuck], 20), []);
  assert.deepEqual(hintsFor([beat, ...stuck.slice(0, 1)], 45), []);
  assert.deepEqual(hintsFor(stuck, 45), []);
});

test("idle pool workers on a futex stay quiet", () => {
  const main = lockThread(1, "main", "running", { cpu: 30, sw: 50 });
  // A pool with one busy worker: the idle ones are spare capacity.
  const busyPool = [
    lockThread(2, "pool-1", "running", { cpu: 5, sw: 40 }),
    ...[3, 4, 5, 6].map((tid) =>
      lockThread(tid, `pool-${String(tid)}`, "futex"),
    ),
  ];
  assert.deepEqual(hintsFor([main, ...busyPool], 600), []);
  // A pool that is wholly idle next to an active thread looks like an idle pool.
  const idlePool = [2, 3, 4, 5].map((tid) =>
    lockThread(tid, `pool-${String(tid)}`, "futex"),
  );
  assert.deepEqual(hintsFor([main, ...idlePool], 600), []);
  // Idle workers that wake now and then are not parked; a thread that is not
  // in a futex is never reported.
  const sleepers = [2, 3].map((tid) =>
    lockThread(tid, `timer-${String(tid)}x`, "sleep"),
  );
  assert.deepEqual(hintsFor([main, ...sleepers], 600), []);
  // Without the collector's last_ran, the wait time is unknown: no claim.
  const threads = [
    main,
    lockThread(7, "a", "futex"),
    lockThread(8, "b", "futex"),
  ];
  expect(lockHints(threads)).toHaveLength(0);
});

test("many futex waiters that keep waking with little CPU raise a convoy hint", () => {
  const convoy = [...Array(8).keys()].map((index) => {
    const thread = lockThread(
      10 + index,
      `worker-${String(index)}`,
      index ? "futex" : "sleep",
      { cpu: 0.2, sw: 15 },
    );
    thread.state_mix = { futex: 17, sleep: 3 };
    return thread;
  });
  const hints = hintsFor(convoy, 45);
  assert.strictEqual(hints.length, 1, hints.join("\n"));
  assert.match(
    hints[0] ?? "",
    /^8 of 8 “worker” threads mostly wait on a futex but keep waking\|Together they used 1\.6% of one core and switched 120 times\/s/,
  );
  // Waiting workers that do not wake (an idle pool), busy workers, and small families are quiet.
  assert.deepEqual(
    hintsFor(
      convoy.map((thread) => ({ ...thread, switches_per_s: 0, cpu_pct: 0 })),
      45,
    ),
    [],
  );
  assert.deepEqual(
    hintsFor(
      convoy.map((thread) => ({ ...thread, cpu_pct: 20 })),
      45,
    ),
    [],
  );
  assert.deepEqual(hintsFor(convoy.slice(0, 3), 45), []);
  assert.deepEqual(
    hintsFor(
      convoy.map((thread) => ({
        ...thread,
        state_mix: { running: 15, futex: 5 },
      })),
      45,
    ),
    [],
  );
});

test("QA-107: a recorded or fleet view alone shows the stuck-thread hint", () => {
  // The QA-107 view: two workers parked on a futex for 66 s, 0 switches/s,
  // while a heartbeat thread keeps running. No browser history exists.
  const threads = [
    { ...lockThread(1, "misc-heartbeat", "sleep", { sw: 2 }), last_ran: 1000 },
    { ...lockThread(2, "worker-a", "futex"), last_ran: 934 },
    { ...lockThread(3, "worker-b", "futex"), last_ran: 934 },
  ];
  const fleet = fleetAssessment(view({ threads }), 1000);
  expect(fleet?.findings.map((item) => item.title)).toEqual([
    "2 threads have waited on a futex for over 66 s while other threads are active",
  ]);
  // A worker that ran 10 s ago has not waited long enough.
  expect(
    lockHints(threads.map((thread) => ({ ...thread, last_ran: 990 }))),
  ).toHaveLength(0);
});
