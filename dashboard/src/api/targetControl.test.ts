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

test("retained removal sends its session and uses the protected collector endpoint", async () => {
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json({ message: "Removed" }));
  vi.stubGlobal("fetch", request);
  await changeTargets({ action: "forget", key: "h/api", session: "10" });
  expect(request).toHaveBeenCalledWith("/api/targets/retained/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Triangulator": "1" },
    body: JSON.stringify({ action: "forget", key: "h/api", session: "10" }),
  });
});

test("a retained removal preflight never writes", async () => {
  const request = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", request);
  const result = await changeTargets(
    { action: "forget", key: "h/api", session: "10" },
    true,
  );
  expect(result.kind).toBe("failed");
  expect(request).not.toHaveBeenCalled();
});
