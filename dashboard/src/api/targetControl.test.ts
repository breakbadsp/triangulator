import { afterEach, expect, test, vi } from "vitest";
import {
  changeTargets,
  parseTargetControl,
  readTargetControl,
} from "./targetControl";
afterEach(() => vi.unstubAllGlobals());
test("the control boundary rejects malformed lists and hides unavailable replies", async () => {
  expect(parseTargetControl(null)).toEqual({ enabled: false });
  expect(parseTargetControl({ enabled: "true", targets: [] })).toEqual({
    enabled: false,
  });
  expect(
    parseTargetControl({
      enabled: true,
      host: "h",
      targets: [{ id: "one", target: 1 }],
    }),
  ).toEqual({ enabled: true, host: "h", targets: null, error: "" });
  expect(
    parseTargetControl({ enabled: true, error: "sampler stopped" }),
  ).toEqual({
    enabled: true,
    host: "",
    targets: null,
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
    });
  }
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  expect(await readTargetControl(new AbortController().signal)).toEqual({
    enabled: false,
  });
});
test("the write boundary parses candidate and applied error fields without trusting malformed data", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json(
        {
          error: "Ambiguous",
          applied: true,
          total: "25",
          candidates: [
            null,
            { pid: -1 },
            { pid: 4, user: "app", started_at: null, command: "worker" },
          ],
        },
        { status: 503 },
      ),
    ),
  );
  expect(
    await changeTargets({ action: "add", id: "one", target: "worker" }, true),
  ).toEqual({
    kind: "failed",
    message: "Ambiguous",
    applied: true,
    total: 1,
    candidates: [{ pid: 4, user: "app", started_at: null, command: "worker" }],
  });
});
