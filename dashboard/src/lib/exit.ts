import type { LiveResponse, ProcessExit } from "../api/types";
import type { Level } from "./findings";
import { isNum } from "./format";
export function endedTarget(view: Partial<LiveResponse>) {
  const health = view.health;
  return health?.target_absent &&
    view.exit &&
    health.session &&
    view.exit.next_session === health.session
    ? view.exit
    : null;
}
const EXIT_REASONS: Record<string, [string, Level, string]> = {
  segfault: [
    "Segmentation fault",
    "critical",
    "A thread read or wrote memory it may not access. The kernel sent SIGSEGV.",
  ],
  oom: [
    "Killed by the out-of-memory killer",
    "critical",
    "The host or the process's cgroup ran out of memory. The kernel ended the process with SIGKILL.",
  ],
  gp_fault: [
    "General protection fault",
    "critical",
    "The CPU rejected a memory access, often through a corrupted pointer. The kernel sent SIGSEGV.",
  ],
  divide_error: [
    "Divide error",
    "critical",
    "An integer division by zero or overflow. The kernel sent SIGFPE.",
  ],
  invalid_opcode: [
    "Invalid instruction",
    "critical",
    "The CPU could not run an instruction, for example __builtin_trap() or a corrupted jump. The kernel sent SIGILL.",
  ],
  breakpoint: [
    "Breakpoint trap",
    "critical",
    "The process ran a breakpoint instruction with no debugger attached. The kernel sent SIGTRAP.",
  ],
  fatal_signal: [
    "Fatal signal",
    "critical",
    "The kernel logged an unexpected fatal signal for the process.",
  ],
  not_reported: [
    "No kernel crash message",
    "warning",
    "The sampler found no crash message for this process and could not read its exit status. It may have exited by itself, crashed through abort() or a signal handler, or been ended by another process (SIGTERM, SIGKILL).",
  ],
  log_unreadable: [
    "Reason unknown: kernel log not readable",
    "warning",
    "The sampler may not read the kernel log. Set kernel.dmesg_restrict = 0 on the target host to show the reason next time.",
  ],
  log_unavailable: [
    "Reason unknown: kernel log unavailable",
    "warning",
    "The sampler could not open /dev/kmsg, for example inside a container.",
  ],
};
// Reasons from the exit status, when no kernel message named one. The status
// is the signal or exit code that ended the process.
const CRASH_SIGNALS: Record<string, string> = {
  SIGSEGV:
    "A thread accessed memory it may not use. The kernel logged no fault: a signal handler or a language runtime caught it first, or the message was rate-limited.",
  SIGABRT:
    "The process called abort(): usually a failed assert(), an uncaught C++ exception, a Rust panic, or the C library finding heap corruption.",
  SIGBUS:
    "A memory access the hardware could not complete, often to a memory-mapped file that was truncated.",
  SIGFPE: "An arithmetic fault, usually an integer division by zero.",
  SIGILL:
    "The CPU could not run an instruction, for example __builtin_trap() or a jump into data.",
  SIGTRAP: "A breakpoint or trap instruction ran with no debugger attached.",
  SIGSYS: "The process made a system call that its seccomp filter forbids.",
};
const KILL_SIGNALS: Record<string, string> = {
  SIGKILL:
    "SIGKILL cannot be caught. It comes from kill -9, a service manager whose stop timed out, or the out-of-memory killer.",
  SIGTERM:
    "Another process asked it to stop: kill, systemctl stop, or a shutdown.",
  SIGINT: "An interrupt, such as Ctrl+C in its terminal.",
  SIGHUP: "Its terminal closed, or another process sent SIGHUP.",
};
const signalLabel = (ended: ProcessExit) =>
  ended.signal_name || "signal " + String(ended.signal);
export function exitReason(ended: ProcessExit): [string, Level, string] {
  if (ended.reason === "crashed")
    return [
      `Crashed: ${signalLabel(ended)}`,
      "critical",
      CRASH_SIGNALS[ended.signal_name ?? ""] ||
        "A signal that reports a fault in the process ended it.",
    ];
  if (ended.reason === "killed")
    return [
      `Killed by ${signalLabel(ended)}`,
      "warning",
      (KILL_SIGNALS[ended.signal_name ?? ""] ||
        "Another process sent a signal that ended it.") +
        (ended.signal_name === "SIGKILL" && ended.kernel_log !== "read"
          ? " Without the kernel log, an out-of-memory kill looks the same."
          : ""),
    ];
  if (ended.reason === "exited")
    return ended.exit_code === 0
      ? [
          "Exited normally",
          "good",
          "The process returned from main or called exit(0).",
        ]
      : [
          `Exited with code ${String(ended.exit_code)}`,
          "warning",
          "The process called exit() or returned from main with a non-zero code, usually after it logged an error.",
        ];
  return EXIT_REASONS[ended.reason] || [ended.reason, "warning", ""];
}
export function exitStatusText(ended: ProcessExit) {
  if (isNum(ended.signal))
    return `Exit status: ${signalLabel(ended)} (signal ${String(ended.signal)})${ended.core_dumped ? ", core dumped" : ""}.`;
  if (isNum(ended.exit_code))
    return `Exit status: exit code ${String(ended.exit_code)}.`;
  return "Exit status: not available. The sampler reads it on Linux 6.15 and later, or while the process is a zombie.";
}
