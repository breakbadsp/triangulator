#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <format>
#include <span>
#include <string_view>

#include "wire.hpp"

namespace triangulator::target_wire
{

inline constexpr std::size_t kMaxTargets = 16;
// The longest target ID; Packet::target_ keeps a terminating NUL.
inline constexpr std::size_t kMaxIdBytes = 31;
inline constexpr std::array<char, 4> kMagic{'T', 'T', 'G', 'T'};

enum class Access : std::uint8_t
{
  Full = 0,
  Limited = 1
};

// Bits of Packet::flags_. A legacy target table sends 0, so its packets
// stay the same and older collectors still accept them. A discovered target
// sets the rules that select it, and its ID suffix N (as in "worker.2") in
// the top bits, so the collector can find the exact name without parsing.
// kNameSelected: the exact name in the ID selects it. kOtherRuleSelected:
// another rule selects it, a pattern, after a rename another exact name, or
// the rule of its discovered parent, so a Remove of the ID's name would not
// stop it.
inline constexpr std::uint8_t kReleased = 1;
inline constexpr std::uint8_t kNameSelected = 2;
inline constexpr std::uint8_t kOtherRuleSelected = 4;
inline constexpr unsigned kOrdinalShift = 3;

[[nodiscard]] constexpr std::uint8_t Ordinal(std::uint8_t p_flags) noexcept
{
  return static_cast<std::uint8_t>(p_flags >> kOrdinalShift);
}

// CPU counters cover all targets on this sampler. The collector converts
// their interval deltas to a percentage of one CPU core.
struct Packet
{
  std::array<char, 4> magic_ = kMagic;
  std::uint8_t version_ = 1;
  Access access_ = Access::Full;
  std::uint8_t flags_{};
  // Matching processes that the sampler could not admit in its last
  // discovery pass, at most 255. Zero for a legacy target table.
  std::uint8_t excluded_{};
  std::uint64_t session_{};
  std::uint32_t pid_{};
  std::uint32_t effective_millihz_{};
  std::uint64_t process_start_{};
  std::uint64_t cpu_ns_{};
  std::uint64_t elapsed_ns_{};
  std::uint32_t configured_millihz_{};
  std::uint32_t budget_basis_points_{};
  std::array<char, 32> target_{};
  std::array<char, 64> host_{};
};
static_assert(wire::WireStruct<Packet> && sizeof(Packet) == 152);
static_assert(offsetof(Packet, flags_) == 6 &&
              offsetof(Packet, session_) == 8 &&
              offsetof(Packet, target_) == 56);

// These names are also URL and file keys. Restrict them to portable bytes.
[[nodiscard]] inline bool ValidName(std::string_view p_name,
                                    std::size_t p_max_bytes) noexcept
{
  return !p_name.empty() && p_name.size() <= p_max_bytes && p_name != "." &&
         p_name != ".." &&
         std::ranges::all_of(
             p_name,
             [](unsigned char p_character)
             {
               return (p_character >= 'a' && p_character <= 'z') ||
                      (p_character >= 'A' && p_character <= 'Z') ||
                      (p_character >= '0' && p_character <= '9') ||
                      p_character == '-' || p_character == '_' ||
                      p_character == '.';
             });
}

template <std::size_t kSize>
[[nodiscard]] inline std::string_view Text(
    const std::array<char, kSize>& p_text) noexcept
{
  return {p_text.data(), ::strnlen(p_text.data(), kSize)};
}

template <std::size_t kSize>
inline void SetText(std::array<char, kSize>& p_field,
                    std::string_view p_text) noexcept
{
  p_field = {};
  std::memcpy(p_field.data(), p_text.data(),
              std::min(p_text.size(), kSize - 1));
}

// A discovered ID with an ordinal N ends with ".N", so a reader can strip it.
[[nodiscard]] inline bool OrdinalMatches(const Packet& p_packet) noexcept
{
  const auto ordinal = Ordinal(p_packet.flags_);
  if (ordinal == 0)
  {
    return true;
  }
  if (ordinal == 1 || ordinal > kMaxTargets)
  {
    return false;
  }
  std::array<char, 4> suffix{};
  const auto end = std::format_to_n(suffix.data(), suffix.size(), ".{}",
                                    static_cast<unsigned>(ordinal));
  const std::string_view text{suffix.data(),
                              static_cast<std::size_t>(end.size)};
  const auto target = Text(p_packet.target_);
  return target.size() > text.size() && target.ends_with(text);
}

// The process name that an exact-name rule selects: the ID without its
// ".N" suffix. Only valid for a packet that Decode() accepted.
[[nodiscard]] inline std::string_view RuleName(std::string_view p_id,
                                               std::uint8_t p_flags) noexcept
{
  const auto ordinal = Ordinal(p_flags);
  const std::size_t suffix = ordinal == 0 ? 0 : ordinal < 10 ? 2 : 3;
  return p_id.substr(0, p_id.size() - suffix);
}

[[nodiscard]] inline std::expected<Packet, std::string_view> Decode(
    std::span<const std::byte> p_bytes) noexcept
{
  if (p_bytes.size() != sizeof(Packet))
  {
    return std::unexpected("invalid target announcement length");
  }
  const auto packet = wire::FromBytes<Packet>(p_bytes);
  if (packet.magic_ != kMagic || packet.version_ != 1 ||
      !OrdinalMatches(packet) ||
      (packet.access_ != Access::Full && packet.access_ != Access::Limited) ||
      packet.session_ == 0 || !ValidName(Text(packet.target_), 31) ||
      !ValidName(Text(packet.host_), 63) || packet.effective_millihz_ < 200 ||
      packet.effective_millihz_ > 10000 ||
      packet.configured_millihz_ < packet.effective_millihz_ ||
      packet.configured_millihz_ > 10000 ||
      packet.budget_basis_points_ > 10000 ||
      (packet.pid_ == 0) != (packet.process_start_ == 0))
  {
    return std::unexpected("invalid target announcement");
  }
  return packet;
}

}  // namespace triangulator::target_wire
