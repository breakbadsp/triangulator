import { assert, expect, test } from "vitest";
import type { Thread } from "../../api/types";
import { assess, fleetAssessment, lockHints } from "./index";
import { lockThread, view } from "../test-fixtures";
import { episodes } from "../pastAssessments";
import { input } from "./test-input";
// The collector last saw each thread run `age` seconds before its sample.
const waited = (threads: readonly Thread[], age: number) =>
  threads.map((thread) => ({
    ...thread,
    last_ran: (thread.last_sample ?? 0) - age,
  }));
const hintsFor = (threads: readonly Thread[], age: number) =>
  lockHints(waited(threads, age)).map((item) => item.title + "|" + item.detail);
// The convoy rule alone: threads without last_ran never raise the stuck hint.
const convoyHints = (threads: readonly Thread[]) =>
  lockHints(threads).map((item) => item.title + "|" + item.detail);
test("a full deadlock, with every thread blocked, raises the hint", () => {
  const all = [1, 2, 3].map((tid) =>
    lockThread(tid, `worker-${String(tid)}`, "futex"),
  );
  const hints = hintsFor(all, 45);
  assert.strictEqual(hints.length, 1, hints.join("\n"));
  assert.match(
    hints[0] ?? "",
    /^3 threads have not run for over 45 s\|Possible deadlock/,
  );
  assert.match(
    hints[0] ?? "",
    /worker-1 \(1\), worker-2 \(2\), worker-3 \(3\)/,
  );
  const [item] = lockHints(waited(all, 45));
  expect(item).toMatchObject({
    level: "info",
    action: { activity: "idle" },
  });
  expect(item?.action).not.toHaveProperty("state");
  expect(
    assess(input(view({ threads: waited(all, 45) }))).map((f) => f.level),
  ).toEqual(["good", "info"]);
});

test("the hint stays one past episode while its count and unit change", () => {
  const sample = (at: number, ages: readonly number[]) => ({
    at,
    findings: lockHints(
      ages.map((age, index) => ({
        ...lockThread(index + 1, `w-${String(index + 1)}`, "futex"),
        last_ran: 1000 - age,
      })),
    ),
  });
  const samples = [
    sample(1000, [45]),
    sample(1010, [55, 40]),
    sample(1020, [65]),
    sample(1030, [120]),
  ];
  expect(samples.map((item) => item.findings[0]?.title)).toEqual([
    "1 thread has not run for over 45 s",
    "2 threads have not run for over 40 s",
    "1 thread has not run for over 65 s",
    "1 thread has not run for over 2 min",
  ]);
  expect(episodes(samples).map((item) => item.count)).toEqual([4]);
});

test("one stuck thread raises the hint, in any state", () => {
  const beat = lockThread(1, "misc-heartbeat", "sleep", { cpu: 0.2, sw: 2 });
  const stuck = { ...lockThread(2, "worker-a", "sleep"), last_ran: 955 };
  const [item] = lockHints([{ ...beat, last_ran: 1000 }, stuck]);
  expect(item?.title).toBe("1 thread has not run for over 45 s");
  expect(item?.detail).toMatch(/: worker-a \(2\)\./);
});

test("the hint names the longest waits first, at most five", () => {
  const threads = [1, 2, 3, 4, 5, 6, 7].map((tid) => ({
    ...lockThread(tid, `t${String(tid)}`, "sleep"),
    last_ran: 1000 - 30 - tid * 10,
  }));
  const [item] = lockHints(threads);
  expect(item?.title).toBe("7 threads have not run for over 40 s");
  expect(item?.detail).toMatch(
    /: t7 \(7\), t6 \(6\), t5 \(5\), t4 \(4\), t3 \(3\), \u2026\./,
  );
});

test("a thread in a kernel wait widens the table filter to all threads", () => {
  const [item] = lockHints(waited([lockThread(1, "io", "kernel")], 45));
  expect(item?.action).toEqual({ activity: "all" });
});

test("short waits, stale threads, and threads without last_ran stay quiet", () => {
  const threads = [1, 2].map((tid) =>
    lockThread(tid, `worker-${String(tid)}`, "futex"),
  );
  assert.deepEqual(hintsFor(threads, 20), []);
  assert.deepEqual(
    lockHints(
      waited(threads, 600).map((thread) => ({ ...thread, stale: true })),
    ),
    [],
  );
  // Without the collector's last_ran, the wait time is unknown: no claim.
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
  const hints = convoyHints(convoy);
  assert.strictEqual(hints.length, 1, hints.join("\n"));
  assert.match(
    hints[0] ?? "",
    /^8 of 8 “worker” threads mostly wait on a futex but keep waking\|Together they used 1\.6% of one core and switched 120 times\/s/,
  );
  // Waiting workers that do not wake (an idle pool), busy workers, and small families are quiet.
  assert.deepEqual(
    convoyHints(
      convoy.map((thread) => ({ ...thread, switches_per_s: 0, cpu_pct: 0 })),
    ),
    [],
  );
  assert.deepEqual(
    convoyHints(convoy.map((thread) => ({ ...thread, cpu_pct: 20 }))),
    [],
  );
  assert.deepEqual(convoyHints(convoy.slice(0, 3)), []);
  assert.deepEqual(
    convoyHints(
      convoy.map((thread) => ({
        ...thread,
        state_mix: { running: 15, futex: 5 },
      })),
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
    "2 threads have not run for over 66 s",
  ]);
  // A worker that ran 10 s ago has not waited long enough.
  expect(
    lockHints(threads.map((thread) => ({ ...thread, last_ran: 990 }))),
  ).toHaveLength(0);
});
