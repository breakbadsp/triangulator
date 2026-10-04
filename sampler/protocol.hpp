#pragma once

#include <bit>
#include <concepts>
#include <cstddef>
#include <span>
#include <utility>

#include "parsing.hpp"

namespace triangulator::wire
{

inline constexpr std::size_t kHeaderSize = 48;
inline constexpr std::uint8_t kVersion = 2;
inline constexpr std::size_t kRecordSize = 112;
inline constexpr std::size_t kRecordsPerPacket = 10;
inline constexpr std::size_t kMaxThreads = kRecordsPerPacket * 255;
inline constexpr std::size_t kPacketSize =
    kHeaderSize + kRecordsPerPacket * kRecordSize;
using Record = std::array<std::byte, kRecordSize>;
using Packet = std::array<std::byte, kPacketSize>;
static_assert(kPacketSize == 1168);

enum class Flags : std::uint8_t
{
  None = 0,
  TargetAbsent = 1,
  StatusFallback = 2
};
enum class RecordFlags : std::uint8_t
{
  None = 0,
  IoUnavailable = 1
};
constexpr Flags operator|(Flags p_left, Flags p_right) noexcept
{
  return static_cast<Flags>(std::to_underlying(p_left) |
                            std::to_underlying(p_right));
}

template <std::unsigned_integral Number>
void WriteLittleEndian(std::span<std::byte, sizeof(Number)> p_destination,
                       Number p_value)
{
  if constexpr (std::endian::native == std::endian::big)
  {
    p_value = std::byteswap(p_value);
  }
  const auto bytes =
      std::bit_cast<std::array<std::byte, sizeof(Number)>>(p_value);
  std::ranges::copy(bytes, p_destination.begin());
}

[[nodiscard]] inline Record EncodeRecord(int p_tid, const ThreadStat& p_stat,
                                         const SchedulerCounters& p_counters,
                                         const std::optional<IoCounters>& p_io,
                                         const WaitChannel& p_wchan)
{
  Record record{};
  const std::span buffer{record};
  const auto io_values = p_io.value_or(IoCounters{});
  WriteLittleEndian(buffer.subspan<0, 4>(), static_cast<std::uint32_t>(p_tid));
  record[4] = static_cast<std::byte>(p_stat.state_);
  record[5] = static_cast<std::byte>(p_io ? RecordFlags::None
                                          : RecordFlags::IoUnavailable);
  WriteLittleEndian(buffer.subspan<6, 2>(), p_stat.processor_);
  WriteLittleEndian(buffer.subspan<8, 8>(), p_stat.utime_);
  WriteLittleEndian(buffer.subspan<16, 8>(), p_stat.stime_);
  WriteLittleEndian(buffer.subspan<24, 8>(), p_counters.run_delay_);
  WriteLittleEndian(buffer.subspan<32, 8>(), p_counters.timeslices_);
  WriteLittleEndian(buffer.subspan<40, 8>(), p_stat.major_faults_);
  WriteLittleEndian(buffer.subspan<48, 8>(), io_values.read_bytes_);
  WriteLittleEndian(buffer.subspan<56, 8>(), io_values.write_bytes_);
  std::ranges::copy(std::as_bytes(std::span{p_stat.name_}),
                    buffer.subspan<64, 16>().begin());
  std::ranges::copy(std::as_bytes(std::span{p_wchan}),
                    buffer.subspan<80, 32>().begin());
  return record;
}

struct Header
{
  Flags flags_{};
  std::uint8_t chunk_{};
  std::uint8_t chunks_{};
  std::uint64_t session_{};
  std::uint32_t sequence_{};
  std::uint16_t records_{};
  std::uint64_t monotonic_ns_{};
  std::uint64_t wall_ns_{};
  std::uint32_t interval_ms_{};
  std::uint32_t pid_{};
};

inline void EncodeHeader(std::span<std::byte, kHeaderSize> p_buffer,
                         const Header& p_header)
{
  std::ranges::fill(p_buffer, std::byte{0});
  constexpr std::array kMagic{std::byte{'T'}, std::byte{'M'}, std::byte{'O'},
                              std::byte{'N'}};
  std::ranges::copy(kMagic, p_buffer.begin());
  p_buffer[4] = std::byte{kVersion};
  p_buffer[5] = static_cast<std::byte>(p_header.flags_);
  p_buffer[6] = static_cast<std::byte>(p_header.chunk_);
  p_buffer[7] = static_cast<std::byte>(p_header.chunks_);
  WriteLittleEndian(p_buffer.subspan<8, 8>(), p_header.session_);
  WriteLittleEndian(p_buffer.subspan<16, 4>(), p_header.sequence_);
  WriteLittleEndian(p_buffer.subspan<20, 2>(), p_header.records_);
  WriteLittleEndian(p_buffer.subspan<24, 8>(), p_header.monotonic_ns_);
  WriteLittleEndian(p_buffer.subspan<32, 8>(), p_header.wall_ns_);
  WriteLittleEndian(p_buffer.subspan<40, 4>(), p_header.interval_ms_);
  WriteLittleEndian(p_buffer.subspan<44, 4>(), p_header.pid_);
}

}  // namespace triangulator::wire
