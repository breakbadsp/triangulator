// Tests for common/wire.hpp, common/resource_wire.hpp and
// common/memory_wire.hpp alone: encoding then
// decoding gives back the same values, and the decoders reject data that is
// not their format.

#include "../common/wire.hpp"

#include <array>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "../common/memory_wire.hpp"
#include "../common/resource_wire.hpp"

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

// Sends a record with distinct values (and the largest 64-bit value) as bytes
// and checks that reading the bytes returns every field unchanged.
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
  const auto decoded = wire::FromBytes<wire::Record>(wire::AsBytes(record));
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
  const auto decoded = wire::DecodeHeader(wire::AsBytes(header));
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
  std::ranges::copy(wire::AsBytes(wire::Header{}), bytes.begin());
  Require(!wire::DecodeHeader(std::span{bytes}.first(wire::kHeaderSize - 1)),
          "a short header is rejected");
  auto bad_magic = bytes;
  bad_magic[0] = std::byte{'X'};
  Require(!wire::DecodeHeader(bad_magic), "wrong magic is rejected");
  auto bad_version = bytes;
  bad_version[4] = std::byte{wire::kVersion + 1};
  Require(!wire::DecodeHeader(bad_version), "wrong version is rejected");
}

resource_wire::Header ResourceHeader(std::uint8_t p_parts)
{
  return resource_wire::Header{
      .parts_ = p_parts,
      .session_ = std::numeric_limits<std::uint64_t>::max(),
      .sequence_ = 0x01020304,
      .monotonic_ns_ = 11,
      .wall_ns_ = 12,
      .interval_ms_ = 5000,
      .pid_ = 0x05060708,
      .process_start_ = 13,
      .flags_ = resource_wire::Flags::DescriptorsHidden |
                resource_wire::Flags::SocketsTruncated};
}

// Every summary value, the unavailable marker and the cgroup path survive;
// the parts of one sample share their header.
void TestResourceSummaryRoundTrip()
{
  auto values = resource_wire::EmptySummary();
  for (std::size_t index = 0; index < values.size(); index += 2)
  {
    values[index] = index * 1000;
  }
  std::array<std::byte, resource_wire::kMaxPartSize> bytes{};
  const auto length = resource_wire::EncodeSummary(
      bytes, ResourceHeader(2), values, "/system.slice/app.service");
  Require(length == resource_wire::kSummaryPartSize, "summary length");
  const auto decoded = resource_wire::Decode(std::span{bytes}.first(length));
  Require(decoded.has_value(), "an encoded summary decodes");
  Require(decoded->header_.kind_ == resource_wire::PartKind::Summary &&
              decoded->header_.part_ == 0 && decoded->header_.parts_ == 2 &&
              decoded->header_.SameSample(ResourceHeader(2)),
          "summary header survives a round trip");
  Require(decoded->values_ == values, "summary values survive a round trip");
  Require(
      std::string_view{decoded->cgroup_.data()} == "/system.slice/app.service",
      "cgroup path survives a round trip");
  Require(
      values[resource_wire::Field("fd_open")] == resource_wire::kUnavailable ||
          values[resource_wire::Field("fd_open")] ==
              resource_wire::Field("fd_open") * 1000,
      "field names index the wire order");
  // A long cgroup path is cut, never left without its terminating NUL.
  const auto long_length = resource_wire::EncodeSummary(
      bytes, ResourceHeader(1), values, std::string(300, 'x'));
  const auto cut = resource_wire::Decode(std::span{bytes}.first(long_length));
  Require(cut && std::string_view{cut->cgroup_.data()}.size() ==
                     resource_wire::kCgroupSize - 1,
          "a long cgroup path is truncated");
}

