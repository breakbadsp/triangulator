import { expect, test } from "vitest";
import { byteLength, draftRules, watchProblems } from "./watchEditor";

const limits = {
  prefix_max_bytes: 15,
  wake_ms_min: 10,
  wake_ms_max: 3600000,
  max_rules: 64,
};
// kMaxRequestBodyBytes in collector/http.hpp.
const MAX_BODY_BYTES = 16384;
const bodyBytes = (body: unknown) =>
  new TextEncoder().encode(JSON.stringify(body)).length;

test("no rule list that passes the checks reaches the 16 KiB request limit", () => {
  // JSON escapes a control character as 6 characters, its largest growth.
  for (const text of [
    "a",
    "\u0001",
    "\u001f",
    '"',
    "\\",
    "\n",
    "é",
    "€",
    "😀",
    "\ud800",
  ])
    expect(bodyBytes(text) - 2, JSON.stringify(text)).toBeLessThanOrEqual(
      6 * byteLength(text),
    );
  const rule = (index: number) => ({
    id: index,
    // 15 bytes: 13 control characters and two letters that keep it unique.
    prefix:
      "\u0001".repeat(13) +
      String.fromCharCode(65 + Math.floor(index / 26), 65 + (index % 26)),
    wake: String(limits.wake_ms_max),
  });
  const draft = Array.from({ length: limits.max_rules }, (_, index) =>
    rule(index),
  );
  expect(
    watchProblems(draft, limits).filter(
      (problem) => problem.prefix || problem.wake,
    ),
  ).toEqual([]);
  // postJson sends JSON.stringify of this body.
  expect(bodyBytes({ rules: draftRules(draft) })).toBeLessThan(MAX_BODY_BYTES);
  // The bound: every prefix byte escaped, even with repeated prefixes.
  const worst = Array.from({ length: limits.max_rules }, () => ({
    prefix: "\u0001".repeat(limits.prefix_max_bytes),
    wake_ms: limits.wake_ms_max,
  }));
  expect(bodyBytes({ rules: worst })).toBe(7819);
});
