import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { Thread, WatchInfo, WatchRule } from "../api/types";
import { helpTopics } from "../help/topics";
import { WatchRules } from "./WatchRules";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const limits = {
  prefix_max_bytes: 15,
  wake_ms_min: 10,
  wake_ms_max: 3600000,
  max_rules: 64,
};
const watchReply = (
  rules: WatchRule[],
  extra: Partial<WatchInfo> = {},
): WatchInfo => ({
  rules,
  source: "config",
  saved_error: null,
  revision: "test-1",
  limits,
  ...extra,
});
const reply = (body: unknown, status = 200) =>
  Promise.resolve(Response.json(body, { status }));
type Handler = (url: string) => Promise<Response>;
interface Write {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fake collector: GET answers with `read`, POST with `write`. */
function collector(read: Handler, write: Handler) {
  const server = { read, write, reads: 0, writes: [] as Write[] };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        server.writes.push({
          url: input,
          headers: init.headers as Record<string, string>,
          // postJson sends a JSON string.
          body: JSON.parse(init.body as string),
        });
        return server.write(input);
      }
      server.reads++;
      return server.read(input);
    }),
  );
  return server;
}
function show(threads: readonly Thread[] = [], opened = 0) {
  const onChanged = vi.fn();
  const view = render(
    <WatchRules threads={threads} opened={opened} onChanged={onChanged} />,
  );
  const rerender = (next: readonly Thread[] = threads, again = opened) => {
    view.rerender(
      <WatchRules threads={next} opened={again} onChanged={onChanged} />,
    );
  };
  return { onChanged, rerender };
}
async function editor(
  info = watchReply([{ prefix: "worker-", wake_ms: 500 }]),
  write: Handler = () => reply(info),
  threads: readonly Thread[] = [],
) {
  const server = collector(() => reply(info), write);
  const view = show(threads);
  await screen.findByRole("button", { name: "Save" });
  return { server, ...view };
}
const button = (name: string) => screen.getByRole("button", { name });
const queryButton = (name: string) => screen.queryByRole("button", { name });
const field = (row: number, kind: "prefix" | "wake") =>
  screen.getByLabelText<HTMLInputElement>(
    `${kind === "prefix" ? "Thread name prefix" : "Wakes at least every (ms)"}, rule ${String(row + 1)}`,
  );
const type = (row: number, kind: "prefix" | "wake", text: string) => {
  fireEvent.change(field(row, kind), { target: { value: text } });
};
const error = (row: number, kind: "prefix" | "wake") =>
  document.getElementById(
    field(row, kind).getAttribute("aria-describedby") ?? "",
  )?.textContent;
const text = (id: string) => document.getElementById(id)?.textContent ?? null;
const saveDisabled = () => (button("Save") as HTMLButtonElement).disabled;
const resetDisabled = () =>
  (button("Reset to config file") as HTMLButtonElement).disabled;
const status = async (expected: string | RegExp) => {
  await waitFor(() => {
    expect(text("watch-status")).toMatch(expected);
  });
};
const answer = (value: boolean) => {
  const confirm = vi.fn(() => value);
  vi.stubGlobal("confirm", confirm);
  return confirm;
};

