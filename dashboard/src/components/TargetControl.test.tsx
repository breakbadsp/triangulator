import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FleetPage } from "./FleetPage";

let control: unknown;
let write: (body: Record<string, unknown>) => Response | Promise<Response>;
let calls: { body: Record<string, unknown>; options: RequestInit }[];
let reads: string[];
const targets = [
  { key: "h/api", host: "h", id: "api", pid: 10, local: true, status: "live" },
  {
    key: "h/busy",
    host: "h",
    id: "busy",
    pid: 20,
    local: true,
    status: "live",
  },
  {
    key: "other/api",
    host: "other",
    id: "api",
    pid: 30,
    local: false,
    status: "live",
  },
];
const configured = [
  { id: "api", target: "10" },
  { id: "busy", target: "20" },
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
function edit(id = "orders", target = "worker") {
  fireEvent.change(el("target-id"), { target: { value: id } });
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
  control = { enabled: true, host: "h", targets: configured };
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
test("confirmed Add sends one check and apply with the dashboard headers and trimmed identity", async () => {
  await start();
  open();
  edit(" orders ", " 1234 ");
  const pending = deferred();
  write = () => pending.promise;
  fireEvent.submit(el("target-form"));
  fireEvent.submit(el("target-form"));
  expect(calls).toHaveLength(1);
  expect(input("target-id").disabled).toBe(true);
  expect(input("target-input").disabled).toBe(true);
  expect(el("target-save").hasAttribute("disabled")).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  write = () => Response.json({ message: "Reload requested." });
  await act(async () => {
    pending.resolve(Response.json({}));
    await pending.promise;
  });
  expect(calls.map((call) => call.body)).toEqual([
    { action: "add", id: "orders", target: "1234", check: true },
    { action: "add", id: "orders", target: "1234" },
  ]);
  for (const { options } of calls)
    expect(options.headers).toEqual({
      "Content-Type": "application/json",
      "X-Triangulator": "1",
    });
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    "Add orders? This changes monitoring for every viewer.",
  );
  expect(document.getElementById("target-settings")).toBeNull();
  expect(status()).toBe("Reload requested.");
  expect(reads.filter((url) => url === "/api/targets/control")).toHaveLength(2);
});

// Old tests 2987, 3008, 3141.
test("Remove uses the configured selector only on the local host and protects the last target", async () => {
  await start();
  const removes = screen.getAllByRole("button", { name: /^Remove target/ });
  expect(removes.map((button) => button.getAttribute("aria-label"))).toEqual([
    "Remove target api",
    "Remove target busy",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Remove target busy" }));
  await tick();
  expect(calls.map((call) => call.body)).toEqual([
    { action: "remove", key: "h/busy", id: "busy", target: "20" },
  ]);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    "Remove busy? This changes monitoring for every viewer.",
  );
  expect(status()).toBe("Reload requested.");
  control = { enabled: true, host: "h", targets: configured.slice(0, 1) };
  await poll();
  expect(
    screen.queryByRole("button", { name: "Remove target busy" }),
  ).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Remove target api",
    }).disabled,
  ).toBe(true);
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
    { action: "remove", key: "h/busy", id: "busy", target: "20" },
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
  expect(input("target-id").value).toBe("orders");
  expect(reads.filter((url) => url === "/api/targets/control")).toHaveLength(2);
});

// Old test 3160: polling owns only control, including quiet unavailability.
test("polls refresh Remove while preserving dirty inputs, candidates and status", async () => {
  await start();
  open();
  edit();
  write = () =>
    Response.json(
      {
        error: "ambiguous",
        candidates: [
          { pid: 4100, user: "app", started_at: null, command: "worker" },
        ],
      },
      { status: 409 },
    );
  await submit();
  const before = status();
  const picker = el("target-pid");
  control = {
    enabled: true,
    host: "h",
    targets: configured.slice(0, 1),
    error: "new poll error",
  };
  await poll();
  expect(input("target-id").value).toBe("orders");
  expect(input("target-input").value).toBe("worker");
  expect(el("target-pid")).toBe(picker);
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
  control = { enabled: true, host: "h", targets: configured };
  await start();
  open();
  edit();
  const pending = deferred();
  write = () => pending.promise;
  fireEvent.submit(el("target-form"));
  control = { enabled: true, host: "other", targets: configured };
  await poll();
  await act(async () => {
    pending.resolve(Response.json({}));
    await pending.promise;
  });
  expect(calls).toHaveLength(1);
  expect(confirm).not.toHaveBeenCalled();
  expect(status()).toContain("Target control changed");
});

