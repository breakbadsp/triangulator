import { render } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { CpuSparkline } from "./Sparkline";

test("a thread's line is built again only when its samples change", () => {
  const samples = [
    { t: 1, v: 10 },
    { t: 2, v: 20 },
  ];
  const read = vi.spyOn(samples, "map");
  const { rerender, container } = render(<CpuSparkline samples={samples} />);
  expect(container.querySelector("polyline")).not.toBeNull();
  rerender(<CpuSparkline samples={samples} className="again" />);
  expect(read).toHaveBeenCalledTimes(1);
  rerender(<CpuSparkline samples={[...samples, { t: 3, v: 30 }]} />);
  expect(container.querySelector("polyline")?.getAttribute("points")).toContain(
    "100.0",
  );
});