test("watch rule fields are checked against the collector limits, and Save follows", async () => {
  await editor();
  expect(saveDisabled(), "nothing changed").toBe(true);
  expect(text("watch-source")).toBe("From the config file (collector.toml).");
  expect(resetDisabled(), "nothing saved to reset").toBe(true);
  type(0, "prefix", "");
  expect(error(0, "prefix")).toBe("Enter a prefix.");
  expect(saveDisabled()).toBe(true);
  type(0, "prefix", "é".repeat(8));
  expect(
    error(0, "prefix"),
    "the limit counts UTF-8 bytes, not characters",
  ).toMatch(/Too long: 16 bytes/);
  type(0, "prefix", "é".repeat(7));
  expect(error(0, "prefix")).toBe("");
  for (const [wake, message] of [
    ["", /Enter a number/],
    ["5", /At least 10 ms/],
    ["1.5", /whole number/],
    ["1e3", /whole number/],
    ["-5", /whole number/],
    ["3600001", /At most 3,600,000 ms/],
  ] as const) {
    type(0, "wake", wake);
    expect(error(0, "wake"), wake).toMatch(message);
    expect(field(0, "wake").getAttribute("aria-invalid")).toBe("true");
    expect(saveDisabled(), wake).toBe(true);
  }
  type(0, "wake", " 250 ");
  expect(error(0, "wake")).toBe("");
  expect(saveDisabled()).toBe(false);
  expect(text("watch-unsaved")).toMatch(
    /^Unsaved edits\. They apply only after you select Save/,
  );
  // Back to the saved list: nothing to save or warn about.
  type(0, "prefix", "worker-");
  type(0, "wake", "500");
  expect(saveDisabled()).toBe(true);
  expect(text("watch-unsaved")).toBeNull();
  // A duplicate prefix is marked on the later rule.
  fireEvent.click(button("Add rule"));
  expect(document.activeElement, "Add focuses the new prefix").toBe(
    field(1, "prefix"),
  );
  type(1, "prefix", "worker-");
  type(1, "wake", "100");
  expect(error(1, "prefix")).toMatch(/Same prefix as rule 1/);
  expect(saveDisabled()).toBe(true);
  expect(text("watch-unsaved")).toMatch(/Fix the marked fields/);
  fireEvent.click(button("Remove rule 2"));
  expect(document.activeElement, "Remove focuses Add rule").toBe(
    button("Add rule"),
  );
});

