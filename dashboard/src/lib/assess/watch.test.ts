import { assert, test } from "vitest";
import type { LiveResponse, Thread, WatchRule } from "../../api/types";
import { assess } from "./index";
import type { ViewMode } from "./index";
import { watchedThread, view } from "../test-fixtures";
import { input } from "./test-input";
function checkWatch(
  threads: readonly Thread[],
  {
    health = {},
    rules = null,
    mode = { kind: "live" },
  }: {
    health?: Partial<LiveResponse["health"]>;
    rules?: readonly WatchRule[] | null;
    mode?: ViewMode;
  } = {},
) {
  const live = view({
    health: { ...view().health, sample_interval_ms: 200, ...health },
    threads,
  });
  const findings = assess(input(live, { watchRules: rules, mode }));
  return {
    findings,
    watch: findings.filter((item) => item.help === "watched"),
  };
}
test("a watched thread that has not run for over 2 x wake + 2 x sample interval stopped waking", () => {
  // wake 500 ms, sample interval 200 ms: overdue after 2 x 0.5 + 2 x 0.2 = 1.4 s.
  const limit = (quiet: number) =>
    checkWatch([watchedThread(1, "worker-1", { quiet })]).watch;
  assert.strictEqual(
    limit(1.4).some((item) => item.level === "serious"),
    false,
    "exactly at the limit is on time",
  );
  assert.strictEqual(
    limit(1.0).some((item) => item.level === "serious"),
    false,
  );
  const [stuck] = limit(4.2);
  assert.isDefined(stuck);
  assert.strictEqual(stuck.level, "serious");
  assert.strictEqual(stuck.title, "worker-1 stopped waking up");
  assert.match(
    stuck.detail,
    /TID 1 is set to wake at least every 500 ms, but it has not run for 4\.2 s\. It may be deadlocked or waiting without a timeout\. Last state: Futex wait in futex_do_wait\./,
  );
  assert.deepEqual(stuck.action, { tid: 1 });
  // The interval term: a 10 ms rule is not flagged by ordinary sampling jitter, a 1 s sampler tolerates more.
  const fast = (quiet: number) =>
    checkWatch([watchedThread(1, "tick-1", { wake: 10, quiet })]).watch.some(
      (item) => item.level === "serious",
    );
  assert.strictEqual(fast(0.4), false);
  assert.strictEqual(fast(0.5), true);
  const slow = (quiet: number) =>
    checkWatch([watchedThread(1, "tick-1", { wake: 500, quiet })], {
      health: { sample_interval_ms: 1000 },
    }).watch.some((item) => item.level === "serious");
  assert.strictEqual(slow(2.9), false);
  assert.strictEqual(slow(3.1), true);
  // An unknown sample interval is assumed to be slow, never fast.
  assert.strictEqual(
    checkWatch([watchedThread(1, "tick-1", { quiet: 2.9 })], {
      health: { sample_interval_ms: null },
    }).watch.some((item) => item.level === "serious"),
    false,
  );
});

test("stuck time is measured between samples, not against the clock", () => {
  const findings = checkWatch([watchedThread(1, "worker-1", { quiet: 0.1 })], {
    mode: { kind: "recorded" },
  }).findings;
  assert.deepEqual(
    findings
      .map((item) => item.title)
      .filter((title) => /worker-1|watched/.test(title)),
    ["1 watched thread wakes on schedule"],
  );
});

test("several stuck threads become one finding, worst first", () => {
  const threads = [1, 2, 3, 4, 5].map((tid) =>
    watchedThread(tid, "worker-" + String(tid), { quiet: tid + 1 }),
  );
  threads.push(
    watchedThread(6, "io-1", {
      wake: 100,
      quiet: 0.1,
      state: "sleep",
      wchan: "",
    }),
  );
  const { watch } = checkWatch(threads);
  const stuck = watch.filter((item) => item.level === "serious");
  assert.strictEqual(stuck.length, 1);
  assert.strictEqual(stuck[0]?.title, "5 watched threads stopped waking up");
  assert.match(
    stuck[0]?.detail ?? "",
    /Worst first: worker-5 \(6\.0 s, every 500 ms\), worker-4 \(5\.0 s, every 500 ms\), worker-3 \(4\.0 s, every 500 ms\) and 2 more\./,
  );
  assert.deepEqual(stuck[0]?.action, { tid: 5 });
  assert.strictEqual(
    watch.some((item) => item.level === "info"),
    false,
    'no "on schedule" line while some thread is stuck',
  );
});

test("a busy watched thread gets one specific finding instead of the generic one", () => {
  const { findings, watch } = checkWatch([
    watchedThread(1, "worker-spin", { cpu: 99, state: "running", wchan: "" }),
    watchedThread(2, "plain-spin", {
      cpu: 95,
      state: "running",
      wchan: "",
      wake: null,
      last_ran: undefined,
    }),
  ]);
  const titles = findings.map((item) => item.title);
  assert.deepEqual(titles.filter((title) => /spin/.test(title)).sort(), [
    "plain-spin is saturating a core",
    "worker-spin is running instead of sleeping",
  ]);
  assert.strictEqual(watch.length, 1);
  assert.strictEqual(watch[0]?.level, "serious");
  assert.match(
    watch[0]?.detail ?? "",
    /expected to sleep and wake every 500 ms, but it uses 99\.0% of one core\. It may be stuck in an infinite or retry loop\./,
  );
  assert.deepEqual(watch[0]?.action, { tid: 1 });
  const several = checkWatch(
    [1, 2, 3].map((tid) =>
      watchedThread(tid, "worker-" + String(tid), {
        cpu: 90 + tid,
        state: "running",
      }),
    ),
  ).watch;
  assert.strictEqual(several.length, 1);
  assert.strictEqual(
    several[0]?.title,
    "3 watched threads are running instead of sleeping",
  );
  assert.match(
    several[0]?.detail ?? "",
    /worker-3 93\.0%, worker-2 92\.0%, worker-1 91\.0%/,
  );
});

