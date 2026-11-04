import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FleetPage } from "./FleetPage";

let control: unknown;
let write: (body: Record<string, unknown>) => Response | Promise<Response>;
let calls: { body: Record<string, unknown>; options: RequestInit }[];
let reads: string[];
// Discovered targets: the exact name in process_names selects each one.
const named = { name_selected: true };
const targets = [
  {
    key: "h/api",
    host: "h",
    id: "api",
    pid: 10,
    local: true,
    status: "live",
    rule: "api",
    ...named,
  },
  {
    key: "h/busy",
    host: "h",
    id: "busy",
    pid: 20,
    local: true,
    status: "live",
    rule: "busy",
    ...named,
  },
  {
    key: "other/api",
    host: "other",
    id: "api",
    pid: 30,
    local: false,
    status: "live",
    rule: "api",
    ...named,
  },
];
const tick = () => act(() => vi.advanceTimersByTimeAsync(0));
const poll = () => act(() => vi.advanceTimersByTimeAsync(5000));
function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error("Missing " + id);
  return found;
}
function input(id: string) {
  const found = el(id);
  if (!(found instanceof HTMLInputElement))
    throw new Error("Not an input: " + id);
  return found;
}
const status = () => el("fleet-status").textContent;
function edit(target = "worker") {
  fireEvent.change(el("target-input"), { target: { value: target } });
}
async function start() {
  const app = render(<FleetPage />);
  await tick();
  return app;
}
function open() {
  fireEvent.click(el("fleet-add"));
}
async function submit() {
  fireEvent.submit(el("target-form"));
  await tick();
}
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-24T00:00:00Z"));
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = true;
      },
    },
    close: {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.open = false;
      },
    },
  });
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  history.replaceState(null, "", "/");
  localStorage.clear();
  control = { enabled: true, host: "h" };
  calls = [];
  reads = [];
  write = () => Response.json({ message: "Reload requested." });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async (input, options) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (options?.method === "POST") {
        const body: Record<string, unknown> = JSON.parse(
          typeof options.body === "string" ? options.body : "null",
        ) as Record<string, unknown>;
        calls.push({ body, options });
        return await write(body);
      }
      reads.push(url);
      if (url === "/api/targets/control") return Response.json(control);
      if (url === "/api/targets") return Response.json({ targets });
      if (url === "/api/fleet")
        return Response.json({ list: { targets }, live: {} });
      return Response.json({
        health: { pid: 10, last_seen: Date.now() / 1000 },
        threads: [],
      });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Old tests 145, 2987: one check, confirmation, one apply, and disabled inputs.
test("confirmed Add sends one check and apply with the dashboard headers and the trimmed name", async () => {
  await start();
  open();
  edit(" orders-api ");
  const pending = deferred();
  write = () => pending.promise;
  fireEvent.submit(el("target-form"));
  fireEvent.submit(el("target-form"));
  expect(calls).toHaveLength(1);
  expect(input("target-input").disabled).toBe(true);
  expect(el("target-save").hasAttribute("disabled")).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  write = () => Response.json({ message: "Reload requested." });
  await act(async () => {
    pending.resolve(Response.json({}));
    await pending.promise;
  });
  expect(calls.map((call) => call.body)).toEqual([
    { action: "add", target: "orders-api", check: true },
    { action: "add", target: "orders-api" },
  ]);
  for (const { options } of calls)
    expect(options.headers).toEqual({
      "Content-Type": "application/json",
      "X-Triangulator": "1",
    });
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    "Add the process name orders-api? Every process with this name is monitored. This changes monitoring for every viewer.",
  );
  expect(document.getElementById("target-settings")).toBeNull();
  expect(status()).toBe("Reload requested.");
  expect(reads.filter((url) => url === "/api/targets/control")).toHaveLength(2);
});