test("the rule limit stops Add", async () => {
  await editor(
    watchReply(
      Array.from({ length: 63 }, (_, row) => ({
        prefix: `p${String(row)}`,
        wake_ms: 500,
      })),
    ),
  );
  expect((button("Add rule") as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button("Add rule"));
  expect((button("Add rule") as HTMLButtonElement).disabled).toBe(true);
  expect(text("watch-limit")).toBe("At most 64 rules.");
});

test("matching threads now counts live threads with the longest prefix, as the collector does", async () => {
  const threads = [
    "worker-1",
    "worker-2",
    "worker-io-1",
    "worker-io-1",
    "main",
  ].map((name, index) => ({ tid: index + 1, name }));
  const { rerender } = await editor(
    watchReply([
      { prefix: "worker-", wake_ms: 500 },
      { prefix: "worker-io", wake_ms: 2000 },
    ]),
    undefined,
    threads,
  );
  const cells = () =>
    [...document.querySelectorAll("#watch-rows tr")].map((row) => [
      row.querySelector(".watch-count")?.textContent,
      row.querySelector(".watch-names")?.textContent,
    ]);
  expect(cells()).toEqual([
    [
      "2",
      "worker-1, worker-2. 2 more threads start with this prefix but use a longer rule.",
    ],
    ["2", "worker-io-1 (×2)"],
  ]);
  // Typing updates the count at once; a prefix nothing starts with says so.
  type(1, "prefix", "Worker-io");
  expect(cells()).toEqual([
    ["4", "worker-1, worker-2, worker-io-1 (×2)"],
    ["0", "No live thread name starts with this prefix."],
  ]);
  // A duplicate prefix ties with the first rule; it is not "a longer rule".
  type(1, "prefix", "worker-io");
  fireEvent.click(button("Add rule"));
  type(2, "prefix", "worker-io");
  expect(cells()[2]).toEqual([
    "0",
    "No live thread name starts with this prefix.",
  ]);
  expect(cells()[2]?.[0]).toBe("0");
  // No target: nothing to count against, and the note says so instead of
  // blaming the prefix. A live poll keeps the draft.
  rerender([]);
  expect(cells()[1]).toEqual(["0", "No live threads to check against."]);
  expect(field(2, "prefix").value).toBe("worker-io");
});

test("saving sends the whole list with the guard header and shows the reply or the collector error", async () => {
  const saved = watchReply([{ prefix: "db-", wake_ms: 250 }], {
    source: "dashboard",
    revision: "test-2",
  });
  const { server, onChanged } = await editor(undefined, () => reply(saved));
  type(0, "prefix", "db-");
  type(0, "wake", "250");
  fireEvent.click(button("Save"));
  expect(text("watch-status")).toBe("Saving…");
  expect(field(0, "prefix").disabled, "fields wait for the reply").toBe(true);
  await status("Saved and applied.");
  expect(server.writes).toEqual([
    {
      url: "/api/watches",
      headers: {
        "Content-Type": "application/json",
        "X-Triangulator": "1",
        "If-Match": '"test-1"',
      },
      body: { rules: [{ prefix: "db-", wake_ms: 250 }] },
    },
  ]);
  expect(onChanged, "the Assessment re-reads the rules").toHaveBeenCalledOnce();
  expect(text("watch-source")).toBe(
    "Saved from the dashboard. These replace the [[watch]] rules in collector.toml until you reset.",
  );
  expect(saveDisabled()).toBe(true);
  expect(resetDisabled()).toBe(false);
  // The next write names the revision of the reply.
  type(0, "wake", "300");
  fireEvent.click(button("Save"));
  await waitFor(() => {
    expect(server.writes).toHaveLength(2);
  });
  expect(server.writes[1]?.headers["If-Match"]).toBe('"test-2"');
});

test("each refused or failed write keeps the draft and says how to continue", async () => {
  const cases = [
    [
      400,
      { error: 'watch rule 1 (prefix "x"): nope' },
      'watch rule 1 (prefix "x"): nope',
      false,
    ],
    [
      403,
      { error: "dashboard request required" },
      "dashboard request required",
      false,
    ],
    [403, {}, "The collector refused the change (HTTP 403).", false],
    [404, { error: "unknown target" }, "unknown target", false],
    [
      500,
      { error: "cannot write /d/watch-rules.json" },
      "cannot write /d/watch-rules.json",
      false,
    ],
    [
      503,
      { error: "target watch settings limit reached" },
      "target watch settings limit reached",
      false,
    ],
    [502, null, "The change failed (HTTP 502).", false],
    [
      428,
      { error: "Reload this dashboard before changing watched-thread rules." },
      "Reload this dashboard before changing watched-thread rules.",
      true,
    ],
    [
      409,
      { error: "Another user changed the watched-thread rules." },
      "Another user changed the watched-thread rules.",
      true,
    ],
  ] as const;
  for (const [code, body, message, conflict] of cases) {
    const { server } = await editor(undefined, () =>
      body
        ? reply(body, code)
        : Promise.resolve(new Response("bad gateway", { status: code })),
    );
    type(0, "wake", "250");
    fireEvent.click(button("Save"));
    await status(message);
    expect(server.writes, String(code)).toHaveLength(1);
    expect(document.getElementById("watch-status")?.className).toBe("bad");
    expect(field(0, "wake").value, "the draft is kept").toBe("250");
    expect(text("watch-unsaved")).not.toBeNull();
    expect(
      saveDisabled(),
      `${String(code)}: retry only without a conflict`,
    ).toBe(conflict);
    expect(!!queryButton("Reload current rules"), String(code)).toBe(conflict);
    expect(!!queryButton("Discard edits"), String(code)).toBe(!conflict);
    cleanup();
  }
  // The collector cannot be reached.
  await editor(undefined, () =>
    Promise.reject(new TypeError("Failed to fetch")),
  );
  type(0, "wake", "250");
  fireEvent.click(button("Save"));
  await status("Could not reach the collector: Failed to fetch");
  expect(field(0, "wake").value).toBe("250");
  expect(saveDisabled()).toBe(false);
});

test("two clicks on Save or Reset before a reply send one write", async () => {
  const saved = watchReply([{ prefix: "worker-", wake_ms: 250 }], {
    source: "dashboard",
  });
  let finish: (response: Response) => void = () => undefined;
  const { server } = await editor(
    undefined,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  type(0, "wake", "250");
  // Both clicks run before React renders the disabled button.
  act(() => {
    button("Save").click();
    button("Save").click();
  });
  expect(server.writes).toHaveLength(1);
  await act(async () => {
    finish(Response.json(saved));
    await Promise.resolve();
  });
  await status("Saved and applied.");
  answer(true);
  act(() => {
    button("Reset to config file").click();
    button("Reset to config file").click();
  });
  expect(server.writes).toHaveLength(2);
  expect(server.writes[1]?.url).toBe("/api/watches/reset");
});

test("a save the collector applied but could not confirm on disk shows the rules in force and a warning", async () => {
  const inForce = watchReply([{ prefix: "a", wake_ms: 100 }], {
    source: "dashboard",
    revision: "test-2",
  });
  const { onChanged } = await editor(watchReply([]), () =>
    reply(
      {
        error: "rules were applied, but persistence could not be confirmed",
        applied: true,
        applied_state: inForce,
      },
      500,
    ),
  );
  fireEvent.click(button("Add rule"));
  type(0, "prefix", "a");
  type(0, "wake", "100");
  fireEvent.click(button("Save"));
  await status(/^Warning: rules were applied/);
  expect(document.getElementById("watch-status")?.className).toBe("warning");
  expect(
    text("watch-unsaved"),
    "the list in force equals the list on screen",
  ).toBeNull();
  expect(onChanged).toHaveBeenCalledOnce();
});

test("reset asks first, mentions unsaved edits, and returns to the config file rules", async () => {
  const config = watchReply([{ prefix: "worker-", wake_ms: 500 }], {
    revision: "test-2",
  });
  const { server } = await editor(
    watchReply([{ prefix: "db-", wake_ms: 250 }], { source: "dashboard" }),
    () => reply(config),
  );
  const confirm = answer(false);
  type(0, "wake", "300");
  fireEvent.click(button("Reset to config file"));
  expect(server.writes, "declining the question changes nothing").toHaveLength(
    0,
  );
  expect(confirm).toHaveBeenCalledWith(
    "Discard the rules saved from the dashboard and use the [[watch]] rules from collector.toml? Your unsaved edits will also be lost.",
  );
  answer(true);
  fireEvent.click(button("Reset to config file"));
  await status("Reset. The rules from the config file are in force.");
  expect(server.writes).toEqual([
    {
      url: "/api/watches/reset",
      headers: {
        "Content-Type": "application/json",
        "X-Triangulator": "1",
        "If-Match": '"test-1"',
      },
      body: {},
    },
  ]);
  expect(text("watch-source")).toMatch(/^From the config file/);
  expect(field(0, "prefix").value).toBe("worker-");
  expect(field(0, "wake").value).toBe("500");
});

test("a collector without the endpoint and a broken saved file are explained", async () => {
  collector(
    () => reply({}, 404),
    () => reply({}, 404),
  );
  show();
  await waitFor(() => {
    expect(text("watch-readonly")).toMatch(/no \/api\/watches/);
  });
  expect(document.getElementById("watch-editor")).toBeNull();
  cleanup();

  await editor(
    watchReply([{ prefix: "worker-", wake_ms: 500 }], {
      saved_error: "watch-rules.json: bad rule",
    }),
  );
  expect(text("watch-warning")).toBe(
    "The rules saved from the dashboard could not be used: watch-rules.json: bad rule. The rules from the config file are in force. Save new rules, or reset to remove the saved file.",
  );
  expect(resetDisabled(), "reset removes the broken file").toBe(false);
});

test("an older collector without edit revisions keeps settings read-only", async () => {
  collector(
    () => reply(watchReply([], { revision: undefined })),
    () => reply({}, 500),
  );
  show();
  await waitFor(() => {
    expect(text("watch-readonly")).toMatch(/Update the collector/);
  });
  expect(document.getElementById("watch-editor")).toBeNull();
});

test("a first read that fails is explained and tried again every 5 s", async () => {
  vi.useFakeTimers();
  const server = collector(
    () => reply({}, 503),
    () => reply({}, 500),
  );
  show();
  const settle = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  await settle();
  expect(text("watch-readonly")).toBe(
    "Unable to load the watched-thread rules: The collector answered HTTP 503. Trying again…",
  );
  expect(server.reads).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(server.reads, "a second failure retries too").toBe(2);
  server.read = () => reply(watchReply([]));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(server.reads).toBe(3);
  expect(screen.getByRole("button", { name: "Save" })).toBeDefined();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20000);
  });
  expect(server.reads, "no retry after a good reply").toBe(3);
});

