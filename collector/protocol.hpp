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

#include "../common/wire.hpp"
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

// The text before the first NUL, with invalid UTF-8 replaced.
template <std::size_t Size>
[[nodiscard]] std::string ReadName(const std::array<char, Size>& p_field)
{
  const std::string_view field{p_field.data(), p_field.size()};
  return SanitizeUtf8(field.substr(0, field.find('\0')));
}

[[nodiscard]] inline std::expected<Packet, std::string_view> Decode(
    std::span<const std::byte> p_data)
{
  const auto header = wire::DecodeHeader(p_data);
  if (!header)
  {
    return std::unexpected(header.error());
  }
  Packet packet;
  packet.flags_ = std::to_underlying(header->flags_);
  packet.chunk_ = header->chunk_;
  packet.chunks_ = header->chunks_;
  packet.session_ = header->session_;
  packet.sequence_ = header->sequence_;
  packet.monotonic_ns_ = header->monotonic_ns_;
  packet.wall_ns_ = header->wall_ns_;
  packet.interval_ms_ = header->interval_ms_;
  packet.pid_ = header->pid_;
  const auto count = header->records_;
  if ((packet.flags_ & ~3) != 0)
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
    const auto wire_record =
        wire::DecodeRecord(p_data.subspan(offset).first<kRecordSize>());
    Record record;
    record.tid_ = wire_record.tid_;
    record.flags_ = std::to_underlying(wire_record.flags_);
    const auto state = static_cast<std::uint8_t>(wire_record.state_);
    if (record.tid_ == 0 || state < 32 || state >= 127 ||
        (record.flags_ & ~kIoUnavailable) != 0)
    {
      return std::unexpected("invalid thread record");
    }
    record.state_ = wire_record.state_;
    record.processor_ = wire_record.processor_;
    record.utime_ = wire_record.utime_;
    record.stime_ = wire_record.stime_;
    record.run_delay_ = wire_record.run_delay_;
    record.timeslices_ = wire_record.timeslices_;
    record.major_faults_ = wire_record.major_faults_;
    record.read_bytes_ = wire_record.read_bytes_;
    record.write_bytes_ = wire_record.write_bytes_;
    record.comm_ = ReadName(wire_record.comm_);
    record.wchan_ = ReadName(wire_record.wchan_);
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