// Old tests 2987, 3008, 3141.
test("Remove sends the exact name only on the local host and shows a refusal", async () => {
  await start();
  const removes = screen.getAllByRole("button", { name: /^Remove target/ });
  expect(removes.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Remove target api",
    "Remove target busy",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Remove target busy" }));
  await tick();
  expect(calls.map((call) => call.body)).toEqual([
    { action: "remove", key: "h/busy", id: "busy", rule: "busy" },
  ]);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    "Remove the process name busy? Every process named busy stops being monitored. This changes monitoring for every viewer.",
  );
  expect(status()).toBe("Reload requested.");
  // The helper refuses to remove the last rule; the dashboard shows why.
  write = () =>
    Response.json(
      { error: "keep at least one process name or pattern" },
      { status: 400 },
    );
  fireEvent.click(screen.getByRole("button", { name: "Remove target api" }));
  await tick();
  expect(status()).toBe("keep at least one process name or pattern");
  expect(calls).toHaveLength(2);
  control = { enabled: false, error: "local sampler verification failed" };
  await poll();
  expect(screen.queryByRole("button", { name: /^Remove target/ })).toBeNull();
});

test("Add and Remove share a synchronous guard, including programmatic submits", async () => {
  await start();
  open();
  edit();
  const pending = deferred();
  write = () => pending.promise;
  fireEvent.click(screen.getByRole("button", { name: "Remove target busy" }));
  fireEvent.submit(el("target-form"));
  fireEvent.submit(el("target-form"));
  expect(calls.map((call) => call.body)).toEqual([
    { action: "remove", key: "h/busy", id: "busy", rule: "busy" },
  ]);
  await act(async () => {
    pending.resolve(Response.json({ message: "Removed." }));
    await pending.promise;
  });
  expect(status()).toBe("Removed.");
});

test("cancelled confirmations never apply and closing during a check prevents its later confirmation", async () => {
  vi.mocked(confirm).mockReturnValue(false);
  await start();
  open();
  edit();
  await submit();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body.check).toBe(true);
  expect(input("target-input").value).toBe("worker");
  fireEvent.click(screen.getByRole("button", { name: "Remove target api" }));
  await tick();
  expect(calls).toHaveLength(1);
  const pending = deferred();
  write = () => pending.promise;
  fireEvent.submit(el("target-form"));
  fireEvent.click(el("target-cancel"));
  await act(async () => {
    pending.resolve(Response.json({}));
    await pending.promise;
  });
  expect(calls).toHaveLength(2);
  expect(confirm).toHaveBeenCalledTimes(2);
  open();
  expect(input("target-input").value).toBe("");
});

// Old tests 175, 3008: reject before confirmation; keep inputs; allow retry.
test.each([400, 403, 409, 503])(
  "HTTP %i rejection stays visible with form state and no confirmation",
  async (code) => {
    await start();
    open();
    edit();
    write = () =>
      Response.json({ error: "Rejected by helper" }, { status: code });
    await submit();
    expect(status()).toBe("Rejected by helper");
    expect(el("target-status").className).toBe("bad");
    expect(input("target-input").value).toBe("worker");
    expect(input("target-input").disabled).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    write = () => {
      throw new Error("Connection lost");
    };
    await submit();
    expect(status()).toBe("Connection lost");
    write = () => new Response("not JSON", { status: 503 });
    await submit();
    expect(status()).toBe("Unable to change targets (HTTP 503)");
    write = () => Response.json({ message: "Retried." });
    await submit();
    expect(status()).toBe("Retried.");
    expect(confirm).toHaveBeenCalledTimes(1);
  },
);

test("an applied error is reported and refreshes control without an automatic retry", async () => {
  await start();
  open();
  edit();
  write = (body) =>
    body.check
      ? Response.json({})
      : Response.json(
          { error: "Applied, but reload failed", applied: true },
          { status: 503 },
        );
  await submit();
  expect(calls).toHaveLength(2);
  expect(status()).toBe("Applied, but reload failed");
  expect(input("target-input").value).toBe("worker");
  expect(reads.filter((url) => url === "/api/targets/control")).toHaveLength(2);
});