test("watch findings skip stale threads, a silent sampler, an absent target and unwatched data", () => {
  const stale = watchedThread(1, "worker-1", { quiet: 30, stale: true });
  assert.deepEqual(checkWatch([stale]).watch, []);
  const stuck = watchedThread(1, "worker-1", { quiet: 30 });
  assert.deepEqual(
    checkWatch([stuck], { health: { sampler_silent: true } }).watch,
    [],
  );
  assert.deepEqual(
    checkWatch([stuck], { health: { target_absent: true } }).watch,
    [],
  );
  // Older recordings carry neither wake_ms nor last_ran: not watched.
  const old: Thread = watchedThread(1, "worker-1", { quiet: 30 });
  delete old.wake_ms;
  delete old.last_ran;
  assert.deepEqual(checkWatch([old]).watch, []);
  assert.deepEqual(
    checkWatch([watchedThread(1, "worker-1", { wake: null, quiet: 30 })]).watch,
    [],
  );
});

test("a rule that matches no current thread is a warning, only for a live present target", () => {
  const rules = [
    { prefix: "worker-", wake_ms: 500 },
    { prefix: "gone-", wake_ms: 200 },
  ];
  const threads = [watchedThread(1, "worker-1")];
  const { watch } = checkWatch(threads, { rules });
  const missing = watch.find((item) => item.level === "warning");
  assert.isDefined(missing);
  assert.strictEqual(missing.title, "A watch rule matches no thread");
  assert.match(
    missing.detail,
    /^No thread matches watch rule “gone-”: the threads may have exited or been renamed\./,
  );
  // The longest prefix wins, so a rule shadowed by a longer one matches nothing.
  const shadowed = checkWatch(
    [watchedThread(1, "worker-io-1", { wake: 100 })],
    {
      rules: [
        { prefix: "worker-", wake_ms: 500 },
        { prefix: "worker-io", wake_ms: 100 },
      ],
    },
  ).watch;
  assert.match(
    shadowed.find((item) => item.level === "warning")?.detail ?? "",
    /“worker-”/,
  );
  assert.strictEqual(
    checkWatch(threads, {
      rules: [{ prefix: "worker-", wake_ms: 500 }],
    }).watch.some((item) => item.level === "warning"),
    false,
  );
  // A stale thread does not satisfy a rule; no threads at all says nothing.
  assert.strictEqual(
    checkWatch([watchedThread(1, "gone-1", { stale: true }), ...threads], {
      rules,
    }).watch.filter((item) => item.level === "warning").length,
    1,
  );
  assert.strictEqual(checkWatch([], { rules }).watch.length, 0);
  // Not loaded, replay, final view, silent sampler, absent target: skipped.
  assert.strictEqual(
    checkWatch(threads).watch.some((item) => item.level === "warning"),
    false,
  );
  assert.strictEqual(
    checkWatch(threads, { rules, mode: { kind: "recorded" } }).watch.some(
      (item) => item.level === "warning",
    ),
    false,
  );
  assert.strictEqual(
    checkWatch(threads, {
      rules,
      mode: { kind: "final", exit: null },
    }).watch.some((item) => item.level === "warning"),
    false,
  );
  assert.strictEqual(
    checkWatch(threads, { rules, health: { sampler_silent: true } }).watch.some(
      (item) => item.level === "warning",
    ),
    false,
  );
  assert.strictEqual(
    checkWatch(threads, { rules, health: { target_absent: true } }).watch.some(
      (item) => item.level === "warning",
    ),
    false,
  );
  // The rule list is older than the threads (a rule was just saved): wait for the refresh.
  assert.strictEqual(
    checkWatch([watchedThread(1, "worker-1", { wake: 250 })], {
      rules,
    }).watch.some((item) => item.level === "warning"),
    false,
  );
  assert.strictEqual(
    checkWatch([watchedThread(1, "worker-1", { wake: null })], {
      rules,
    }).watch.some((item) => item.level === "warning"),
    false,
  );
});

test("healthy watched threads get one line naming their rules", () => {
  const rules = [
    { prefix: "worker-", wake_ms: 500 },
    { prefix: "io-", wake_ms: 100 },
  ];
  const threads = [
    watchedThread(1, "worker-1", { quiet: 0.3 }),
    watchedThread(2, "worker-2"),
    watchedThread(3, "io-1", { wake: 100, quiet: 0.1 }),
    watchedThread(4, "worker-3", { quiet: 0.2 }),
  ];
  const { watch } = checkWatch(threads, { rules });
  assert.deepEqual(
    watch.map((item) => [item.level, item.title]),
    [["info", "4 watched threads wake on schedule (worker-, io-)"]],
  );
  assert.deepEqual(
    checkWatch([watchedThread(1, "worker-1")]).watch.map((item) => item.title),
    ["1 watched thread wakes on schedule"],
    "without rules, only the count",
  );
  assert.deepEqual(
    checkWatch([{ ...watchedThread(1, "misc"), wake_ms: null }]).watch,
    [],
  );
});
