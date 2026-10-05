#pragma once

// The sampler-to-collector datagram format, shared by both programs. This
// header depends only on the standard library.

#include <algorithm>
#include <array>
#include <bit>
#include <concepts>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <span>
#include <string_view>
#include <utility>

namespace triangulator::wire
{

inline constexpr std::size_t kHeaderSize = 48;
inline constexpr std::uint8_t kVersion = 2;
inline constexpr std::size_t kRecordSize = 112;
inline constexpr std::size_t kRecordsPerPacket = 10;
inline constexpr std::size_t kMaxThreads = kRecordsPerPacket * 255;
inline constexpr std::size_t kPacketSize =
    kHeaderSize + kRecordsPerPacket * kRecordSize;
using RecordBytes = std::array<std::byte, kRecordSize>;
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

template <std::unsigned_integral TNumber>
void WriteLittleEndian(std::span<std::byte, sizeof(TNumber)> p_destination,
                       TNumber p_value)
{
  if constexpr (std::endian::native == std::endian::big)
  {
    p_value = std::byteswap(p_value);
  }
  const auto bytes =
      std::bit_cast<std::array<std::byte, sizeof(TNumber)>>(p_value);
  std::ranges::copy(bytes, p_destination.begin());
}

template <std::unsigned_integral TNumber>
[[nodiscard]] TNumber ReadLittleEndian(std::span<const std::byte> p_bytes,
                                       std::size_t p_offset)
{
  std::array<std::byte, sizeof(TNumber)> bytes{};
  std::memcpy(bytes.data(), p_bytes.data() + p_offset, sizeof(TNumber));
  auto value = std::bit_cast<TNumber>(bytes);
  if constexpr (std::endian::native == std::endian::big)
  {
    value = std::byteswap(value);
  }
  return value;
}

// One thread's sample as plain values. The name fields are the fixed-size,
// NUL-padded byte fields of the format; decoding them into strings is up to
// the reader.
struct Record
{
  std::uint32_t tid_{};
  char state_{};
  RecordFlags flags_{};
  std::uint16_t processor_{};
  std::uint64_t utime_{};
  std::uint64_t stime_{};
  std::uint64_t run_delay_{};
  std::uint64_t timeslices_{};
  std::uint64_t major_faults_{};
  std::uint64_t read_bytes_{};
  std::uint64_t write_bytes_{};
  std::array<char, 16> comm_{};
  std::array<char, 32> wchan_{};
};

inline void EncodeRecord(std::span<std::byte, kRecordSize> p_buffer,
                         const Record& p_record)
{
  WriteLittleEndian(p_buffer.subspan<0, 4>(), p_record.tid_);
  p_buffer[4] = static_cast<std::byte>(p_record.state_);
  p_buffer[5] = static_cast<std::byte>(p_record.flags_);
  WriteLittleEndian(p_buffer.subspan<6, 2>(), p_record.processor_);
  WriteLittleEndian(p_buffer.subspan<8, 8>(), p_record.utime_);
  WriteLittleEndian(p_buffer.subspan<16, 8>(), p_record.stime_);
  WriteLittleEndian(p_buffer.subspan<24, 8>(), p_record.run_delay_);
  WriteLittleEndian(p_buffer.subspan<32, 8>(), p_record.timeslices_);
  WriteLittleEndian(p_buffer.subspan<40, 8>(), p_record.major_faults_);
  WriteLittleEndian(p_buffer.subspan<48, 8>(), p_record.read_bytes_);
  WriteLittleEndian(p_buffer.subspan<56, 8>(), p_record.write_bytes_);
  std::ranges::copy(std::as_bytes(std::span{p_record.comm_}),
                    p_buffer.subspan<64, 16>().begin());
  std::ranges::copy(std::as_bytes(std::span{p_record.wchan_}),
                    p_buffer.subspan<80, 32>().begin());
}

// Reads every field as it is on the wire; it does not judge the values.
[[nodiscard]] inline Record DecodeRecord(
    std::span<const std::byte, kRecordSize> p_buffer)
{
  Record record;
  record.tid_ = ReadLittleEndian<std::uint32_t>(p_buffer, 0);
  record.state_ = static_cast<char>(p_buffer[4]);
  record.flags_ = static_cast<RecordFlags>(p_buffer[5]);
  record.processor_ = ReadLittleEndian<std::uint16_t>(p_buffer, 6);
  record.utime_ = ReadLittleEndian<std::uint64_t>(p_buffer, 8);
  record.stime_ = ReadLittleEndian<std::uint64_t>(p_buffer, 16);
  record.run_delay_ = ReadLittleEndian<std::uint64_t>(p_buffer, 24);
  record.timeslices_ = ReadLittleEndian<std::uint64_t>(p_buffer, 32);
  record.major_faults_ = ReadLittleEndian<std::uint64_t>(p_buffer, 40);
  record.read_bytes_ = ReadLittleEndian<std::uint64_t>(p_buffer, 48);
  record.write_bytes_ = ReadLittleEndian<std::uint64_t>(p_buffer, 56);
  std::memcpy(record.comm_.data(), p_buffer.data() + 64, record.comm_.size());
  std::memcpy(record.wchan_.data(), p_buffer.data() + 80, record.wchan_.size());
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

// Checks only what identifies the format (length, magic, version). Whether the
// values make sense is up to the reader.
[[nodiscard]] inline std::expected<Header, std::string_view> DecodeHeader(
    std::span<const std::byte> p_data)
{
  if (p_data.size() < kHeaderSize)
  {
    return std::unexpected("short header");
  }
  if (std::memcmp(p_data.data(), "TMON", 4) != 0 ||
      std::to_integer<std::uint8_t>(p_data[4]) != kVersion)
  {
    return std::unexpected("unsupported protocol");
  }
  Header header;
  header.flags_ = static_cast<Flags>(p_data[5]);
  header.chunk_ = std::to_integer<std::uint8_t>(p_data[6]);
  header.chunks_ = std::to_integer<std::uint8_t>(p_data[7]);
  header.session_ = ReadLittleEndian<std::uint64_t>(p_data, 8);
  header.sequence_ = ReadLittleEndian<std::uint32_t>(p_data, 16);
  header.records_ = ReadLittleEndian<std::uint16_t>(p_data, 20);
  header.monotonic_ns_ = ReadLittleEndian<std::uint64_t>(p_data, 24);
  header.wall_ns_ = ReadLittleEndian<std::uint64_t>(p_data, 32);
  header.interval_ms_ = ReadLittleEndian<std::uint32_t>(p_data, 40);
  header.pid_ = ReadLittleEndian<std::uint32_t>(p_data, 44);
  return header;
}

}  // namespace triangulator::wire
