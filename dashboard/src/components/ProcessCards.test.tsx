import { fireEvent, render } from "@testing-library/react";
import { expect, test } from "vitest";
import type {
  LiveResponse,
  ProcessExit as Exit,
  ProcessInfo as Info,
} from "../api/types";
import { helpTopics } from "../help/topics";
import { ProcessExit, ProcessInfo } from "./ProcessCards";

const health = (session: string, absent: boolean, pid: number) => ({
  session,
  pid,
  last_seen: 0,
  sampler_silent: false,
  target_absent: absent,
});
function facts() {
  const result: Record<string, string> = {};
  for (const item of document.querySelectorAll("#process-facts > div"))
    result[item.querySelector("dt")?.textContent ?? ""] =
      item.querySelector("dd")?.textContent ?? "";
  return result;
}

test("process details show the readable facts and say what is not available", () => {
  const info: Info = {
    session: "s",
    pid: 1234,
    started_at: 1700000000,
    parent_pid: 1,
    uid: 1000,
    euid: 1000,
    gid: 100,
    egid: 100,
    command: "/usr/bin/app --port 8080",
    command_truncated: false,
    executable: "/usr/bin/app",
    executable_truncated: false,
    exe_hidden: false,
    exe_deleted: true,
    working_directory: "",
    working_directory_truncated: false,
    cwd_hidden: true,
    cpus_allowed: "0-3,8",
    cpus_truncated: false,
  };
  const view = (process: Info | null, session = "s"): LiveResponse => ({
    health: health(session, false, 1234),
    threads: [],
    process,
  });
  const now = 1700000000 + 3 * 3600;
  const { rerender } = render(<ProcessInfo view={view(info)} now={now} />);
  expect(Object.keys(facts())).toEqual([
    "Command line",
    "Executable",
    "Working directory",
    "Started",
    "Parent process",
    "User & group",
    "Allowed CPUs",
  ]);
  let shown = facts();
  expect(shown["Command line"]).toBe("/usr/bin/app --port 8080");
  // The sampler sends the path without the suffix and sets exe_deleted.
  expect(shown.Executable).toBe("/usr/bin/app (deleted)");
  expect(shown["Working directory"]).toMatch(/^Not available.*process owner/);
  expect(shown.Started).toMatch(/ · up 3\.0 h$/);
  expect(shown["Parent process"]).toBe("PID 1");
  expect(shown["User & group"]).toBe("UID 1000 · GID 100");
  expect(shown["Allowed CPUs"]).toBe("0-3,8");
  // Every label has a help topic.
  for (const item of document.querySelectorAll<HTMLElement>(
    "#process-facts > div",
  ))
    expect(Object.hasOwn(helpTopics, item.dataset.help ?? "")).toBe(true);

  // Effective IDs show only when they differ; unread values are not zero.
  Object.assign(info, {
    euid: 0,
    gid: null,
    egid: null,
    parent_pid: 0,
    started_at: null,
    cpus_allowed: "",
    command: "",
    command_truncated: true,
  });
  rerender(<ProcessInfo view={view({ ...info })} now={now} />);
  shown = facts();
  expect(shown["User & group"]).toBe(
    "UID 1000 (effective 0) · GID Not available",
  );
  expect(shown["Parent process"]).toMatch(/^None visible/);
  expect(shown.Started).toBe("Not available");
  expect(shown["Allowed CPUs"]).toBe("Not available");
  expect(shown["Command line"]).toMatch(/^Empty/);

  // A cut command ends with an ellipsis; a cut path begins with one.
  Object.assign(info, {
    command: "/usr/bin/app --long",
    command_truncated: true,
    executable: "bin/app",
    executable_truncated: true,
    exe_deleted: false,
  });
  rerender(<ProcessInfo view={view({ ...info })} now={now} />);
  shown = facts();
  expect(shown["Command line"]).toBe("/usr/bin/app --long …");
  expect(shown.Executable).toBe("…bin/app");

  // Info read for another session is never shown for this one.
  rerender(<ProcessInfo view={view({ ...info }, "t")} now={now} />);
  expect(document.getElementById("process-info")).toBeNull();
  rerender(<ProcessInfo view={view(null)} now={now} />);
  expect(document.getElementById("process-info")).toBeNull();
});

test("the exit status names unlogged crashes and an earlier exit folds", () => {
  const exit: Exit = {
    pid: 100,
    process_start: 5,
    name: "app",
    ended_at: 1000,
    reason: "crashed",
    signal: 6,
    signal_name: "SIGABRT",
    core_dumped: true,
    exit_code: null,
    kernel_log: "unreadable",
    error: "Operation not permitted",
    messages: [],
    session: "a",
    next_session: "x",
    count: 3,
  };
  const show = (live: LiveResponse) => <ProcessExit view={live} now={1010} />;
  const { rerender } = render(
    show({ health: health("x", true, 0), threads: [], exit }),
  );
  const card = () => document.getElementById("exit-card") as HTMLDetailsElement;
  const text = (id: string) => document.getElementById(id)?.textContent;
  expect(card().open).toBe(true);
  expect(text("exit-reason")).toBe("Crashed: SIGABRT");
  expect(text("exit-status")).toBe(
    "Exit status: SIGABRT (signal 6), core dumped.",
  );
  expect(text("exit-explain")).toMatch(
    /abort\(\).*kernel log was not readable/,
  );
  expect(text("exit-sub")).toMatch(/3 exits since the collector started/);
  // An unreadable kernel log has no messages to show.
  expect(document.getElementById("exit-details")).toBeNull();
  // The restarted process is the target now.
  rerender(show({ health: health("y", false, 200), threads: [], exit }));
  expect(card().open).toBe(false);
  expect(text("exit-brief")).toMatch(
    /^app · PID 100 · .* · 3 exits since the collector started$/,
  );
  // A reader's toggle stays across polls.
  card().open = true;
  fireEvent(card(), new Event("toggle"));
  rerender(show({ health: health("y", false, 200), threads: [], exit }));
  expect(card().open).toBe(true);
  // The next crash opens it again while its process is absent.
  rerender(
    show({
      health: health("z", true, 0),
      threads: [],
      exit: {
        ...exit,
        pid: 200,
        next_session: "z",
        count: 4,
        kernel_log: "read",
        messages: ["segfault at 0"],
      },
    }),
  );
  expect(card().open).toBe(true);
  expect(text("exit-messages")).toBe("segfault at 0");
});
