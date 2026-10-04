#pragma once

#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "../sampler/protocol.hpp"
#include "json.hpp"

namespace triangulator::collector
{

// Wire sizes, version and flag values come from the sampler's own header, so
// the two programs cannot disagree about the format.
using wire::kHeaderSize;
using wire::kRecordSize;
using wire::kRecordsPerPacket;
inline constexpr std::uint8_t kTargetAbsent =
    std::to_underlying(wire::Flags::TargetAbsent);
inline constexpr std::uint8_t kStatusFallback =
    std::to_underlying(wire::Flags::StatusFallback);
inline constexpr std::uint8_t kIoUnavailable =
    std::to_underlying(wire::RecordFlags::IoUnavailable);

struct Record
{
  std::uint32_t tid_{};
  char state_{};
  std::uint8_t flags_{};
  std::uint16_t processor_{};
  std::uint64_t utime_{};
  std::uint64_t stime_{};
  std::uint64_t run_delay_{};
  std::uint64_t timeslices_{};
  std::uint64_t major_faults_{};
  std::uint64_t read_bytes_{};
  std::uint64_t write_bytes_{};
  std::string comm_;
  std::string wchan_;

  // False when the sampler could not read the thread's io file.
  [[nodiscard]] bool HasIo() const noexcept
  {
    return (flags_ & kIoUnavailable) == 0;
  }
  [[nodiscard]] std::array<std::uint64_t, 5> Counters() const noexcept
  {
    return {utime_, stime_, run_delay_, timeslices_, major_faults_};
  }
};

struct Packet
{
  std::uint8_t flags_{};
  std::uint8_t chunk_{};
  std::uint8_t chunks_{};
  std::uint64_t session_{};
  std::uint32_t sequence_{};
  std::uint64_t monotonic_ns_{};
  std::uint64_t wall_ns_{};
  std::uint32_t interval_ms_{};
  std::uint32_t pid_{};
  std::vector<Record> records_;

