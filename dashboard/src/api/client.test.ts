import { afterEach, expect, test, vi } from "vitest";
import { ApiError, getJson, postJson } from "./client";
import { readPage } from "../page";

const signal = new AbortController().signal;
afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

test("reads fleet, explicit target, and default target pages", () => {
  expect(readPage("")).toEqual({ kind: "fleet" });
  expect(readPage("?target=host%2Fworker")).toEqual({
    kind: "target",
    key: "host/worker",
  });
  expect(readPage("?target=")).toEqual({ kind: "target", key: "" });
});

test("scopes API reads while preserving query parameters and global endpoints", async () => {
  history.replaceState(null, "", "/?target=rack%2Fworker%20%26%20one");
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(Response.json({ ok: true })));
  vi.stubGlobal("fetch", fetchMock);
  expect(await getJson("/api/live", signal)).toEqual({ ok: true });
  await getJson("/api/history?seconds=20", signal);
  await getJson("/api/targets", signal);
  await getJson("/api/targets/control", signal);
  await getJson("/health", signal);
  expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
    "/api/live?target=rack%2Fworker+%26+one",
    "/api/history?seconds=20&target=rack%2Fworker+%26+one",
    "/api/targets",
    "/api/targets/control",
    "/health",
  ]);
  expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(signal);
});

test.each(["/", "/?target="])(
  "leaves default reads unscoped at %s",
  async (url) => {
    history.replaceState(null, "", url);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetchMock);
    await getJson("/api/live", signal);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/live");
  },
);

test("posts scoped JSON with the collector header and optional revision", async () => {
  history.replaceState(null, "", "/?target=host%2Fworker");
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(Response.json({ saved: true })));
  vi.stubGlobal("fetch", fetchMock);
  expect(
    await postJson("/api/watches", { rules: [] }, { ifMatch: '"revision-3"' }),
  ).toEqual({ saved: true });
  expect(fetchMock).toHaveBeenLastCalledWith(
    "/api/watches?target=host%2Fworker",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Triangulator": "1",
        "If-Match": '"revision-3"',
      },
      body: '{"rules":[]}',
    },
  );
  await postJson("/api/targets/control", { action: "add" });
  expect(fetchMock).toHaveBeenLastCalledWith("/api/targets/control", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Triangulator": "1" },
    body: '{"action":"add"}',
  });
});

test.each([false, true])(
  "preserves HTTP status and collector errors for POST=%s",
  async (post) => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            { error: "Selected target is unavailable" },
            { status: 404 },
          ),
        ),
    );
    const request = post
      ? postJson("/api/watches", {})
      : getJson("/api/live", signal);
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      status: 404,
      message: "Selected target is unavailable",
      body: { error: "Selected target is unavailable" },
    });
  },
);

test("reports a non-JSON HTTP error as ApiError", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockResolvedValue(
      new Response("unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    ),
  );
  await expect(getJson("/api/live", signal)).rejects.toMatchObject({
    name: "ApiError",
    status: 503,
    message: "Service Unavailable",
  });
});

test("a write can be cancelled with the signal of its owner", async () => {
  const fetchMock = vi.fn<typeof fetch>((_input, init) => {
    const own = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      own?.addEventListener("abort", () => {
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const owner = new AbortController();
  const write = postJson("/api/watches", {}, { signal: owner.signal });
  owner.abort();
  await expect(write).rejects.toMatchObject({ name: "AbortError" });
  expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(owner.signal);
});