test("a rules read that an edit, a save or a reset overtook is dropped", async () => {
  const original = watchReply([{ prefix: "worker-", wake_ms: 500 }]);
  const saved = watchReply([{ prefix: "worker-", wake_ms: 100 }], {
    source: "dashboard",
    revision: "test-2",
  });
  const server = collector(
    () => reply(original),
    () => reply(saved),
  );
  const { rerender } = show();
  await screen.findByRole("button", { name: "Save" });
  let answerRead: (response: Response) => void = () => undefined;
  server.read = () =>
    new Promise((resolve) => {
      answerRead = resolve;
    });
  // Selecting Settings again reads while the fields stay editable.
  rerender(undefined, 1);
  expect(server.reads).toBe(2);
  type(0, "wake", "250");
  await act(async () => {
    answerRead(Response.json(watchReply([{ prefix: "other-", wake_ms: 9 }])));
    await Promise.resolve();
  });
  expect(field(0, "wake").value, "the edit made during the read is kept").toBe(
    "250",
  );
  expect(text("watch-unsaved")).not.toBeNull();
  // While the draft is dirty, selecting Settings sends no read at all.
  rerender(undefined, 2);
  expect(server.reads).toBe(2);
  // A reply that arrives after a save would put back the rules from before it.
  type(0, "wake", "500");
  rerender(undefined, 3);
  expect(server.reads).toBe(3);
  const answerLate = answerRead;
  type(0, "wake", "100");
  fireEvent.click(button("Save"));
  await status("Saved and applied.");
  expect(server.writes[0]?.headers["If-Match"]).toBe('"test-1"');
  await act(async () => {
    answerLate(Response.json(original));
    await Promise.resolve();
  });
  expect(field(0, "wake").value).toBe("100");
  expect(saveDisabled()).toBe(true);
  // The next save still names the revision of its own reply.
  type(0, "wake", "200");
  fireEvent.click(button("Save"));
  await waitFor(() => {
    expect(server.writes).toHaveLength(2);
  });
  expect(server.writes[1]?.headers["If-Match"]).toBe('"test-2"');
});

