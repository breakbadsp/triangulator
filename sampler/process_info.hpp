#pragma once

// The process-identity probe: what does not change while the target runs.
// It reads, without privileges (for a process of the sampler's own user),
// /proc/PID/cmdline, exe, cwd, stat, status and oom_score_adj. The sampler
// calls it once for each session and then repeats the same datagram
// (common/process_wire.hpp), so the files are not read on every tick.
//
// Reading is best effort. A file that cannot be read (another user, a process
// that is not dumpable, a process that just exited) leaves its fields marked
// unavailable; it never stops the sampler.

#include <fcntl.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <cstdint>
#include <optional>
#include <string_view>

#include "../common/process_wire.hpp"
#include "io.hpp"
#include "memory.hpp"
#include "parsing.hpp"
#include "resource_parsing.hpp"

namespace triangulator
{

// The value of line "Key:<tab>value" of /proc/PID/status, without the
// surrounding white space, or nullopt when the key is missing.
[[nodiscard]] inline std::optional<std::string_view> FindStatusText(
    std::string_view p_text, std::string_view p_key)
{
  std::optional<std::string_view> result;
  ForEachLine(p_text,
              [&](std::string_view p_line)
              {
                if (result || !p_line.starts_with(p_key) ||
                    p_line.size() == p_key.size() ||
                    p_line[p_key.size()] != ':')
                {
                  return;
                }
                result = Trim(p_line.substr(p_key.size() + 1));
              });
  return result;
}

// The first two numbers of a "Uid:" or "Gid:" line: the real and effective
// ID. The effective ID differs for a setuid or setgid program.
struct IdPair
{
  std::uint32_t real_ = process_wire::kUnavailable32;
  std::uint32_t effective_ = process_wire::kUnavailable32;
};

[[nodiscard]] inline IdPair ParseIdPair(std::string_view p_value)
{
  const auto real = ParseNumber<std::uint32_t>(NextToken(p_value));
  const auto effective = ParseNumber<std::uint32_t>(NextToken(p_value));
  if (!real || !effective)
  {
    return {};
  }
  return {*real, *effective};
}

// Fills the fields of p_packet that come from /proc/PID/status: owner,
// capabilities, seccomp, no_new_privs and the allowed CPUs. A line that is
// missing or not understood leaves its field unavailable.
inline void ParseProcessStatus(std::string_view p_text,
                               process_wire::Packet& p_packet)
{
  using process_wire::Flags;
  if (const auto uid = FindStatusText(p_text, "Uid"))
  {
    const auto ids = ParseIdPair(*uid);
    p_packet.uid_real_ = ids.real_;
    p_packet.uid_effective_ = ids.effective_;
  }
  if (const auto gid = FindStatusText(p_text, "Gid"))
  {
    const auto ids = ParseIdPair(*gid);
    p_packet.gid_real_ = ids.real_;
    p_packet.gid_effective_ = ids.effective_;
  }
  if (const auto caps = FindStatusText(p_text, "CapEff"))
  {
    p_packet.cap_effective_ =
        ParseHex(*caps).value_or(process_wire::kUnavailable64);
  }
  if (const auto seccomp = FindStatusText(p_text, "Seccomp"))
  {
    const auto mode = ParseNumber<std::uint8_t>(*seccomp);
    if (mode && *mode <= std::to_underlying(process_wire::Seccomp::Filter))
    {
      p_packet.seccomp_ = *mode;
    }
  }
  if (const auto privileges = FindStatusText(p_text, "NoNewPrivs"))
  {
    const auto value = ParseNumber<std::uint8_t>(*privileges);
    if (value && *value <= 1)
    {
      p_packet.no_new_privs_ = *value;
    }
  }
  if (const auto cpus = FindStatusText(p_text, "Cpus_allowed_list"))
  {
    if (!process_wire::CopyStart(p_packet.cpus_allowed_, *cpus))
    {
      p_packet.flags_ = p_packet.flags_ | Flags::CpuListTruncated;
    }
  }
}

// The program path of /proc/PID/exe. The kernel appends " (deleted)" when
// the file was replaced or removed; the suffix is removed, and the second
// value says it was there.
struct ExePath
{
  std::string_view path_;
  bool deleted_ = false;
};

[[nodiscard]] inline ExePath SplitDeleted(std::string_view p_link)
{
  constexpr std::string_view kSuffix = " (deleted)";
  if (p_link.ends_with(kSuffix))
  {
    return {p_link.substr(0, p_link.size() - kSuffix.size()), true};
  }
  return {p_link, false};
}

// The command line with the NUL separators of /proc/PID/cmdline replaced by
// spaces, in place, and without the trailing NULs.
[[nodiscard]] inline std::string_view JoinCommandLine(std::span<char> p_bytes)
{
  auto length = p_bytes.size();
  while (length > 0 && p_bytes[length - 1] == '\0')
  {
    --length;
  }
  std::replace(p_bytes.begin(), p_bytes.begin() + static_cast<long>(length),
               '\0', ' ');
  return {p_bytes.data(), length};
}

// When a process started, as wall-clock nanoseconds: now, minus the time since
// boot, plus the start time that /proc/PID/stat gives in clock ticks since
// boot. Zero when the clocks or the tick rate are not usable, or the result
// would be before the epoch. The ticks are split into seconds and a rest so
// the product cannot overflow.
[[nodiscard]] inline std::uint64_t StartedWallNs(std::uint64_t p_starttime,
                                                 long p_ticks_per_s,
                                                 Nanoseconds p_realtime,
                                                 Nanoseconds p_boottime)
{
  if (p_ticks_per_s <= 0 || p_boottime.count() <= 0 || p_realtime < p_boottime)
  {
    return 0;
  }
  const auto rate = static_cast<std::uint64_t>(p_ticks_per_s);
  constexpr std::uint64_t kNanosecondsPerSecond = 1'000'000'000;
  const auto since_boot_ns =
      (p_starttime / rate) * kNanosecondsPerSecond +
      (p_starttime % rate) * kNanosecondsPerSecond / rate;
  const auto boot_wall_ns =
      static_cast<std::uint64_t>((p_realtime - p_boottime).count());
  return boot_wall_ns + since_boot_ns;
}

class ProcessInfoProbe
{
 public:
  // Reads the identity of p_pid, started at p_starttime (clock ticks since
  // boot). The session and clocks are set by the caller.
  [[nodiscard]] process_wire::Packet Read(int p_pid, std::uint64_t p_starttime)
  {
    process_wire::Packet packet;
    packet.pid_ = static_cast<std::uint32_t>(p_pid);
    packet.process_start_ = p_starttime;
    packet.started_wall_ns_ =
        StartedWallNs(p_starttime, ::sysconf(_SC_CLK_TCK),
                      ClockNow(CLOCK_REALTIME), ClockNow(CLOCK_BOOTTIME));
    ReadCommandLine(p_pid, packet);
    ReadLink(FixedString{"/proc/{}/exe", p_pid}.CStr(), packet, true);
    ReadLink(FixedString{"/proc/{}/cwd", p_pid}.CStr(), packet, false);
    if (const auto text = Text(FixedString{"/proc/{}/stat", p_pid}.CStr()))
    {
      packet.parent_pid_ = static_cast<std::uint32_t>(
          FindStatField(*text, 4).value_or(process_wire::kUnavailable32));
    }
    if (const auto text = Text(FixedString{"/proc/{}/status", p_pid}.CStr()))
    {
      ParseProcessStatus(*text, packet);
    }
    if (const auto text =
            Text(FixedString{"/proc/{}/oom_score_adj", p_pid}.CStr()))
    {
      packet.oom_score_adj_ = ParseNumber<std::int32_t>(Trim(*text))
                                  .value_or(process_wire::kUnavailableAdjust);
    }
    return packet;
  }

