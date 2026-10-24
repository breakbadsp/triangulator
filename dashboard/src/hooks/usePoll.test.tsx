import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { usePoll } from "./usePoll";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function deferred<T>() {
  let complete: (value: T) => void = () => {
    throw new Error("Promise is not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return { promise, complete };
}

test("waits for completion before starting the next interval", async () => {
  const first = deferred<number>();
  const load = vi
    .fn<(signal: AbortSignal) => Promise<number>>()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(9);
  const { result } = renderHook(() => usePoll(load, 1000));
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    first.complete(7);
    await first.promise;
  });
  expect(result.current).toEqual({ data: 7 });
  await act(() => vi.advanceTimersByTimeAsync(999));
  expect(load).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(load).toHaveBeenCalledTimes(2);
  expect(result.current).toEqual({ data: 9 });
});

test("keeps the last good data after a failure and clears the error on recovery", async () => {
  const error = new Error("Collector unavailable");
  const load = vi
    .fn<(signal: AbortSignal) => Promise<number>>()
    .mockResolvedValueOnce(7)
    .mockRejectedValueOnce(error)
    .mockResolvedValueOnce(9);
  const { result } = renderHook(() => usePoll(load, 1000));
  await act(() => Promise.resolve());
  expect(result.current).toEqual({ data: 7 });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(result.current).toEqual({ data: 7, error });
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(result.current).toEqual({ data: 9 });
});

test("aborts on unmount and ignores a late result without scheduling another poll", async () => {
  const pending = deferred<number>();
  const load = vi
    .fn<(signal: AbortSignal) => Promise<number>>()
    .mockReturnValue(pending.promise);
  const { unmount } = renderHook(() => usePoll(load, 1000));
  const signal = load.mock.calls[0]?.[0];
  expect(signal?.aborted).toBe(false);
  unmount();
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    pending.complete(3);
    await pending.promise;
  });
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(load).toHaveBeenCalledTimes(1);
});

test("clears a scheduled timer on unmount", async () => {
  const load = vi
    .fn<(signal: AbortSignal) => Promise<number>>()
    .mockResolvedValue(1);
  const { unmount } = renderHook(() => usePoll(load, 1000));
  await act(() => Promise.resolve());
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(load).toHaveBeenCalledTimes(1);
});

test("aborts a replaced loader and does not publish its late response", async () => {
  const old = deferred<number>();
  const initial = vi
    .fn<(signal: AbortSignal) => Promise<number>>()
    .mockReturnValue(old.promise);
  const next = vi
    .fn<(signal: AbortSignal) => Promise<number>>()
    .mockResolvedValue(2);
  const { result, rerender } = renderHook(({ load }) => usePoll(load, 1000), {
    initialProps: { load: initial },
  });
  rerender({ load: next });
  await act(() => Promise.resolve());
  expect(initial.mock.calls[0]?.[0].aborted).toBe(true);
  await act(async () => {
    old.complete(1);
    await old.promise;
  });
  expect(result.current).toEqual({ data: 2 });
});