test("a failed first read that a newer read overtook shows no error", async () => {
  const answers: ((response: Response) => void)[] = [];
  const server = collector(
    () =>
      new Promise((resolve) => {
        answers.push(resolve);
      }),
    () => reply({}, 500),
  );
  const { rerender } = show();
  rerender(undefined, 1);
  expect(server.reads).toBe(2);
  await act(async () => {
    answers[0]?.(Response.json({}, { status: 503 }));
    await Promise.resolve();
  });
  expect(text("watch-readonly")).toBe("Loading the watched-thread rules…");
  await act(async () => {
    answers[1]?.(Response.json(watchReply([])));
    await Promise.resolve();
  });
  await screen.findByRole("button", { name: "Save" });
});

test("a change the collector applied but could not confirm can be repeated until it is confirmed", async () => {
  const unconfirmed = {
    error:
      "rules were applied, but persistence could not be confirmed for /d/watch-rules.json: Input/output error",
    applied: true,
  };
  const inForce = watchReply([{ prefix: "a", wake_ms: 100 }], {
    source: "dashboard",
    revision: "applied-1",
  });
  const { server } = await editor(watchReply([]), () =>
    reply({ ...unconfirmed, applied_state: inForce }, 500),
  );
  fireEvent.click(button("Add rule"));
  type(0, "prefix", "a");
  type(0, "wake", "100");
  fireEvent.click(button("Save"));
  await status(
    /^Warning: rules were applied.*Input\/output error\. Select Save again to retry\.$/,
  );
  expect(
    text("watch-unsaved"),
    "the rules in force equal the draft",
  ).toBeNull();
  expect(saveDisabled(), "Save stays on to retry").toBe(false);
  server.write = () => reply(inForce);
  fireEvent.click(button("Save"));
  await status("Saved and applied.");
  expect(server.writes.map((write) => write.headers["If-Match"])).toEqual([
    '"test-1"',
    '"applied-1"',
  ]);
  expect(saveDisabled(), "confirmed: nothing left to save").toBe(true);

  // Reset: the rules in force are the config file ones, so Reset would be
  // off without the retry.
  answer(true);
  const config = watchReply([], { revision: "applied-2" });
  server.write = () => reply({ ...unconfirmed, applied_state: config }, 500);
  fireEvent.click(button("Reset to config file"));
  await status(/Select Reset to config file again to retry\.$/);
  expect(text("watch-source")).toMatch(/^From the config file/);
  expect(resetDisabled(), "Reset stays on to retry").toBe(false);
  expect(saveDisabled()).toBe(true);
  server.write = () => reply(watchReply([], { revision: "applied-3" }));
  fireEvent.click(button("Reset to config file"));
  await status("Reset. The rules from the config file are in force.");
  expect(server.writes.at(-1)?.headers["If-Match"]).toBe('"applied-2"');
  expect(resetDisabled()).toBe(true);
});