 private:
  [[nodiscard]] std::optional<std::string_view> Text(const char* p_path)
  {
    return ReadAtStart(OpenReadonly(p_path), buffer_);
  }

  // Reads at most one byte less than the command field holds. A command line
  // that fills the buffer is cut and flagged.
  void ReadCommandLine(int p_pid, process_wire::Packet& p_packet)
  {
    const auto file =
        OpenReadonly(FixedString{"/proc/{}/cmdline", p_pid}.CStr());
    if (!file)
    {
      return;
    }
    ssize_t length;
    do
    {
      length =
          ::pread(file.Get(), buffer_.data(), process_wire::kCommandSize, 0);
    } while (length < 0 && errno == EINTR);
    if (length <= 0)
    {
      return;  // empty: a zombie or a kernel thread
    }
    const auto bytes = static_cast<std::size_t>(length);
    const auto text = JoinCommandLine(std::span{buffer_}.first(bytes));
    const bool cut = bytes == process_wire::kCommandSize;
    if (!process_wire::CopyStart(p_packet.command_, text) || cut)
    {
      p_packet.flags_ = p_packet.flags_ | process_wire::Flags::CommandTruncated;
    }
  }

  // Resolves the symbolic link p_path, which is /proc/PID/exe when p_exe and
  // /proc/PID/cwd otherwise.
  void ReadLink(const char* p_path, process_wire::Packet& p_packet, bool p_exe)
  {
    using process_wire::Flags;
    const auto length = ::readlink(p_path, buffer_.data(), buffer_.size());
    if (length <= 0 || static_cast<std::size_t>(length) == buffer_.size())
    {
      p_packet.flags_ =
          p_packet.flags_ | (p_exe ? Flags::ExeHidden : Flags::CwdHidden);
      return;
    }
    const std::string_view link{buffer_.data(),
                                static_cast<std::size_t>(length)};
    if (!p_exe)
    {
      if (!process_wire::CopyEnd(p_packet.cwd_, link))
      {
        p_packet.flags_ = p_packet.flags_ | Flags::CwdTruncated;
      }
      return;
    }
    const auto exe = SplitDeleted(link);
    if (exe.deleted_)
    {
      p_packet.flags_ = p_packet.flags_ | Flags::ExeDeleted;
    }
    if (!process_wire::CopyEnd(p_packet.exe_, exe.path_))
    {
      p_packet.flags_ = p_packet.flags_ | Flags::ExeTruncated;
    }
  }

  // Large enough for a /proc/PID/status with many supplementary groups, and
  // for a path (PATH_MAX is 4,096).
  std::array<char, 8192> buffer_{};
};

}  // namespace triangulator
