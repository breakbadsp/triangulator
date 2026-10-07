#pragma once

// The sampler-to-collector datagram format, shared by both programs. This
// header depends only on the standard library.

#include <array>
#include <bit>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <span>
#include <string_view>
#include <type_traits>
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

// The wire structs below are the datagram format itself, like TigerBeetle's
// extern structs: the sampler sends their bytes and the collector reads the
// bytes back into them, with no field-by-field encoding. This is correct only
// on a little-endian host with no padding between the fields, so the build
// checks both. Change a wire struct only together with its version, the
// static_asserts after it and tests/wire.py.
static_assert(std::endian::native == std::endian::little,
              "the wire structs are little-endian; byte swaps are needed here");

// A type that can be a wire struct: copied as bytes, with no padding (so no
// uninitialized bytes go onto the network and equal values have equal
// bytes). Do not use bool, bit-fields or pointers in wire structs; a wire
// byte can hold any value, so use integers and let the reader check them.
template <typename TWire>
concept WireStruct =
    std::is_trivially_copyable_v<TWire> && std::is_standard_layout_v<TWire> &&
    std::has_unique_object_representations_v<TWire>;

// The bytes to send for p_value.
template <WireStruct TWire>
[[nodiscard]] std::span<const std::byte, sizeof(TWire)> AsBytes(
    const TWire& p_value) noexcept
{
  return std::as_bytes(std::span<const TWire, 1>{&p_value, 1});
}

// The wire struct in the first sizeof(TWire) bytes of p_data. The caller
// checks the length first.
//
// Why memcpy and not reinterpret_cast: recv() writes bytes into a std::byte
// buffer, and no TWire object exists at that address. Reading one through
// reinterpret_cast<const TWire*>(p_data.data()) is undefined behaviour
// (object lifetime, [basic.life], and strict aliasing, [basic.lval]), and the
// buffer can also be misaligned for TWire. The compiler can then miscompile
// the reads. memcpy into a local object is defined for trivially copyable
// types, and GCC and Clang make it plain loads with no call. The cost is one
// copy of a small struct, which is small next to the checks that follow.
//
// Options for a later change that removes the copy:
// - std::start_lifetime_as<TWire>(p_data.data()) (C++23, P2590) makes the
//   bytes a TWire object in place. The buffer must be aligned for TWire.
//   libstdc++ 16 and Clang 22 have it (__cpp_lib_start_lifetime_as); GCC 13,
//   the oldest compiler the README supports, does not.
// - recv() directly into an aligned wire struct, so the kernel writes the
//   bytes of an object that already exists. That needs one buffer for each
//   format, or a check of the magic before the receive.
// - reinterpret_cast with -fno-strict-aliasing, as the Linux kernel does.
//   Do not use it: it removes the optimization for all the code, and it does
//   not fix the lifetime or alignment problems.
template <WireStruct TWire>
[[nodiscard]] TWire FromBytes(std::span<const std::byte> p_data) noexcept
{
  assert(p_data.size() >= sizeof(TWire));
  TWire value;
  std::memcpy(&value, p_data.data(), sizeof(TWire));
  return value;
}

// One thread's sample. The name fields are NUL-padded bytes; decoding them
// into strings is up to the reader.
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
static_assert(WireStruct<Record> && sizeof(Record) == kRecordSize);
static_assert(offsetof(Record, processor_) == 6 &&
              offsetof(Record, write_bytes_) == 56 &&
              offsetof(Record, comm_) == 64 && offsetof(Record, wchan_) == 80);

inline constexpr std::array<char, 4> kMagic{'T', 'M', 'O', 'N'};

struct Header
{
  std::array<char, 4> magic_ = kMagic;
  std::uint8_t version_ = kVersion;
  Flags flags_{};
  std::uint8_t chunk_{};
  std::uint8_t chunks_{};
  std::uint64_t session_{};
  std::uint32_t sequence_{};
  std::uint16_t records_{};
  // Zero. The collector rejects other values, so a later version can use
  // these bytes.
  std::array<std::uint8_t, 2> reserved_{};
  std::uint64_t monotonic_ns_{};
  std::uint64_t wall_ns_{};
  std::uint32_t interval_ms_{};
  std::uint32_t pid_{};
};
static_assert(WireStruct<Header> && sizeof(Header) == kHeaderSize);
static_assert(offsetof(Header, session_) == 8 &&
              offsetof(Header, records_) == 20 &&
              offsetof(Header, monotonic_ns_) == 24 &&
              offsetof(Header, pid_) == 44);

// One datagram: the header, then the first header_.records_ records. Send
// only those bytes (DatagramSize).
struct Packet
{
  Header header_;
  std::array<Record, kRecordsPerPacket> records_{};
};
static_assert(WireStruct<Packet> && sizeof(Packet) == kPacketSize);

[[nodiscard]] constexpr std::size_t DatagramSize(std::size_t p_records) noexcept
{
  return kHeaderSize + p_records * kRecordSize;
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
  const auto header = FromBytes<Header>(p_data);
  if (header.magic_ != kMagic || header.version_ != kVersion)
  {
    return std::unexpected("unsupported protocol");
  }
  return header;
}

}  // namespace triangulator::wire
