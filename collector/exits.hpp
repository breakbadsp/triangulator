#pragma once

// Exit reports ("TEND", common/exit_wire.hpp): why the target process ended,
// from the kernel log messages the sampler found. The collector keeps the
// latest report for /api/live and stores each one once in the day file's
// process_exit table. The sampler sends every report several times; copies
// have the same PID and process start time and are ignored.

#include <algorithm>
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
    if (!latest_ || p_report.wall_ns_ > latest_->wall_ns_)
    {
      latest_ = p_report;
    }
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
  std::array<Identity, kRecentExits> recent_{};
  std::size_t recent_count_ = 0;
  std::size_t next_recent_ = 0;
};

}  // namespace triangulator::collector
