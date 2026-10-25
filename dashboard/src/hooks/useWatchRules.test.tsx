import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Thread } from "../api/types";
import { watchedThread } from "../lib/test-fixtures";
import { useWatchRules } from "./useWatchRules";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("rules load once, refresh every 10 s and are fetched again when they look out of date", async () => {
  let rules = [{ prefix: "worker-", wake_ms: 500 }];
  let reply = () => Response.json({ rules });
  const fetchMock = vi.fn(() => Promise.resolve(reply()));
  vi.stubGlobal("fetch", fetchMock);
  let clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const { result, rerender } = renderHook(
    ({ threads }: { threads?: readonly Thread[] }) => useWatchRules(threads),
    { initialProps: {} },
  );
  expect(fetchMock).not.toHaveBeenCalled();
  // Each live poll brings a new thread list.
  const poll = async (threads: readonly Thread[] = []) => {
    await act(async () => {
      rerender({ threads: [...threads] });
      await Promise.resolve();
    });
  };
  await poll();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]).toEqual(["/api/watches", expect.anything()]);
  await waitFor(() => {
    expect(result.current.rules).toEqual(rules);
  });
  await poll();
  expect(fetchMock, "not again within 10 s").toHaveBeenCalledTimes(1);
  clock += 11000;
  await poll();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await waitFor(() => {
    expect(result.current.rules).toEqual(rules);
  });
  // A thread reports a wake_ms the list does not give it: fetch sooner, but
  // not on every poll.
  const changed: Thread[] = [watchedThread(1, "worker-1", { wake: 250 })];
  await poll(changed);
  expect(fetchMock, "retry is throttled to 3 s").toHaveBeenCalledTimes(2);
  rules = [{ prefix: "worker-", wake_ms: 250 }];
  clock += 3500;
  await poll(changed);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await waitFor(() => {
    expect(result.current.rules?.[0]?.wake_ms).toBe(250);
  });
  // A failed request leaves no rules, so no unmatched-rule finding can come
  // from them.
  reply = () => new Response("", { status: 503 });
  clock += 11000;
  await poll(changed);
  await waitFor(() => {
    expect(result.current.rules).toBeNull();
  });
  // After an applied change, refresh reads at once.
  reply = () => Response.json({ rules });
  await act(() => result.current.refresh());
  expect(fetchMock).toHaveBeenCalledTimes(5);
  expect(result.current.rules).toEqual(rules);
});

test("recorded and final assessments stop refresh and reject pending live rules", async () => {
  let resolve: (value: Response) => void = () => undefined;
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const threads: Thread[] = [];
  const { result, rerender } = renderHook(
    ({ enabled, context }) => useWatchRules(threads, enabled, context),
    { initialProps: { enabled: true, context: "live" } },
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  rerender({ enabled: false, context: "recorded" });
  await act(async () => {
    resolve(Response.json({ rules: [{ prefix: "late", wake_ms: 10 }] }));
    await result.current.refresh();
  });
  expect(result.current.rules).toBeNull();
  rerender({ enabled: false, context: "final" });
  await act(() => result.current.refresh());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  rerender({ enabled: true, context: "live-again" });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => {
    resolve(Response.json({ rules: [{ prefix: "current", wake_ms: 20 }] }));
    await Promise.resolve();
  });
  expect(result.current.rules).toEqual([{ prefix: "current", wake_ms: 20 }]);
});