test("conflicting saves and resets keep drafts and require an explicit reload", async () => {
  for (const kind of ["save", "reset"] as const) {
    const original = watchReply([{ prefix: "worker-", wake_ms: 500 }], {
      source: "dashboard",
      revision: "old",
    });
    const current = watchReply([{ prefix: "other-", wake_ms: 1000 }], {
      source: "dashboard",
      revision: "new",
    });
    const { server } = await editor(original, () =>
      reply({ error: "Another user changed the rules." }, 409),
    );
    type(0, "wake", "250");
    answer(true);
    fireEvent.click(button(kind === "save" ? "Save" : "Reset to config file"));
    await status(/Another user/);
    expect(server.writes[0]?.headers["If-Match"]).toBe('"old"');
    expect(field(0, "wake").value).toBe("250");
    expect(saveDisabled()).toBe(true);
    expect(resetDisabled()).toBe(true);
    const confirm = answer(false);
    fireEvent.click(button("Reload current rules"));
    expect(confirm).toHaveBeenCalledWith(
      "Discard your unsaved edits and load the current rules saved by other users?",
    );
    expect(field(0, "wake").value, "Cancel retains the draft").toBe("250");
    answer(true);
    server.read = () => reply({}, 503);
    fireEvent.click(button("Reload current rules"));
    await status("The collector answered HTTP 503.");
    expect(field(0, "wake").value, "a failed reload retains the draft").toBe(
      "250",
    );
    expect(queryButton("Reload current rules")).not.toBeNull();
    server.read = () => reply(current);
    fireEvent.click(button("Reload current rules"));
    await status("Current rules loaded. Review them before editing.");
    expect(field(0, "prefix").value).toBe("other-");
    expect(queryButton("Reload current rules")).toBeNull();
    expect(text("watch-unsaved")).toBeNull();
    // The next write names the reloaded revision.
    type(0, "wake", "300");
    server.write = () => reply(current);
    fireEvent.click(button("Save"));
    await waitFor(() => {
      expect(server.writes).toHaveLength(2);
    });
    expect(server.writes[1]?.headers["If-Match"]).toBe('"new"');
    cleanup();
  }
});