void TestResourceSocketsRoundTrip()
{
  std::vector<resource_wire::Socket> sockets(8);
  for (std::size_t index = 0; index < sockets.size(); ++index)
  {
    auto& socket = sockets[index];
    socket.kind_ = index % 2 ? resource_wire::SocketKind::Tcp6
                             : resource_wire::SocketKind::UnixStream;
    socket.state_ = 1;
    socket.flags_ = 15;
    socket.fd_ = static_cast<std::uint32_t>(index + 3);
    socket.inode_ = std::numeric_limits<std::uint64_t>::max() - index;
    if (index % 2)
    {
      socket.local_address_.fill(0xab);
      socket.remote_address_.fill(0xcd);
    }
    else
    {
      resource_wire::Socket::UnixPathBytes path{};
      std::ranges::copy(std::string_view{"/run/app.sock"}, path.begin());
      socket.SetUnixPath(path);
    }
    socket.local_port_ = 443;
    socket.remote_port_ = 65535;
    socket.rx_queue_ = 1;
    socket.tx_queue_ = 2;
    socket.rmem_alloc_ = 3;
    socket.rcvbuf_ = 4;
    socket.wmem_alloc_ = 5;
    socket.wmem_queued_ = 6;
    socket.sndbuf_ = 7;
    socket.drops_ = 8;
    socket.rtt_us_ = 9;
    socket.rttvar_us_ = 10;
    socket.total_retrans_ = 11;
    socket.unacked_ = 12;
    socket.lost_ = 13;
    socket.notsent_bytes_ = 14;
    socket.peer_window_ = 15;
    socket.retransmits_ = 16;
    socket.probes_ = 17;
    socket.backoff_ = 18;
    socket.ca_state_ = 19;
    socket.last_data_recv_ms_ = 20;
    socket.last_data_sent_ms_ = 21;
    socket.busy_us_ = 22;
    socket.rwnd_limited_us_ = std::numeric_limits<std::uint64_t>::max();
    socket.sndbuf_limited_us_ = 24;
  }
  const auto parts = resource_wire::PartCount(sockets.size());
  Require(parts == 3, "eight sockets take two socket parts");
  std::vector<resource_wire::Socket> decoded;
  for (std::uint8_t part = 1; part < parts; ++part)
  {
    std::array<std::byte, resource_wire::kMaxPartSize> bytes{};
    const auto length = resource_wire::EncodeSockets(
        bytes, ResourceHeader(parts), sockets, part);
    const auto value = resource_wire::Decode(std::span{bytes}.first(length));
    Require(value.has_value(), "an encoded socket part decodes");
    Require(value->header_.part_ == part &&
                value->header_.kind_ == resource_wire::PartKind::Sockets,
            "socket part numbering");
    std::ranges::copy(value->Sockets(), std::back_inserter(decoded));
  }
  Require(decoded == sockets, "socket rows survive a round trip");
  Require(resource_wire::PartCount(0) == 1 &&
              resource_wire::PartCount(1000) == resource_wire::kMaxParts,
          "a sample has a summary part and at most kMaxSockets rows");
}

// Damages valid parts one way at a time and checks Decode refuses each.
void TestResourceRejectsOtherData()
{
  std::array<std::byte, resource_wire::kMaxPartSize> bytes{};
  const auto length = resource_wire::EncodeSummary(
      bytes, ResourceHeader(1), resource_wire::EmptySummary(), "/");
  const auto valid = std::span{bytes}.first(length);
  Require(resource_wire::Decode(valid).has_value(), "the base part is valid");
  const auto rejects =
      [&](std::size_t p_offset, std::byte p_value, std::string_view p_message)
  {
    auto copy = bytes;
    copy[p_offset] = p_value;
    Require(!resource_wire::Decode(std::span{copy}.first(length)), p_message);
  };
  rejects(0, std::byte{'X'}, "wrong magic is rejected");
  rejects(4, std::byte{2}, "wrong version is rejected");
  rejects(5, std::byte{9}, "unknown part kind is rejected");
  rejects(6, std::byte{1}, "a part number past the count is rejected");
  rejects(7, std::byte{0}, "a zero part count is rejected");
  rejects(7, std::byte{6}, "too many parts are rejected");
  rejects(22, std::byte{1}, "reserved header bytes must be zero");
  rejects(59, std::byte{0x80}, "unknown flags are rejected");
  rejects(41, std::byte{0}, "an interval under a second is rejected");
  auto no_pid = bytes;
  std::ranges::fill(std::span{no_pid}.subspan(44, 4), std::byte{0});
  Require(!resource_wire::Decode(std::span{no_pid}.first(length)),
          "pid zero is rejected");
  rejects(length - 1, std::byte{'x'}, "an unterminated cgroup is rejected");
  Require(!resource_wire::Decode(valid.first(length - 1)),
          "a short summary is rejected");
  Require(!wire::DecodeHeader(valid), "a resource part is not a thread tick");

  std::vector<resource_wire::Socket> sockets(1);
  sockets[0].kind_ = resource_wire::SocketKind::Tcp4;
  const auto socket_length =
      resource_wire::EncodeSockets(bytes, ResourceHeader(2), sockets, 1);
  Require(
      resource_wire::Decode(std::span{bytes}.first(socket_length)).has_value(),
      "the base socket part is valid");
  for (const auto& [offset, value] :
       {std::pair{std::size_t{64}, std::byte{0}},
        std::pair{std::size_t{64}, std::byte{8}},
        std::pair{std::size_t{66}, std::byte{16}},
        std::pair{std::size_t{64 + 124}, std::byte{1}}})
  {
    auto copy = bytes;
    copy[offset] = value;
    Require(!resource_wire::Decode(std::span{copy}.first(socket_length)),
            "an invalid socket row is rejected");
  }
}

