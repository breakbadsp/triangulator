import { expect, test } from "vitest";
import { axisBytes, niceBytes } from "./chart";

test("byte axes round to binary units and keep the midpoint label exact", () => {
  expect(niceBytes(300 * 2 ** 20)).toBe(500 * 2 ** 20);
  expect(niceBytes(3 * 2 ** 30)).toBe(5 * 2 ** 30);
  expect(niceBytes(800)).toBe(1024);
  expect(niceBytes(900 * 2 ** 20)).toBe(2 ** 30);
  expect(axisBytes(2 ** 30)).toBe("1 GiB");
  expect(axisBytes(null)).toBe("—");
  // A 2.5 top would put 1.25 GiB at the midpoint, labelled 1.3 GiB.
  expect(niceBytes(2.2 * 2 ** 30)).toBe(5 * 2 ** 30);
  expect(axisBytes(niceBytes(2.2 * 2 ** 30) / 2)).toBe("2.5 GiB");
});