// Old tests 3197, 3220.
test("ambiguous names list PID, user, age and command; selection and validation clear old candidates", async () => {
  await start();
  open();
  edit();
  write = () =>
    Response.json(
      {
        error: "ambiguous",
        candidates: [
          {
            pid: 4100,
            user: "app",
            started_at: Date.now() / 1000 - 7200,
            command: "worker --queue orders",
          },
          {
            pid: 4377,
            user: "app",
            started_at: null,
            command: "worker --queue billing",
          },
        ],
      },
      { status: 409 },
    );
  await submit();
  const options = within(el("target-pid")).getAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual([
    "Select one of 2 listed",
    "PID 4100 · app · started 2 h ago · worker --queue orders",
    "PID 4377 · app · worker --queue billing",
  ]);
  expect(document.activeElement).toBe(el("target-pid"));
  fireEvent.change(el("target-pid"), { target: { value: "4377" } });
  expect(input("target-input").value).toBe("4377");
  expect(status()).toContain("does not follow a restart");
  expect(document.activeElement).toBe(el("target-save"));
  edit();
  write = () =>
    Response.json(
      {
        error: "ambiguous",
        total: 25,
        candidates: Array.from({ length: 20 }, (_, i) => ({
          pid: 5000 + i,
          user: "app",
          started_at: null,
          command: "worker",
        })),
      },
      { status: 409 },
    );
  await submit();
  expect(within(el("target-pid")).getAllByRole("option")).toHaveLength(21);
  expect(status()).toContain(
    "25 processes are named worker; the first 20 are listed",
  );
  fireEvent.change(el("target-id"), { target: { value: "." } });
  await submit();
  expect(document.getElementById("target-candidates")).toBeNull();
  expect(calls).toHaveLength(2);
  fireEvent.click(el("target-cancel"));
  open();
  expect(document.getElementById("target-candidates")).toBeNull();
});

// Old test 3180. Real showModal/portal interaction is also in prove_dashboard.mjs.
test("dialog Help opens its guide inside the modal and closes with it", async () => {
  await start();
  open();
  const label = el("target-id").closest<HTMLElement>("[data-help]");
  if (!label) throw Error("Missing Target ID help");
  fireEvent.click(within(label).getByRole("button", { name: /^Explain / }));
  const guide = document.getElementById("help-guide");
  expect(guide && el("target-settings").contains(guide)).toBe(true);
  fireEvent.click(el("target-cancel"));
  expect(document.getElementById("help-guide")).toBeNull();
});

test("discovery Add needs only a name and explains all matching instances", async () => {
  control = { enabled: true, mode: "names", host: "h", targets: [] };
  await start();
  open();
  expect(document.getElementById("target-id")).toBeNull();
  fireEvent.change(el("target-input"), { target: { value: "orders-api" } });
  await submit();
  expect(calls.map((call) => call.body)).toEqual([
    { action: "add", target: "orders-api", check: true },
    { action: "add", target: "orders-api" },
  ]);
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    "Add the process name orders-api? Every process with this name is monitored. This changes monitoring for every viewer.",
  );
});

test("discovery distinguishes waiting and capacity and blocks pattern and remote Remove", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation((input) => {
      if (input === "/api/targets/control")
        return Promise.resolve(
          Response.json({
            enabled: true,
            mode: "names",
            host: "h",
            targets: [],
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
  expect(
    screen.getByRole<HTMLButtonElement>("button", {
      name: "Remove target worker",
    }).disabled,
  ).toBe(true);
  expect(
    screen.queryByRole("button", { name: "Remove target remote" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Remove target wait" }));
  await tick();
  expect(confirm).toHaveBeenCalledExactlyOnceWith(
    "Remove the process name wait? Every process named wait stops being monitored. This changes monitoring for every viewer.",
  );
});
