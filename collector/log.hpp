#pragma once

#include <chrono>
#include <cstdio>
#include <format>
#include <mutex>
#include <string_view>

namespace triangulator::collector
{

enum class LogLevel
{
  Info = 0,
  Error
};

// Writes "2026-10-04 12:00:00,123 INFO message" to stderr, the format the
// Python collector's logging setup produces.
inline void Log(LogLevel p_level, std::string_view p_message)
{
  static std::mutex mutex;
  const auto now =
      std::chrono::zoned_time{std::chrono::current_zone(),
                              std::chrono::floor<std::chrono::milliseconds>(
                                  std::chrono::system_clock::now())};
  const auto local = now.get_local_time();
  const auto milliseconds =
      (local.time_since_epoch() % std::chrono::seconds{1}).count();
  const auto line =
      std::format("{:%Y-%m-%d %H:%M:%S},{:03} {} {}\n",
                  std::chrono::floor<std::chrono::seconds>(local), milliseconds,
                  p_level == LogLevel::Info ? "INFO" : "ERROR", p_message);
  std::lock_guard lock{mutex};
  std::fputs(line.c_str(), stderr);
  std::fflush(stderr);
}

}  // namespace triangulator::collector
