#pragma once

// The process-identity datagram format ("TPIN"), shared by the sampler and the
// collector. It carries what does not change while the target runs and that
// any user may read for a process of the same user: the command line, the
// program and working directory, the parent and owner, and the security
// settings the process started with. The sampler reads these files once for
// each session and then repeats the same datagram, so the cost is one
// datagram every kRepeatSeconds. It shares the session of the thread ticks
// ("TMON", wire.hpp) and, like the resource ("TRES") and memory-map ("TVMA")
// formats, has its own magic. This header depends only on the standard
// library.
//
// One sample is one datagram. Text that does not fit is cut and flagged: the
// command line keeps its start, a path keeps its end (the file name).

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <limits>
#include <span>
#include <string_view>
#include <utility>

#include "wire.hpp"

namespace triangulator::process_wire
{

inline constexpr std::uint8_t kVersion = 1;
inline constexpr std::size_t kCommandSize = 384;
inline constexpr std::size_t kPathSize = 160;
inline constexpr std::size_t kCpuListSize = 48;
// The same datagram is sent again this often, so a collector that started
// later, or lost the datagram, still gets it. Datagrams are not acknowledged.
inline constexpr std::uint32_t kRepeatSeconds = 10;

// A value the sampler could not read.
inline constexpr std::uint32_t kUnavailable32 =
    std::numeric_limits<std::uint32_t>::max();
inline constexpr std::uint64_t kUnavailable64 =
    std::numeric_limits<std::uint64_t>::max();
inline constexpr std::int32_t kUnavailableAdjust =
    std::numeric_limits<std::int32_t>::min();
inline constexpr std::uint8_t kUnavailable8 = 255;

// Seccomp mode, as in the "Seccomp:" line of /proc/PID/status.
enum class Seccomp : std::uint8_t
{
  Off = 0,
  Strict = 1,
  Filter = 2
};

// What was cut or could not be read.
enum class Flags : std::uint16_t
{
  None = 0,
  // The program file was replaced or removed after the process started.
  ExeDeleted = 1,
  CommandTruncated = 2,
  ExeTruncated = 4,
  CwdTruncated = 8,
  CpuListTruncated = 16,
  // /proc/PID/exe or cwd could not be read (another user, or a process that
  // is not dumpable).
  ExeHidden = 32,
  CwdHidden = 64
};
inline constexpr std::uint16_t kKnownFlags = 127;

[[nodiscard]] constexpr Flags operator|(Flags p_left, Flags p_right) noexcept
{
  return static_cast<Flags>(std::to_underlying(p_left) |
                            std::to_underlying(p_right));
}
[[nodiscard]] constexpr bool HasFlag(Flags p_flags, Flags p_flag) noexcept
{
  return (std::to_underlying(p_flags) & std::to_underlying(p_flag)) != 0;
}

inline constexpr std::array<char, 4> kMagic{'T', 'P', 'I', 'N'};

struct Packet
{
  std::array<char, 4> magic_ = kMagic;
  std::uint8_t version_ = kVersion;
  std::uint8_t seccomp_ = kUnavailable8;       // Seccomp, or kUnavailable8
  std::uint8_t no_new_privs_ = kUnavailable8;  // 0, 1 or kUnavailable8
  std::uint8_t reserved_ = 0;                  // zero
  std::uint64_t session_{};
  std::uint64_t monotonic_ns_{};
  std::uint64_t wall_ns_{};
  std::uint64_t process_start_{};  // /proc/PID/stat starttime, clock ticks
  // The same moment as wall-clock time (CLOCK_REALTIME, nanoseconds), worked
  // out on the sampler's host, which knows the boot time. Zero when unknown.
  // The collector can be on another host.
  std::uint64_t started_wall_ns_{};
  std::uint32_t pid_{};
  std::uint32_t parent_pid_ = kUnavailable32;
  std::uint32_t uid_real_ = kUnavailable32;
  std::uint32_t uid_effective_ = kUnavailable32;
  std::uint32_t gid_real_ = kUnavailable32;
  std::uint32_t gid_effective_ = kUnavailable32;
  // Capabilities in the effective set, one bit each (CapEff).
  std::uint64_t cap_effective_ = kUnavailable64;
  std::int32_t oom_score_adj_ = kUnavailableAdjust;
  Flags flags_{};
  std::array<std::uint8_t, 2> reserved_end_{};  // zero
  // NUL-terminated text. The command line has its NUL separators replaced
  // by spaces.
  std::array<char, kCommandSize> command_{};
  std::array<char, kPathSize> exe_{};
  std::array<char, kPathSize> cwd_{};
  // "Cpus_allowed_list" of /proc/PID/status, such as "0-3,8".
  std::array<char, kCpuListSize> cpus_allowed_{};
};
static_assert(wire::WireStruct<Packet>);
static_assert(offsetof(Packet, session_) == 8 &&
              offsetof(Packet, started_wall_ns_) == 40 &&
              offsetof(Packet, pid_) == 48 &&
              offsetof(Packet, cap_effective_) == 72 &&
              offsetof(Packet, command_) == 88);
inline constexpr std::size_t kPacketSize = sizeof(Packet);
// Fits an unfragmented UDP datagram on a 1,500-byte Ethernet MTU, and is
// below the size of the collector's receive buffer.
static_assert(kPacketSize <= 1400);

// Copies the start of p_text into p_out, NUL-terminated. Returns whether
// all of it fitted.
template <std::size_t N>
bool CopyStart(std::array<char, N>& p_out, std::string_view p_text) noexcept
{
  const auto length = std::min(p_text.size(), N - 1);
  std::ranges::copy(p_text.substr(0, length), p_out.begin());
  p_out[length] = '\0';
  return length == p_text.size();
}

// Copies the end of p_text into p_out, NUL-terminated. Returns whether all
// of it fitted.
template <std::size_t N>
bool CopyEnd(std::array<char, N>& p_out, std::string_view p_text) noexcept
{
  const auto length = std::min(p_text.size(), N - 1);
  std::ranges::copy(p_text.substr(p_text.size() - length), p_out.begin());
  p_out[length] = '\0';
  return length == p_text.size();
}

// The text of a NUL-terminated field. Decode() checked the terminator.
template <std::size_t N>
[[nodiscard]] std::string_view Text(const std::array<char, N>& p_field) noexcept
{
  return {p_field.data(), std::char_traits<char>::length(p_field.data())};
}

// The bytes to send.
[[nodiscard]] inline std::span<const std::byte, kPacketSize> Encode(
    const Packet& p_packet) noexcept
{
  return wire::AsBytes(p_packet);
}

// Checks the format (length, magic, version, reserved bytes, text
// terminators) and that the identities and clocks are set. Whether the
// values make sense is up to the reader.
[[nodiscard]] inline std::expected<Packet, std::string_view> Decode(
    std::span<const std::byte> p_data)
{
  if (p_data.size() < 4 ||
      std::memcmp(p_data.data(), kMagic.data(), kMagic.size()) != 0)
  {
    return std::unexpected("not a process-info datagram");
  }
  if (p_data.size() != kPacketSize)
  {
    return std::unexpected("invalid process-info length");
  }
  const auto packet = wire::FromBytes<Packet>(p_data);
  if (packet.version_ != kVersion)
  {
    return std::unexpected("unsupported process-info protocol");
  }
  if (packet.reserved_ != 0 ||
      packet.reserved_end_ != decltype(packet.reserved_end_){} ||
      (std::to_underlying(packet.flags_) & ~kKnownFlags) != 0 ||
      (packet.seccomp_ > std::to_underlying(Seccomp::Filter) &&
       packet.seccomp_ != kUnavailable8) ||
      (packet.no_new_privs_ > 1 && packet.no_new_privs_ != kUnavailable8))
  {
    return std::unexpected("invalid process-info header");
  }
  if (packet.pid_ == 0 || packet.process_start_ == 0 ||
      packet.monotonic_ns_ == 0 || packet.wall_ns_ == 0)
  {
    return std::unexpected("invalid process-info identity or clock");
  }
  if (packet.command_.back() != '\0' || packet.exe_.back() != '\0' ||
      packet.cwd_.back() != '\0' || packet.cpus_allowed_.back() != '\0')
  {
    return std::unexpected("unterminated process-info text");
  }
  return packet;
}

}  // namespace triangulator::process_wire
