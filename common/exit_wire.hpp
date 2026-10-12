#pragma once

// The exit-report datagram format ("TEND"), shared by the sampler and the
// collector. When the target process ends, the sampler sends one report: the
// kernel log messages that name the process or one of its threads, such as
// "worker[1240]: segfault at 0 ..." or "Out of memory: Killed process 1234".
// They tell why the process ended when the kernel killed it. A process that
// exits normally, or that another process kills, leaves no kernel message.
// This header depends only on the standard library.
//
// A report is one fixed-size datagram. The sampler sends it with several
// ticks after the exit, as datagrams are not acknowledged; the collector
// keeps the first copy and ignores the rest.

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <span>
#include <string_view>
#include <utility>

#include "wire.hpp"

namespace triangulator::exit_wire
{

inline constexpr std::array<char, 4> kMagic{'T', 'E', 'N', 'D'};
inline constexpr std::uint8_t kVersion = 1;
inline constexpr std::size_t kHeaderSize = 48;
inline constexpr std::size_t kMaxLines = 6;
inline constexpr std::size_t kLineSize = 192;

// Whether the sampler could read the kernel log. It is /dev/kmsg, the file
// dmesg reads; kernel.dmesg_restrict = 1 limits it to CAP_SYSLOG.
enum class KernelLog : std::uint8_t
{
  Read = 0,
  // Permission denied, usually kernel.dmesg_restrict = 1.
  Unreadable = 1,
  // Any other failure, such as no /dev/kmsg in a container.
  Unavailable = 2
};

// One kernel log message: NUL-padded text, cut to fit. Unprintable bytes
// stay escaped as the kernel writes them ("\x0a").
using Line = std::array<char, kLineSize>;

struct Report
{
  std::array<char, 4> magic_ = kMagic;
  std::uint8_t version_ = kVersion;
  KernelLog kernel_log_{};
  std::uint8_t line_count_{};
  // Zero. The collector rejects other values.
  std::uint8_t reserved_{};
  std::uint32_t pid_{};
  // errno from opening the kernel log; zero when it was read.
  std::uint32_t error_{};
  // The ended process's start time (/proc/PID/stat field 22). With the pid
  // it identifies the process, so copies of one report are recognized.
  std::uint64_t process_start_{};
  // When the sampler noticed the exit (CLOCK_REALTIME).
  std::uint64_t wall_ns_{};
  // The process name (comm) from the last thread tick, NUL-padded.
  std::array<char, 16> comm_{};
  // The newest messages, oldest first. Lines past line_count_ are zero.
  std::array<Line, kMaxLines> lines_{};
};
static_assert(wire::WireStruct<Report>);
static_assert(offsetof(Report, pid_) == 8 &&
              offsetof(Report, process_start_) == 16 &&
              offsetof(Report, comm_) == 32 &&
              offsetof(Report, lines_) == kHeaderSize);
inline constexpr std::size_t kReportSize = sizeof(Report);
static_assert(kReportSize == kHeaderSize + kMaxLines * kLineSize);
// Fits an unfragmented UDP datagram on a 1,500-byte Ethernet MTU.
static_assert(kReportSize <= 1400);

// The text of a NUL-padded field.
template <std::size_t kSize>
[[nodiscard]] std::string_view FieldText(
    const std::array<char, kSize>& p_field) noexcept
{
  return {p_field.data(), ::strnlen(p_field.data(), kSize)};
}

// Copies p_text into p_line, cut to leave a NUL at the end.
inline void SetLine(Line& p_line, std::string_view p_text) noexcept
{
  p_line = {};
  const auto length = std::min(p_text.size(), kLineSize - 1);
  std::memcpy(p_line.data(), p_text.data(), length);
}

// Checks the format (length, magic, version, reserved bytes, padding) and
// that the identity and clock are set.
[[nodiscard]] inline std::expected<Report, std::string_view> Decode(
    std::span<const std::byte> p_data)
{
  if (p_data.size() != kReportSize ||
      std::memcmp(p_data.data(), kMagic.data(), kMagic.size()) != 0)
  {
    return std::unexpected("not an exit report");
  }
  const auto report = wire::FromBytes<Report>(p_data);
  if (report.version_ != kVersion)
  {
    return std::unexpected("unsupported exit-report protocol");
  }
  const bool read = report.kernel_log_ == KernelLog::Read;
  if (std::to_underlying(report.kernel_log_) >
          std::to_underlying(KernelLog::Unavailable) ||
      report.reserved_ != 0 || report.line_count_ > kMaxLines ||
      (read != (report.error_ == 0)) || (!read && report.line_count_ != 0))
  {
    return std::unexpected("invalid exit-report header");
  }
  if (report.pid_ == 0 || report.wall_ns_ == 0 || report.comm_.back() != '\0')
  {
    return std::unexpected("invalid exit-report identity or clock");
  }
  for (std::size_t index = 0; index < kMaxLines; ++index)
  {
    const auto& line = report.lines_[index];
    const bool used = index < report.line_count_;
    if (line.back() != '\0' || (used && line.front() == '\0') ||
        (!used && line != Line{}))
    {
      return std::unexpected("invalid exit-report line");
    }
  }
  return report;
}

}  // namespace triangulator::exit_wire
