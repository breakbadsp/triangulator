import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useScopedPoll } from "./useScopedPoll";

afterEach(() => {
  vi.useRealTimers();
});

test("a context change hides old data at once and ignores its late response", async () => {
  vi.useFakeTimers();
  const calls: {
    signal: AbortSignal;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  const load = (signal: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ signal, resolve, reject });
    });
  const initialProps: { context: string | null } = { context: "A|42|900" };
  const { result, rerender } = renderHook(
    ({ context }) => useScopedPoll(context, load, 5000),
    { initialProps },
  );
  await act(async () => {
    calls[0]?.resolve("A 15 min");
    await Promise.resolve();
  });
  expect(result.current?.data).toBe("A 15 min");

  // A range change: the old range's data is gone before any new response.
  rerender({ context: "A|42|3600" });
  expect(result.current).toBeUndefined();
  expect(calls[0]?.signal.aborted).toBe(true);
  // A session change while the 1 h request is open; it answers last.
  rerender({ context: "B|43|3600" });
  expect(calls[1]?.signal.aborted).toBe(true);
  await act(async () => {
    calls[2]?.resolve("B 1 h");
    calls[1]?.resolve("A 1 h");
    await Promise.resolve();
  });
  expect(result.current?.data).toBe("B 1 h");

  // A failure keeps the last good data of the same context.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
    calls[3]?.reject(new Error("Collector unavailable"));
  });
  expect(result.current).toMatchObject({
    data: "B 1 h",
    error: { message: "Collector unavailable" },
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
    calls[4]?.resolve("B 1 h again");
  });
  expect(result.current).toEqual({ context: "B|43|3600", data: "B 1 h again" });

  rerender({ context: null });
  expect(result.current).toBeUndefined();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(calls).toHaveLength(5);
});
