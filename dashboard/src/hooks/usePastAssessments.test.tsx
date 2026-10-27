import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { MemoryLayout, PressureScope } from "../api/types";
import { usePastAssessments } from "./usePastAssessments";

afterEach(() => {
  vi.unstubAllGlobals();
});

const bounds = { first: 1000, last: 1100, interval_s: 1 };
const layout = { available: true, id: "1:1:1" } as unknown as MemoryLayout;
const reads = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/replay"))
    .length;

function setup() {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      url.includes("/api/resources")
        ? Response.json({ rows: [] })
        : Response.json({ ...bounds, snapshot: null }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const props = (
  pressureScope: PressureScope,
  memoryLayout: MemoryLayout | null,
) => ({ pressureScope, memoryLayout });

test("a new pressure scope or the first memory layout scans the recordings again", async () => {
  const fetchMock = setup();
  const { result, rerender } = renderHook(
    ({
      pressureScope,
      memoryLayout,
    }: {
      pressureScope: PressureScope;
      memoryLayout: MemoryLayout | null;
    }) =>
      usePastAssessments({
        bounds,
        recorded: false,
        layout: memoryLayout,
        pressureScope,
      }),
    { initialProps: props("cgroup", null) },
  );
  await waitFor(() => {
    expect(result.current.scan.busy).toBeNull();
    expect(reads(fetchMock)).toBeGreaterThan(0);
  });
  const first = reads(fetchMock);
  rerender(props("host", null));
  await waitFor(() => {
    expect(reads(fetchMock)).toBeGreaterThan(first);
  });
  await waitFor(() => {
    expect(result.current.scan.busy).toBeNull();
  });
  const second = reads(fetchMock);
  rerender(props("host", layout));
  await waitFor(() => {
    expect(reads(fetchMock)).toBeGreaterThan(second);
  });
  await waitFor(() => {
    expect(result.current.scan.busy).toBeNull();
  });
  // A different layout id does not repeat the requests.
  const third = reads(fetchMock);
  rerender(props("host", { ...layout, id: "1:1:2" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(reads(fetchMock)).toBe(third);
});