memory_wire::Header MemoryHeader(std::uint8_t p_parts)
{
  return memory_wire::Header{.parts_ = p_parts,
                             .session_ = 7,
                             .sequence_ = 3,
                             .monotonic_ns_ = 1,
                             .wall_ns_ = 2,
                             .interval_ms_ = 30000,
                             .pid_ = 42,
                             .process_start_ = 9,
                             .flags_ = memory_wire::Flags::RegionsTruncated};
}

// Encodes a summary and two region parts (20 and 5 regions) and decodes
// them; then changes one byte at a time and checks that the decoder rejects
// it.
void TestMemoryRoundTrip()
{
  std::vector<memory_wire::Region> regions(25);
  for (std::size_t index = 0; index < regions.size(); ++index)
  {
    regions[index] =
        memory_wire::Region{.start_ = 0x1000 * (2 * index + 1),
                            .end_ = 0x1000 * (2 * index + 2),
                            .vma_count_ = static_cast<std::uint32_t>(index + 1),
                            .kind_ = memory_wire::RegionKind::File,
                            .permissions_ = 5,
                            .name_ = {'l', 'i', 'b'}};
  }
  const auto header = MemoryHeader(memory_wire::PartCount(regions.size()));
  Require(header.parts_ == 3, "two region parts");
  std::array<std::byte, memory_wire::kMaxPartSize> bytes{};
  auto values = memory_wire::EmptySummary();
  values[memory_wire::Field("vma_count")] = 77;
  const auto summary_length = memory_wire::EncodeSummary(bytes, header, values);
  const auto summary =
      memory_wire::Decode(std::span{bytes}.first(summary_length));
  Require(summary && summary->header_.kind_ == memory_wire::PartKind::Summary &&
              summary->header_.SameSample(header) && summary->values_ == values,
          "summary round trip");
  Require(!memory_wire::Decode(std::span{bytes}.first(summary_length - 1)),
          "a short summary is rejected");
  std::vector<memory_wire::Region> decoded;
  for (std::uint8_t part = 1; part < header.parts_; ++part)
  {
    const auto length =
        memory_wire::EncodeRegions(bytes, header, regions, part);
    const auto value = memory_wire::Decode(std::span{bytes}.first(length));
    Require(value && value->header_.part_ == part, "region part decodes");
    decoded.insert(decoded.end(), value->Regions().begin(),
                   value->Regions().end());
  }
  Require(decoded == regions, "regions round trip");

  const auto length = memory_wire::EncodeRegions(bytes, header, regions, 2);
  for (const auto& [offset, value] :
       {std::pair{std::size_t{0}, std::byte{'X'}},         // magic
        std::pair{std::size_t{4}, std::byte{2}},           // version
        std::pair{std::size_t{5}, std::byte{9}},           // kind
        std::pair{std::size_t{6}, std::byte{3}},           // part >= parts
        std::pair{std::size_t{22}, std::byte{1}},          // reserved
        std::pair{std::size_t{56}, std::byte{64}},         // unknown flag
        std::pair{std::size_t{64 + 20}, std::byte{9}},     // region kind
        std::pair{std::size_t{64 + 21}, std::byte{16}},    // permission
        std::pair{std::size_t{64 + 63}, std::byte{'x'}}})  // unterminated name
  {
    auto copy = bytes;
    copy[offset] = value;
    Require(!memory_wire::Decode(std::span{copy}.first(length)),
            "an invalid memory-map part is rejected");
  }
  auto empty = MemoryHeader(1);
  empty.pid_ = 0;
  const auto empty_length = memory_wire::EncodeSummary(bytes, empty, values);
  Require(!memory_wire::Decode(std::span{bytes}.first(empty_length)),
          "a sample without a PID is rejected");
}

}  // namespace

int main()
{
  try
  {
    TestRecordRoundTrip();
    TestHeaderRoundTrip();
    TestHeaderRejectsOtherData();
    TestResourceSummaryRoundTrip();
    TestResourceSocketsRoundTrip();
    TestResourceRejectsOtherData();
    TestMemoryRoundTrip();
    std::puts(
        "wire tests passed (thread, resource and memory-map round trips, "
        "rejection)");
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
