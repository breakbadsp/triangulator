#pragma once

// The exit-report datagram format ("TEND"), shared by the sampler and the
// collector. When the target process ends, the sampler sends one report: the
// kernel log messages that name the process or one of its threads, such as
// "worker[1240]: segfault at 0 ..." or "Out of memory: Killed process 1234".
// They tell why the process ended when the kernel killed it. A process that
// exits normally, calls abort(), or that another process kills, leaves no
// kernel message, so the report also carries the exit status when the
// sampler could read it: the exit code or the signal that ended the process.
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
inline constexpr std::uint8_t kVersion = 2;
inline constexpr std::size_t kHeaderSize = 72;
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

// Whether the report has the exit status. The sampler is not the target's
// parent, so it reads the status through a pidfd (Linux 6.15 and later) or,
// while the process is a zombie, from /proc/PID/stat.
enum class ExitStatus : std::uint8_t
{
  Unknown = 0,
  Known = 1
};

// The largest wait status: the exit code in bits 8 to 15, the signal in bits
// 0 to 6 and the core-dump flag in bit 7, as waitpid(2) reports it.
inline constexpr std::int32_t kMaxWaitStatus = 0xffff;

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
  // The sampler session the ended target was sampled in, and the session the
  // sampler started when it saw the exit. The first matches the target's
  // thread ticks; the second is the session of the "target absent" ticks
  // that follow, so a dashboard can tell the exit belongs to that absence.
  std::uint64_t ended_session_{};
  std::uint64_t next_session_{};
  // The process name (comm) from the last thread tick, NUL-padded.
  std::array<char, 16> comm_{};
  // How the process ended, in waitpid(2) form: WIFSIGNALED, WTERMSIG,
  // WCOREDUMP and WEXITSTATUS decode it. Zero when exit_status_ is Unknown.
  std::int32_t wait_status_{};
  ExitStatus exit_status_{};
  // Zero. The collector rejects other values.
  std::array<std::uint8_t, 3> padding_{};
  // The newest messages, oldest first. Lines past line_count_ are zero.
  std::array<Line, kMaxLines> lines_{};
};
static_assert(wire::WireStruct<Report>);
static_assert(offsetof(Report, pid_) == 8 &&
              offsetof(Report, process_start_) == 16 &&
              offsetof(Report, ended_session_) == 32 &&
              offsetof(Report, comm_) == 48 &&
              offsetof(Report, wait_status_) == 64 &&
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

// Checks the format (length, magic, version, reserved bytes, padding), that
// the identity, clock and sessions are set, and that an exit status is in
// the range waitpid(2) reports.
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
      report.reserved_ != 0 || report.padding_ != decltype(report.padding_){} ||
      report.line_count_ > kMaxLines || (read != (report.error_ == 0)) ||
      (!read && report.line_count_ != 0))
  {
    return std::unexpected("invalid exit-report header");
  }
  const bool known = report.exit_status_ == ExitStatus::Known;
  if (std::to_underlying(report.exit_status_) >
          std::to_underlying(ExitStatus::Known) ||
      report.wait_status_ < 0 || report.wait_status_ > kMaxWaitStatus ||
      (!known && report.wait_status_ != 0))
  {
    return std::unexpected("invalid exit-report status");
  }
  if (report.pid_ == 0 || report.wall_ns_ == 0 || report.ended_session_ == 0 ||
      report.next_session_ == 0 || report.comm_.back() != '\0')
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
