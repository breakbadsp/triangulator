#pragma once

// Exit reports ("TEND", common/exit_wire.hpp): why the target process ended,
// from the kernel log messages the sampler found. The collector keeps the
// latest report for /api/live and stores each one once in the day file's
// process_exit table. The sampler sends every report several times; copies
// have the same PID and process start time and are ignored.

#include <array>
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>
#include <string_view>
#include <utility>

#include "../common/exit_wire.hpp"
#include "bounded.hpp"
#include "json.hpp"

namespace triangulator::collector
{

// A short code for why the process ended, from the kernel messages. The
// dashboard turns it into a label and an explanation.
[[nodiscard]] inline std::string_view ExitReason(
    const exit_wire::Report& p_report)
{
  using exit_wire::KernelLog;
  if (p_report.kernel_log_ == KernelLog::Unreadable)
  {
    return "log_unreadable";
  }
  if (p_report.kernel_log_ == KernelLog::Unavailable)
  {
    return "log_unavailable";
  }
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
using ExitMessagesText = FixedText<exit_wire::kMaxLines * exit_wire::kLineSize>;

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
  // Keeps p_report when it is new. Returns true then, so the caller stores
  // it; false for a copy of the latest report. Allocates nothing.
  [[nodiscard]] bool Accept(const exit_wire::Report& p_report) noexcept
  {
    if (latest_ && latest_->pid_ == p_report.pid_ &&
        latest_->process_start_ == p_report.process_start_)
    {
      return false;
    }
    latest_ = p_report;
    return true;
  }

  // The latest report for /api/live, or null when no target has ended
  // since the collector started.
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
    result.Set("name", Json(SanitizeUtf8(exit_wire::FieldText(report.comm_))));
    result.Set("ended_at", Json(static_cast<double>(report.wall_ns_) / 1e9));
    result.Set("reason", Json(ExitReason(report)));
    result.Set("kernel_log", Json(KernelLogName(report.kernel_log_)));
    result.Set("error",
               report.error_ == 0
                   ? Json(nullptr)
                   : Json(std::strerror(static_cast<int>(report.error_))));
    result.Set("messages", Json(std::move(messages)));
    return result;
  }

 private:
  std::optional<exit_wire::Report> latest_;
};

}  // namespace triangulator::collector