test("persistence retries cannot adopt another editor's revision", async () => {
  for (const kind of ["save", "reset"] as const) {
    const original = watchReply([{ prefix: "worker-", wake_ms: 500 }], {
      source: "dashboard",
      revision: "original",
    });
    const applied = watchReply(
      kind === "save" ? [{ prefix: "worker-", wake_ms: 250 }] : [],
      { source: kind === "save" ? "dashboard" : "config", revision: "applied" },
    );
    const other = watchReply([{ prefix: "other-", wake_ms: 1000 }], {
      source: "dashboard",
      revision: "other",
    });
    const { server, rerender } = await editor(original, () =>
      reply(
        {
          error: "rules were applied, but persistence could not be confirmed",
          applied: true,
          applied_state: applied,
        },
        500,
      ),
    );
    type(0, "wake", "250");
    answer(true);
    const action = kind === "save" ? "Save" : "Reset to config file";
    fireEvent.click(button(action));
    await status(/^Warning/);
    // Another editor saves; a read of its rules comes in.
    server.read = () => reply(other);
    rerender(undefined, 1);
    await act(async () => {
      await Promise.resolve();
    });
    server.write = () =>
      reply({ error: "Another user changed the rules." }, 409);
    fireEvent.click(button(action));
    await status(/Another user/);
    expect(server.writes.map((write) => write.headers["If-Match"])).toEqual([
      '"original"',
      '"applied"',
    ]);
    expect(saveDisabled()).toBe(true);
    expect(resetDisabled()).toBe(true);
    cleanup();
  }
});

test("an applied error without its revision requires an explicit reload", async () => {
  await editor(undefined, () =>
    reply({ error: "Persistence could not be confirmed.", applied: true }, 500),
  );
  type(0, "wake", "250");
  fireEvent.click(button("Save"));
  await status(/Reload current rules before retrying/);
  expect(field(0, "wake").value).toBe("250");
  expect(saveDisabled()).toBe(true);
  expect(resetDisabled()).toBe(true);
  expect(queryButton("Reload current rules")).not.toBeNull();
});

test("a live poll keeps focus and the draft, and unsaved edits guard leaving the page", async () => {
  const { rerender } = await editor();
  field(0, "wake").focus();
  type(0, "wake", "250");
  rerender([{ tid: 1, name: "worker-1" }]);
  rerender([{ tid: 2, name: "worker-2" }]);
  expect(document.activeElement).toBe(field(0, "wake"));
  expect(field(0, "wake").value).toBe("250");
  const leave = new Event("beforeunload", { cancelable: true });
  dispatchEvent(leave);
  expect(leave.defaultPrevented).toBe(true);
  fireEvent.click(button("Discard edits"));
  expect(field(0, "wake").value).toBe("500");
  const stay = new Event("beforeunload", { cancelable: true });
  dispatchEvent(stay);
  expect(stay.defaultPrevented).toBe(false);
});

test("every visible element of the Settings section has registered help", async () => {
  await editor(
    watchReply([{ prefix: "worker-", wake_ms: 500 }], {
      source: "dashboard",
      saved_error: "bad file",
    }),
    () => reply({ error: "Another user changed the rules." }, 409),
  );
  type(0, "wake", "250");
  fireEvent.click(button("Save"));
  await status(/Another user/);
  const section = document.getElementById("collector-settings");
  for (const element of section?.querySelectorAll<HTMLElement>("[data-help]") ??
    [])
    expect(Object.hasOwn(helpTopics, element.dataset.help ?? "")).toBe(true);
  // The anchor is the element itself, an ancestor, or its only content.
  const helped = (element: Element | null) => {
    expect(
      element?.closest("[data-help]") ?? element?.querySelector("[data-help]"),
      element?.textContent ?? "missing",
    ).toBeTruthy();
  };
  for (const id of [
    "watch-source",
    "watch-warning",
    "watch-unsaved",
    "watch-status",
  ])
    helped(document.getElementById(id));
  for (const name of ["Settings", "Watched threads"])
    helped(screen.getByRole("heading", { name }));
  for (const label of [
    "Thread name prefix",
    "Wakes at least every (ms)",
    "Matching threads now",
    "Remove",
  ])
    helped(screen.getByRole("columnheader", { name: label }));
  for (const name of [
    "Add rule",
    "Save",
    "Reload current rules",
    "Reset to config file",
  ])
    helped(button(name));
  fireEvent.click(button("Remove rule 1"));
  helped(document.getElementById("watch-empty"));
});