// Old test 3160: polling owns only control, including quiet unavailability.
test("polls refresh Remove while preserving dirty inputs and status", async () => {
  await start();
  open();
  edit();
  write = () => Response.json({ error: "rejected" }, { status: 409 });
  await submit();
  const before = status();
  control = { enabled: true, host: "h", error: "new poll error" };
  await poll();
  expect(input("target-input").value).toBe("worker");
  expect(status()).toBe(before);
  control = { enabled: false, error: "remote dashboard" };
  await poll();
  expect(el("fleet-add").hasAttribute("disabled")).toBe(true);
  expect(status()).toBe(before);
  expect(screen.queryByRole("button", { name: /^Remove target/ })).toBeNull();
  expect(el("target-save").hasAttribute("disabled")).toBe(true);
});

test("unavailable control is quiet and a control host change during check prevents apply", async () => {
  control = { enabled: false };
  const app = await start();
  expect(document.getElementById("fleet-add")).toBeNull();
  expect(status()).toBe("");
  app.unmount();
  control = { enabled: true, host: "h" };
  await start();
  open();
  edit();
  const pending = deferred();
  write = () => pending.promise;
  fireEvent.submit(el("target-form"));
  control = { enabled: true, host: "other" };
  await poll();
  await act(async () => {
    pending.resolve(Response.json({}));
    await pending.promise;
  });
  expect(calls).toHaveLength(1);
  expect(confirm).not.toHaveBeenCalled();
  expect(status()).toContain("Target control changed");
});

// Old test 3180. Real showModal/portal interaction is also in prove_dashboard.mjs.
test("dialog Help opens its guide inside the modal and closes with it", async () => {
  await start();
  open();
  const label = el("target-dialog-title").closest<HTMLElement>("[data-help]");
  if (!label) throw Error("Missing process name help");
  fireEvent.click(within(label).getByRole("button", { name: /^Explain / }));
  const guide = document.getElementById("help-guide");
  expect(guide && el("target-settings").contains(guide)).toBe(true);
  fireEvent.click(el("target-cancel"));
  expect(document.getElementById("help-guide")).toBeNull();
});

test("Add accepts only an exact process name, not a PID", async () => {
  await start();
  open();
  for (const value of ["1234 5", "..", "0123456789abcdef"]) {
    edit(value);
    await submit();
    expect(el("target-status").className).toBe("bad");
  }
  expect(calls).toHaveLength(0);
});

test("discovery distinguishes waiting and capacity and blocks pattern and remote Remove", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation((input) => {
      if (input === "/api/targets/control")
        return Promise.resolve(
          Response.json({
            enabled: true,
            host: "h",
          }),
        );
      return Promise.resolve(
        Response.json({
          list: {
            targets: [
              {
                key: "h/worker",
                host: "h",
                id: "worker",
                pid: 10,
                status: "live",
                local: true,
                rule: "worker",
                name_selected: true,
                other_rule_selected: true,
                excluded: 2,
              },
              {
                key: "h/wait",
                host: "h",
                id: "wait",
                pid: 0,
                status: "absent",
                local: true,
                rule: "wait",
                name_selected: true,
              },
              {
                key: "h/remote",
                host: "h",
                id: "remote",
                pid: 20,
                status: "live",
                local: false,
                rule: "remote",
                name_selected: true,
              },
            ],
          },
          live: {},
        }),
      );
    }),
  );
  await start();
  expect(screen.getByText("Waiting for a process named wait")).toBeTruthy();
  expect(
    screen.getByText(/2 matching processes on h are not monitored/),
  ).toBeTruthy();
  expect(screen.queryByText(/^Another rule selects this process/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove target worker" }));
  await tick();
  expect(screen.getByText(/^Another rule selects this process/)).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(screen.queryByText(/^Another rule selects this process/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove target worker" }));
  expect(screen.getByText(/^Another rule selects this process/)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Remove target remote" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove target wait" }));
  await tick();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    "Remove the process name wait? Every process named wait stops being monitored. This changes monitoring for every viewer.",
  );
});
