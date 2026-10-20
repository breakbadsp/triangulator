#pragma once

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <span>
#include <string_view>

#include "wire.hpp"

namespace triangulator::target_wire
{

inline constexpr std::size_t kMaxTargets = 16;
inline constexpr std::array<char, 4> kMagic{'T', 'T', 'G', 'T'};

enum class Access : std::uint8_t
{
  Full = 0,
  Limited = 1
};

// CPU counters cover all targets on this sampler. The collector converts
// their interval deltas to a percentage of one CPU core.
struct Packet
{
  std::array<char, 4> magic_ = kMagic;
  std::uint8_t version_ = 1;
  Access access_ = Access::Full;
  std::array<std::uint8_t, 2> reserved_{};
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
static_assert(offsetof(Packet, session_) == 8 &&
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

[[nodiscard]] inline std::expected<Packet, std::string_view> Decode(
    std::span<const std::byte> p_bytes) noexcept
{
  if (p_bytes.size() != sizeof(Packet))
  {
    return std::unexpected("invalid target announcement length");
  }
  const auto packet = wire::FromBytes<Packet>(p_bytes);
  if (packet.magic_ != kMagic || packet.version_ != 1 ||
      packet.reserved_ != std::array<std::uint8_t, 2>{} ||
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
