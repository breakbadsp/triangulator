#pragma once

// Exit reports ("TEND", common/exit_wire.hpp): why the target process ended,
// from the kernel log messages the sampler found and the exit status it
// read. The collector keeps the
// latest report for /api/live and stores each one once in the day file's
// process_exit table. The sampler sends every report several times; copies
// have the same PID and process start time and are ignored.

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>

#include "../common/exit_wire.hpp"
#include "bounded.hpp"
#include "json.hpp"

namespace triangulator::collector
{

// The wait status, or nullopt when the sampler could not read it.
[[nodiscard]] inline std::optional<std::int64_t> WaitStatus(
    const exit_wire::Report& p_report)
{
  if (p_report.exit_status_ != exit_wire::ExitStatus::Known)
  {
    return std::nullopt;
  }
  return p_report.wait_status_;
}

// The parts of a wait status, as WTERMSIG, WCOREDUMP and WEXITSTATUS decode
// it. A status with no signal is a normal exit with that code.
struct ExitStatusParts
{
  int signal_ = 0;
  bool core_dumped_ = false;
  int exit_code_ = 0;
};

[[nodiscard]] inline ExitStatusParts SplitWaitStatus(std::int32_t p_status)
{
  return {.signal_ = p_status & 0x7f,
          .core_dumped_ = (p_status & 0x80) != 0,
          .exit_code_ = (p_status >> 8) & 0xff};
}

// The name of a signal by its Linux number on x86, ARM, RISC-V and
// PowerPC, or an empty view for a real-time or unknown signal.
[[nodiscard]] inline std::string_view SignalName(int p_signal)
{
  constexpr std::array<std::string_view, 32> kNames{
      "",        "SIGHUP",  "SIGINT",    "SIGQUIT", "SIGILL",    "SIGTRAP",
      "SIGABRT", "SIGBUS",  "SIGFPE",    "SIGKILL", "SIGUSR1",   "SIGSEGV",
      "SIGUSR2", "SIGPIPE", "SIGALRM",   "SIGTERM", "SIGSTKFLT", "SIGCHLD",
      "SIGCONT", "SIGSTOP", "SIGTSTP",   "SIGTTIN", "SIGTTOU",   "SIGURG",
      "SIGXCPU", "SIGXFSZ", "SIGVTALRM", "SIGPROF", "SIGWINCH",  "SIGIO",
      "SIGPWR",  "SIGSYS"};
  if (p_signal <= 0 || std::cmp_greater_equal(p_signal, kNames.size()))
  {
    return {};
  }
  return kNames[static_cast<std::size_t>(p_signal)];
}

// Whether p_signal reports a fault in the process itself, raised by the CPU
// or by the C library's abort(): SIGILL, SIGTRAP, SIGABRT, SIGBUS, SIGFPE,
// SIGSEGV and SIGSYS. Other signals usually come from another process.
[[nodiscard]] inline bool IsCrashSignal(int p_signal)
{
  constexpr std::array kCrashSignals{4, 5, 6, 7, 8, 11, 31};
  return std::ranges::contains(kCrashSignals, p_signal);
}

// The reason from the exit status alone: "crashed", "killed" or "exited".
[[nodiscard]] inline std::string_view StatusReason(std::int32_t p_status)
{
  const auto parts = SplitWaitStatus(p_status);
  if (parts.signal_ == 0)
  {
    return "exited";
  }
  return IsCrashSignal(parts.signal_) ? "crashed" : "killed";
}

// The reason a kernel message gives, such as "segfault" for
// "app[1240]: segfault at 0 ...", or nullopt when no message names one.
[[nodiscard]] inline std::optional<std::string_view> LoggedReason(
    const exit_wire::Report& p_report)
{
  // The first match wins: the OOM killer's report can mention other
  // faults, never the other way round.
  constexpr std::array<std::pair<std::string_view, std::string_view>, 8>
      kPatterns{{{"Killed process", "oom"},
                 {"oom-kill:", "oom"},
                 {"segfault at", "segfault"},
                 {"general protection", "gp_fault"},
                 {"trap divide error", "divide_error"},
                 {"trap invalid opcode", "invalid_opcode"},
                 {"trap int3", "breakpoint"},
                 {"unexpected fatal signal", "fatal_signal"}}};
  const auto lines = std::span{p_report.lines_}.first(p_report.line_count_);
  for (const auto& [pattern, reason] : kPatterns)
  {
    for (const auto& line : lines)
    {
      if (exit_wire::FieldText(line).contains(pattern))
      {
        return reason;
      }
    }
  }
  return std::nullopt;
}

// A short code for why the process ended. A kernel message comes first: it
// says more than a signal number, such as the faulting address, or that the
// out-of-memory killer sent the SIGKILL. Without one, the exit status tells
// whether the process crashed, was killed or exited, even when the kernel
// log is not readable. The dashboard turns the code into a label and an
// explanation.
[[nodiscard]] inline std::string_view ExitReason(
    const exit_wire::Report& p_report)
{
  using exit_wire::KernelLog;
  if (p_report.kernel_log_ == KernelLog::Read)
  {
    if (const auto logged = LoggedReason(p_report))
    {
      return *logged;
    }
  }
  if (p_report.exit_status_ == exit_wire::ExitStatus::Known)
  {
    return StatusReason(p_report.wait_status_);
  }
  if (p_report.kernel_log_ == KernelLog::Unreadable)
  {
    return "log_unreadable";
  }
  if (p_report.kernel_log_ == KernelLog::Unavailable)
  {
    return "log_unavailable";
  }
  return "not_reported";
}

[[nodiscard]] inline std::string_view KernelLogName(
    exit_wire::KernelLog p_status)
{
  switch (p_status)
  {
    case exit_wire::KernelLog::Read:
      return "read";
    case exit_wire::KernelLog::Unreadable:
      return "unreadable";
    case exit_wire::KernelLog::Unavailable:
      return "unavailable";
  }
  return "unavailable";
}

// The report's messages, one per line, for the process_exit table.
inline constexpr std::size_t kExitMessagesBytes =
    exit_wire::kMaxLines * exit_wire::kLineSize;
using ExitMessagesText = FixedText<kExitMessagesBytes>;

[[nodiscard]] inline ExitMessagesText JoinedMessages(
    const exit_wire::Report& p_report)
{
  ExitMessagesText text;
  for (std::size_t index = 0; index < p_report.line_count_; ++index)
  {
    if (index != 0)
    {
      text.Append("\n");
    }
    text.Append(exit_wire::FieldText(p_report.lines_[index]));
  }
  return text;
}

class ExitMonitor
{
 public:
  void Clear() noexcept
  {
    latest_.reset();
  }