  // Every chunk of one tick carries the same header apart from chunk_.
  [[nodiscard]] bool SameTick(const Packet& p_other) const noexcept
  {
    return flags_ == p_other.flags_ && chunks_ == p_other.chunks_ &&
           session_ == p_other.session_ && sequence_ == p_other.sequence_ &&
           monotonic_ns_ == p_other.monotonic_ns_ &&
           wall_ns_ == p_other.wall_ns_ &&
           interval_ms_ == p_other.interval_ms_ && pid_ == p_other.pid_;
  }
};

template <std::unsigned_integral Number>
[[nodiscard]] Number ReadLittleEndian(std::span<const std::byte> p_bytes,
                                      std::size_t p_offset)
{
  std::array<std::byte, sizeof(Number)> bytes{};
  std::memcpy(bytes.data(), p_bytes.data() + p_offset, sizeof(Number));
  auto value = std::bit_cast<Number>(bytes);
  if constexpr (std::endian::native == std::endian::big)
  {
    value = std::byteswap(value);
  }
  return value;
}

// The text before the first NUL, with invalid UTF-8 replaced.
[[nodiscard]] inline std::string ReadName(std::span<const std::byte> p_bytes,
                                          std::size_t p_offset,
                                          std::size_t p_size)
{
  const std::string_view field{
      reinterpret_cast<const char*>(p_bytes.data() + p_offset), p_size};
  return SanitizeUtf8(field.substr(0, field.find('\0')));
}

[[nodiscard]] inline std::expected<Packet, std::string_view> Decode(
    std::span<const std::byte> p_data)
{
  if (p_data.size() < kHeaderSize)
  {
    return std::unexpected("short header");
  }
  Packet packet;
  const auto version = std::to_integer<std::uint8_t>(p_data[4]);
  packet.flags_ = std::to_integer<std::uint8_t>(p_data[5]);
  packet.chunk_ = std::to_integer<std::uint8_t>(p_data[6]);
  packet.chunks_ = std::to_integer<std::uint8_t>(p_data[7]);
  packet.session_ = ReadLittleEndian<std::uint64_t>(p_data, 8);
  packet.sequence_ = ReadLittleEndian<std::uint32_t>(p_data, 16);
  const auto count = ReadLittleEndian<std::uint16_t>(p_data, 20);
  packet.monotonic_ns_ = ReadLittleEndian<std::uint64_t>(p_data, 24);
  packet.wall_ns_ = ReadLittleEndian<std::uint64_t>(p_data, 32);
  packet.interval_ms_ = ReadLittleEndian<std::uint32_t>(p_data, 40);
  packet.pid_ = ReadLittleEndian<std::uint32_t>(p_data, 44);
  if (std::memcmp(p_data.data(), "TMON", 4) != 0 || version != wire::kVersion ||
      (packet.flags_ & ~3) != 0)
  {
    return std::unexpected("unsupported protocol");
  }
  if (packet.chunks_ == 0 || packet.chunk_ >= packet.chunks_ ||
      count > kRecordsPerPacket ||
      p_data.size() != kHeaderSize + count * kRecordSize)
  {
    return std::unexpected("invalid packet length or chunk");
  }
  if (packet.interval_ms_ < 100 || packet.interval_ms_ > 5000 ||
      packet.monotonic_ns_ == 0 || packet.wall_ns_ == 0)
  {
    return std::unexpected("invalid sample clock");
  }
  const bool absent = (packet.flags_ & kTargetAbsent) != 0;
  if (absent && (count != 0 || packet.pid_ != 0 || packet.chunks_ != 1))
  {
    return std::unexpected("invalid absent heartbeat");
  }
  if (!absent && packet.pid_ == 0)
  {
    return std::unexpected("missing target pid");
  }
  packet.records_.reserve(count);
  for (std::size_t offset = kHeaderSize; offset < p_data.size();
       offset += kRecordSize)
  {
    Record record;
    record.tid_ = ReadLittleEndian<std::uint32_t>(p_data, offset);
    const auto state = std::to_integer<std::uint8_t>(p_data[offset + 4]);
    record.flags_ = std::to_integer<std::uint8_t>(p_data[offset + 5]);
    if (record.tid_ == 0 || state < 32 || state >= 127 ||
        (record.flags_ & ~kIoUnavailable) != 0)
    {
      return std::unexpected("invalid thread record");
    }
    record.state_ = static_cast<char>(state);
    record.processor_ = ReadLittleEndian<std::uint16_t>(p_data, offset + 6);
    record.utime_ = ReadLittleEndian<std::uint64_t>(p_data, offset + 8);
    record.stime_ = ReadLittleEndian<std::uint64_t>(p_data, offset + 16);
    record.run_delay_ = ReadLittleEndian<std::uint64_t>(p_data, offset + 24);
    record.timeslices_ = ReadLittleEndian<std::uint64_t>(p_data, offset + 32);
    record.major_faults_ = ReadLittleEndian<std::uint64_t>(p_data, offset + 40);
    record.read_bytes_ = ReadLittleEndian<std::uint64_t>(p_data, offset + 48);
    record.write_bytes_ = ReadLittleEndian<std::uint64_t>(p_data, offset + 56);
    record.comm_ = ReadName(p_data, offset + 64, 16);
    record.wchan_ = ReadName(p_data, offset + 80, 32);
    for (const auto& previous : packet.records_)
    {
      if (previous.tid_ == record.tid_)
      {
        return std::unexpected("duplicate thread");
      }
    }
    packet.records_.push_back(std::move(record));
  }
  return packet;
}

// Kernel wait-channel names (/proc/<tid>/wchan) mapped to coarse states.
// Names vary across kernel versions, so matching is by substring; unknown
// names show as "other" with the raw wchan alongside.
inline constexpr std::array<std::pair<std::string_view, std::string_view>, 14>
    kWchanStates{{{"futex", "futex"},
                  {"epoll", "poll"},
                  {"poll", "poll"},
                  {"select", "poll"},
                  {"skb", "socket"},
                  {"sk_wait", "socket"},
                  {"sock", "socket"},
                  {"unix_stream", "socket"},
                  {"inet_csk", "socket"},
                  {"tcp_", "socket"},
                  {"udp_", "socket"},
                  {"pipe", "pipe"},
                  {"eventfd", "pipe"},
                  {"nanosleep", "sleep"}}};

[[nodiscard]] inline std::string_view Classify(const Record& p_record)
{
  if (p_record.state_ == 'D')
  {
    return "kernel";
  }
  if (p_record.state_ == 'R')
  {
    return "running";
  }
  if (p_record.state_ == 't' || p_record.state_ == 'T')
  {
    return "stopped";
  }
  if (p_record.wchan_.empty())
  {
    return "no_access";
  }
  for (const auto& [needle, state] : kWchanStates)
  {
    if (p_record.wchan_.find(needle) != std::string::npos)
    {
      return state;
    }
  }
  return "other";
}

[[nodiscard]] inline Json RecordJson(const Record& p_record)
{
  return JsonObject{{"tid", p_record.tid_},
                    {"state", std::string(1, p_record.state_)},
                    {"flags", p_record.flags_},
                    {"processor", p_record.processor_},
                    {"utime", p_record.utime_},
                    {"stime", p_record.stime_},
                    {"run_delay", p_record.run_delay_},
                    {"timeslices", p_record.timeslices_},
                    {"major_faults", p_record.major_faults_},
                    {"read_bytes", p_record.read_bytes_},
                    {"write_bytes", p_record.write_bytes_},
                    {"comm", p_record.comm_},
                    {"wchan", p_record.wchan_}};
}

}  // namespace triangulator::collector