test("recorded mode keeps the dirty draft, blocks actions, and restores the same revision", async () => {
  const info = watchReply([{ prefix: "worker-", wake_ms: 500 }]);
  const server = collector(
    () => reply(info),
    () => reply(info),
  );
  const onChanged = vi.fn();
  const view = render(
    <WatchRules threads={[]} opened={0} onChanged={onChanged} />,
  );
  await screen.findByRole("button", { name: "Save" });
  type(0, "prefix", "draft-");
  view.rerender(
    <WatchRules threads={[]} opened={1} recorded onChanged={onChanged} />,
  );
  expect(queryButton("Save")).toBeNull();
  expect(text("watch-recorded-readonly")).toContain(
    "Your unsaved edits are kept.",
  );
  const count = server.reads;
  view.rerender(
    <WatchRules threads={[]} opened={2} recorded onChanged={onChanged} />,
  );
  expect(server.reads).toBe(count);
  view.rerender(<WatchRules threads={[]} opened={3} onChanged={onChanged} />);
  expect(field(0, "prefix").value).toBe("draft-");
  fireEvent.click(button("Save"));
  await waitFor(() => {
    expect(server.writes).toHaveLength(1);
  });
  expect(server.writes[0]?.headers["If-Match"]).toBe('"test-1"');
});

test("a pending read is discarded on replay; an already sent write settles the current editor", async () => {
  const info = watchReply([{ prefix: "worker-", wake_ms: 500 }]);
  let deliver: (value: Response) => void = () => undefined;
  const server = collector(
    () =>
      new Promise<Response>((done) => {
        deliver = done;
      }),
    () =>
      new Promise<Response>((done) => {
        deliver = done;
      }),
  );
  const onChanged = vi.fn();
  const view = render(
    <WatchRules threads={[]} opened={0} onChanged={onChanged} />,
  );
  view.rerender(
    <WatchRules threads={[]} opened={0} recorded onChanged={onChanged} />,
  );
  await act(async () => {
    deliver(Response.json(info));
    await Promise.resolve();
  });
  expect(document.getElementById("watch-editor")).toBeNull();
  server.read = () => reply(info);
  view.rerender(<WatchRules threads={[]} opened={0} onChanged={onChanged} />);
  await screen.findByRole("button", { name: "Save" });
  type(0, "prefix", "draft-");
  fireEvent.click(button("Save"));
  view.rerender(
    <WatchRules threads={[]} opened={0} recorded onChanged={onChanged} />,
  );
  await act(async () => {
    deliver(
      Response.json(
        watchReply([{ prefix: "draft-", wake_ms: 500 }], {
          revision: "test-2",
        }),
      ),
    );
    await Promise.resolve();
  });
  view.rerender(<WatchRules threads={[]} opened={0} onChanged={onChanged} />);
  expect(field(0, "prefix").value).toBe("draft-");
  expect(saveDisabled()).toBe(true);
  expect(server.writes).toHaveLength(1);
});

test("unmounting ends the requests that the settings started", async () => {
  const info = watchReply([{ prefix: "worker-", wake_ms: 500 }]);
  const signals: { method: string; signal: AbortSignal | undefined }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      signals.push({ method, signal: init?.signal ?? undefined });
      // The write never answers, so it is still pending at unmount.
      return method === "POST"
        ? new Promise<Response>(() => undefined)
        : reply(info);
    }),
  );
  const view = render(
    <WatchRules threads={[]} opened={0} onChanged={() => undefined} />,
  );
  await screen.findByRole("button", { name: "Save" });
  type(0, "wake", "600");
  fireEvent.click(button("Save"));
  await waitFor(() => {
    expect(signals.some((item) => item.method === "POST")).toBe(true);
  });
  const post = signals.find((item) => item.method === "POST");
  expect(post?.signal?.aborted).toBe(false);
  view.unmount();
  expect(post?.signal?.aborted).toBe(true);
});
