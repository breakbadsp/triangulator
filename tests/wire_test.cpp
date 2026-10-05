// Tests for common/wire.hpp alone: encoding then decoding gives back the same
// values, and the header decoder rejects data that is not this format.

#include "../common/wire.hpp"

#include <array>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>

namespace
{

using namespace triangulator;

void Require(bool p_condition, std::string_view p_message)
{
  if (!p_condition)
  {
    throw std::runtime_error(std::string{p_message});
  }
}

// Encodes a record with distinct values (and the largest 64-bit value) and
// checks that decoding the bytes returns every field unchanged.
void TestRecordRoundTrip()
{
  wire::Record record{.tid_ = 0x01020304,
                      .state_ = 'S',
                      .flags_ = wire::RecordFlags::IoUnavailable,
                      .processor_ = 0x0506,
                      .utime_ = std::numeric_limits<std::uint64_t>::max(),
                      .stime_ = 2,
                      .run_delay_ = 3,
                      .timeslices_ = 4,
                      .major_faults_ = 5,
                      .read_bytes_ = 6,
                      .write_bytes_ = 7};
  std::ranges::copy(std::string_view{"worker"}, record.comm_.begin());
  std::ranges::copy(std::string_view{"futex_do_wait"}, record.wchan_.begin());
  wire::RecordBytes bytes{};
  wire::EncodeRecord(bytes, record);
  const auto decoded = wire::DecodeRecord(bytes);
  Require(decoded.tid_ == record.tid_ && decoded.state_ == record.state_ &&
              decoded.flags_ == record.flags_ &&
              decoded.processor_ == record.processor_ &&
              decoded.utime_ == record.utime_ &&
              decoded.stime_ == record.stime_ &&
              decoded.run_delay_ == record.run_delay_ &&
              decoded.timeslices_ == record.timeslices_ &&
              decoded.major_faults_ == record.major_faults_ &&
              decoded.read_bytes_ == record.read_bytes_ &&
              decoded.write_bytes_ == record.write_bytes_,
          "record numbers survive a round trip");
  Require(decoded.comm_ == record.comm_ && decoded.wchan_ == record.wchan_,
          "record names survive a round trip");
}

// Same as the record test, for the header.
void TestHeaderRoundTrip()
{
  const wire::Header header{
      .flags_ = wire::Flags::TargetAbsent | wire::Flags::StatusFallback,
      .chunk_ = 1,
      .chunks_ = 3,
      .session_ = std::numeric_limits<std::uint64_t>::max(),
      .sequence_ = 0x090a0b0c,
      .records_ = 10,
      .monotonic_ns_ = 12,
      .wall_ns_ = 13,
      .interval_ms_ = 1000,
      .pid_ = 0x01020304};
  std::array<std::byte, wire::kHeaderSize> bytes{};
  wire::EncodeHeader(bytes, header);
  const auto decoded = wire::DecodeHeader(bytes);
  Require(decoded.has_value(), "an encoded header decodes");
  Require(decoded->flags_ == header.flags_ && decoded->chunk_ == 1 &&
              decoded->chunks_ == 3 && decoded->session_ == header.session_ &&
              decoded->sequence_ == header.sequence_ &&
              decoded->records_ == 10 && decoded->monotonic_ns_ == 12 &&
              decoded->wall_ns_ == 13 && decoded->interval_ms_ == 1000 &&
              decoded->pid_ == header.pid_,
          "header fields survive a round trip");
}

// Damages a valid header one way at a time (too short, wrong magic, wrong
// version) and checks that DecodeHeader refuses each.
void TestHeaderRejectsOtherData()
{
  std::array<std::byte, wire::kHeaderSize> bytes{};
  wire::EncodeHeader(bytes, wire::Header{});
  Require(!wire::DecodeHeader(std::span{bytes}.first(wire::kHeaderSize - 1)),
          "a short header is rejected");
  auto bad_magic = bytes;
  bad_magic[0] = std::byte{'X'};
  Require(!wire::DecodeHeader(bad_magic), "wrong magic is rejected");
  auto bad_version = bytes;
  bad_version[4] = std::byte{wire::kVersion + 1};
  Require(!wire::DecodeHeader(bad_version), "wrong version is rejected");
}

}  // namespace

int main()
{
  try
  {
    TestRecordRoundTrip();
    TestHeaderRoundTrip();
    TestHeaderRejectsOtherData();
    std::puts("wire tests passed (record and header round trips, rejection)");
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
