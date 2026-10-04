#pragma once

#include <array>
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
struct Observation
{
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
using Datagram = std::array<std::byte, kPacketSize>;

inline Datagram Encode(const Observation& p_value)
{
  Datagram data{};
  std::memcpy(data.data(), "TSIO", 4);
  const std::span bytes{data};
  wire::WriteLittleEndian(bytes.subspan<4, 4>(), U32{1});
  const std::array<U64, 7> header{p_value.observer_,     p_value.sequence_,
                                  p_value.monotonic_ns_, p_value.wall_ns_,
                                  p_value.started_ns_,   p_value.process_start_,
                                  p_value.losses_};
  for (std::size_t index = 0; index < header.size(); ++index)
  {
    wire::WriteLittleEndian(
        std::span<std::byte, 8>{data.data() + 8 + index * 8, 8}, header[index]);
  }
  const std::array<U32, 4> fields{p_value.pid_, p_value.index_, p_value.count_,
                                  p_value.flags_};
  for (std::size_t index = 0; index < fields.size(); ++index)
  {
    wire::WriteLittleEndian(
        std::span<std::byte, 4>{data.data() + 64 + index * 4, 4},
        fields[index]);
  }
  wire::WriteLittleEndian(bytes.subspan<80, 8>(), p_value.key_.thread_start_);
  wire::WriteLittleEndian(bytes.subspan<88, 8>(), p_value.key_.socket_id_);
  wire::WriteLittleEndian(bytes.subspan<96, 4>(), p_value.key_.tid_);
  wire::WriteLittleEndian(bytes.subspan<100, 4>(), p_value.key_.kind_);
  const std::array<U64, 5> counters{
      p_value.counters_.input_, p_value.counters_.output_,
      p_value.counters_.receives_, p_value.counters_.sends_,
      p_value.counters_.messages_};
  for (std::size_t index = 0; index < counters.size(); ++index)
  {
    wire::WriteLittleEndian(
        std::span<std::byte, 8>{data.data() + 104 + index * 8, 8},
        counters[index]);
  }
  std::memcpy(data.data() + 144, p_value.counters_.name_, 16);
  return data;
}

inline std::optional<Observation> Decode(std::span<const std::byte> p_data)
{
  using wire::ReadLittleEndian;
  if (p_data.size() != kPacketSize ||
      std::memcmp(p_data.data(), "TSIO", 4) != 0 ||
      ReadLittleEndian<U32>(p_data, 4) != 1)
  {
    return std::nullopt;
  }
  Observation value{.observer_ = ReadLittleEndian<U64>(p_data, 8),
                    .sequence_ = ReadLittleEndian<U64>(p_data, 16),
                    .monotonic_ns_ = ReadLittleEndian<U64>(p_data, 24),
                    .wall_ns_ = ReadLittleEndian<U64>(p_data, 32),
                    .started_ns_ = ReadLittleEndian<U64>(p_data, 40),
                    .process_start_ = ReadLittleEndian<U64>(p_data, 48),
                    .losses_ = ReadLittleEndian<U64>(p_data, 56),
                    .pid_ = ReadLittleEndian<U32>(p_data, 64),
                    .index_ = ReadLittleEndian<U32>(p_data, 68),
                    .count_ = ReadLittleEndian<U32>(p_data, 72),
                    .flags_ = ReadLittleEndian<U32>(p_data, 76),
                    .key_ = {ReadLittleEndian<U64>(p_data, 80),
                             ReadLittleEndian<U64>(p_data, 88),
                             ReadLittleEndian<U32>(p_data, 96),
                             ReadLittleEndian<U32>(p_data, 100)},
                    .counters_ = {ReadLittleEndian<U64>(p_data, 104),
                                  ReadLittleEndian<U64>(p_data, 112),
                                  ReadLittleEndian<U64>(p_data, 120),
                                  ReadLittleEndian<U64>(p_data, 128),
                                  ReadLittleEndian<U64>(p_data, 136)}};
  if (!value.observer_ || !value.pid_ || !value.process_start_ ||
      !value.started_ns_ || value.monotonic_ns_ < value.started_ns_ ||
      !value.wall_ns_ || !value.count_ ||
      value.count_ > kMaxSocketCounters + 1 || value.index_ >= value.count_ ||
      (value.flags_ & ~3U) || value.sequence_ > INT64_MAX)
  {
    return std::nullopt;
  }
  std::memcpy(value.counters_.name_, p_data.data() + 144, 16);
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
