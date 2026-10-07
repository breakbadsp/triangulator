#pragma once

#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>

#include "../common/wire.hpp"
#include "shared.hpp"

namespace triangulator::socket_metrics
{
inline constexpr std::size_t kPacketSize = 160;
inline constexpr U32 kMessageEnabled = 1;
inline constexpr U32 kStopped = 2;
inline constexpr std::array<char, 4> kMagic{'T', 'S', 'I', 'O'};
inline constexpr U32 kVersion = 1;
// One TSIO datagram, as it is on the wire (see the wire structs in
// common/wire.hpp).
struct Observation
{
  std::array<char, 4> magic_ = kMagic;
  U32 version_ = kVersion;
  U64 observer_{};
  U64 sequence_{};
  U64 monotonic_ns_{};
  U64 wall_ns_{};
  U64 started_ns_{};
  U64 process_start_{};
  U64 losses_{};
  U32 pid_{};
  U32 index_{};  // 0 is the heartbeat; counters start at 1
  U32 count_{};
  U32 flags_{};
  CounterKey key_{};
  Counters counters_{};
};
static_assert(wire::WireStruct<Observation> &&
              sizeof(Observation) == kPacketSize);
static_assert(offsetof(Observation, pid_) == 64 &&
              offsetof(Observation, key_) == 80 &&
              offsetof(Observation, counters_) == 104);
using Datagram = std::array<std::byte, kPacketSize>;

inline Datagram Encode(const Observation& p_value)
{
  return std::bit_cast<Datagram>(p_value);
}

inline std::optional<Observation> Decode(std::span<const std::byte> p_data)
{
  if (p_data.size() != kPacketSize)
  {
    return std::nullopt;
  }
  const auto value = wire::FromBytes<Observation>(p_data);
  if (value.magic_ != kMagic || value.version_ != kVersion)
  {
    return std::nullopt;
  }
  if (!value.observer_ || !value.pid_ || !value.process_start_ ||
      !value.started_ns_ || value.monotonic_ns_ < value.started_ns_ ||
      !value.wall_ns_ || !value.count_ ||
      value.count_ > kMaxSocketCounters + 1 || value.index_ >= value.count_ ||
      (value.flags_ & ~3U) || value.sequence_ > INT64_MAX)
  {
    return std::nullopt;
  }
  if (value.index_ == 0)
  {
    for (std::size_t index = 80; index < kPacketSize; ++index)
    {
      if (p_data[index] != std::byte{})
      {
        return std::nullopt;
      }
    }
  }
  else if (!value.key_.tid_ || !value.key_.thread_start_ ||
           value.key_.kind_ < 1 || value.key_.kind_ > 6 ||
           (value.key_.kind_ == 6
                ? (value.key_.socket_id_ != 0 ||
                   !(value.flags_ & kMessageEnabled) ||
                   value.counters_.input_ || value.counters_.output_ ||
                   value.counters_.receives_ || value.counters_.sends_)
                : (!value.key_.socket_id_ || value.counters_.messages_)))
  {
    return std::nullopt;
  }
  return value;
}
}  // namespace triangulator::socket_metrics