  // Keeps p_report as the latest exit when it is the newest by report time.
  // Returns true when the report has not been seen before, so the caller
  // stores it, even if an exit that ended later is already the latest: UDP
  // can deliver the report of an earlier exit late. Returns false for a copy
  // of a recently seen report. Allocates nothing.
  [[nodiscard]] bool Accept(const exit_wire::Report& p_report) noexcept
  {
    const Identity identity{p_report.pid_, p_report.process_start_};
    const auto seen = std::span{recent_}.first(recent_count_);
    if (std::ranges::find(seen, identity) != seen.end())
    {
      return false;
    }
    recent_[next_recent_] = identity;
    next_recent_ = (next_recent_ + 1) % recent_.size();
    recent_count_ = std::min(recent_count_ + 1, recent_.size());
    ++count_;
    if (!latest_ || p_report.wall_ns_ > latest_->wall_ns_)
    {
      latest_ = p_report;
    }
    return true;
  }

  // The latest report for /api/live, or null when no target has ended
  // since the collector started. "count" is the number of exits since then,
  // so a dashboard can tell a restart loop from a single exit.
  [[nodiscard]] Json Snapshot() const
  {
    if (!latest_)
    {
      return Json(nullptr);
    }
    const auto& report = *latest_;
    JsonArray messages;
    for (const auto& line : std::span{report.lines_}.first(report.line_count_))
    {
      messages.emplace_back(SanitizeUtf8(exit_wire::FieldText(line)));
    }
    Json result{JsonObject{}};
    result.Set("pid", Json(report.pid_));
    result.Set("process_start", Json(report.process_start_));
    // Decimal text like health.session, which a double cannot hold exactly.
    // "session" is the ended target's; "next_session" is the one of the
    // "target absent" ticks that follow the exit.
    result.Set("session", Json(std::to_string(report.ended_session_)));
    result.Set("next_session", Json(std::to_string(report.next_session_)));
    result.Set("name", Json(SanitizeUtf8(exit_wire::FieldText(report.comm_))));
    result.Set("ended_at", Json(static_cast<double>(report.wall_ns_) / 1e9));
    result.Set("reason", Json(ExitReason(report)));
    // The exit status, decoded; null when the sampler could not read it.
    const bool known = report.exit_status_ == exit_wire::ExitStatus::Known;
    const auto parts = SplitWaitStatus(report.wait_status_);
    const bool signaled = known && parts.signal_ != 0;
    const auto signal_name = SignalName(parts.signal_);
    result.Set("exit_code",
               known && !signaled ? Json(parts.exit_code_) : Json(nullptr));
    result.Set("signal", signaled ? Json(parts.signal_) : Json(nullptr));
    result.Set("signal_name", signaled && !signal_name.empty()
                                  ? Json(signal_name)
                                  : Json(nullptr));
    result.Set("core_dumped",
               signaled ? Json(parts.core_dumped_) : Json(nullptr));
    result.Set("kernel_log", Json(KernelLogName(report.kernel_log_)));
    result.Set("error",
               report.error_ == 0
                   ? Json(nullptr)
                   : Json(std::strerror(static_cast<int>(report.error_))));
    result.Set("messages", Json(std::move(messages)));
    result.Set("count", Json(count_));
    return result;
  }

 private:
  struct Identity
  {
    std::uint32_t pid_ = 0;
    std::uint64_t process_start_ = 0;
    [[nodiscard]] bool operator==(const Identity&) const = default;
  };

  // The sampler repeats a report for five ticks, so a copy arrives soon after
  // the report; sixteen exits are far more than can arrive in that time. An
  // older copy that is forgotten is stored again with no effect: the
  // process_exit primary key ignores it, and it is not the newest.
  static constexpr std::size_t kRecentExits = 16;

  std::optional<exit_wire::Report> latest_;
  // Exits accepted since the collector started. A copy that arrives after
  // its identity has left recent_ counts again, which takes sixteen other
  // exits within the five ticks of one report.
  std::uint64_t count_ = 0;
  std::array<Identity, kRecentExits> recent_{};
  std::size_t recent_count_ = 0;
  std::size_t next_recent_ = 0;
};

}  // namespace triangulator::collector
