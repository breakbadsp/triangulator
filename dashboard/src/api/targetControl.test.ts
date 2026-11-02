import { afterEach, expect, test, vi } from "vitest";
import {
  changeTargets,
  parseTargetControl,
  readTargetControl,
} from "./targetControl";
afterEach(() => vi.unstubAllGlobals());
test("the control boundary rejects malformed lists and hides unavailable replies", async () => {
  expect(parseTargetControl(null)).toEqual({ enabled: false, reason: "" });
  expect(parseTargetControl({ enabled: "true", targets: [] })).toEqual({
    enabled: false,
    reason: "",
  });
  expect(parseTargetControl({ enabled: true, host: "h" })).toEqual({
    enabled: true,
    host: "h",
    error: "",
  });
  expect(
    parseTargetControl({ enabled: true, error: "sampler stopped" }),
  ).toEqual({
    enabled: true,
    host: "",
    error: "sampler stopped",
  });
  for (const response of [
    new Response("missing", { status: 404 }),
    new Response("not JSON"),
    Response.json(null),
  ]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(await readTargetControl(new AbortController().signal)).toEqual({
      enabled: false,
      reason: "",
    });
  }
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  expect(await readTargetControl(new AbortController().signal)).toEqual({
    enabled: false,
    reason: "",
  });
});
test("the write boundary reads the error and applied fields", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: "Rejected", applied: true, candidates: [{ pid: 4 }] },
          { status: 503 },
        ),
      ),
  );
  expect(
    await changeTargets({ action: "add", target: "worker" }, true),
  ).toEqual({ kind: "failed", message: "Rejected", applied: true });
});
