// Tests for common/wire.hpp, common/resource_wire.hpp, common/memory_wire.hpp
// and common/sha256.hpp alone: encoding then
// decoding gives back the same values, and the decoders reject data that is
// not their format.

#include "../common/wire.hpp"

#include <array>
#include <cstdint>
#include <cstdio>
#include <format>
#include <iterator>
#include <limits>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "../common/memory_wire.hpp"
#include "../common/resource_wire.hpp"
#include "../common/sha256.hpp"

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

}  // namespace

std::string Hex(std::span<const std::uint8_t> p_bytes)
{
  std::string text;
  for (const auto byte : p_bytes)
  {
    text += std::format("{:02x}", byte);
  }
  return text;
}

std::span<const std::uint8_t> Bytes(std::string_view p_text)
{
  return {reinterpret_cast<const std::uint8_t*>(p_text.data()), p_text.size()};
}

// SHA-256 against FIPS 180-4 examples (one block, two blocks, empty, and one
// million bytes fed in pieces), and HMAC-SHA256 against RFC 4231 test cases
// 1, 2 and 6 (a short key, a text key and a key longer than one block).
void TestSha256AndHmac()
{
  Require(
      Hex(Sha256Of(Bytes("abc"))) ==
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      "SHA-256 of abc");
  Require(
      Hex(Sha256Of(Bytes(""))) ==
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "SHA-256 of the empty message");
  Require(
      Hex(Sha256Of(
          Bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))) ==
          "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
      "SHA-256 of a two-block message");
  Sha256 million;
  const std::string chunk(1000, 'a');
  for (int index = 0; index < 1000; ++index)
  {
    million.Update(Bytes(chunk));
  }
  Require(
      Hex(million.Finish()) ==
          "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
      "SHA-256 of one million a");
  const std::vector<std::uint8_t> key1(20, 0x0b);
  Require(
      Hex(HmacSha256(key1, Bytes("Hi There"))) ==
          "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
      "RFC 4231 case 1");
  Require(
      Hex(HmacSha256(Bytes("Jefe"), Bytes("what do ya want for nothing?"))) ==
          "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
      "RFC 4231 case 2");
  const std::vector<std::uint8_t> key6(131, 0xaa);
  Require(
      Hex(HmacSha256(
          key6,
          Bytes("Test Using Larger Than Block-Size Key - Hash Key First"))) ==
          "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
      "RFC 4231 case 6");
  auto digest = Sha256Of(Bytes("abc"));
  Require(EqualDigests(digest, Sha256Of(Bytes("abc"))), "equal digests");
  digest[31] ^= 1;
  Require(!EqualDigests(digest, Sha256Of(Bytes("abc"))),
          "a digest that differs in the last byte");
}

memory_wire::Header MemoryHeader()
{
  return memory_wire::Header{.parts_ = 1,
                             .sequence_ = 7,
                             .session_ = 0x1122334455667788,
                             .monotonic_ns_ = 1,
                             .wall_ns_ = 2,
                             .pid_ = 42,
                             .interval_ms_ = 2000,
                             .process_start_ = 99,
                             .generation_ = 3};
}

// A cycle with a summary, two layout parts and two detail parts: each part
// decodes to the values that went in, and every part has the same header
// apart from its kind, number and count.
void TestMemoryRoundTrip()
{
  using namespace memory_wire;
  std::vector<Vma> vmas(kVmasPerPart + 2);
  for (std::size_t index = 0; index < vmas.size(); ++index)
  {
    auto& vma = vmas[index];
    vma.start_ = 0x10000 * (index + 1);
    vma.end_ = vma.start_ + 0x1000;
    vma.kind_ = VmaKind::File;
    vma.permissions_ = 5;
    vma.changes_ = std::to_underlying(Changes::New);
    vma.SetName(std::format("/usr/lib/library-{}.so", index));
  }
  vmas.back().SetName(std::string(60, 'x') + "/tail.so");
  Require(vmas.back().Name().ends_with("/tail.so") &&
              vmas.back().Name().size() == kNameSize &&
              vmas.back().flags_ == std::to_underlying(VmaFlags::NameTruncated),
          "a long name keeps its end");
  std::vector<Cell> cells(300, Cell{254, 0, 10});
  cells[299] = kUnmeasuredCell;
  auto header = MemoryHeader();
  header.layout_parts_ = static_cast<std::uint16_t>(LayoutParts(vmas.size()));
  header.parts_ = static_cast<std::uint16_t>(1 + header.layout_parts_ +
                                             DetailParts(cells.size()));
  header.flags_ = Flags::Truncated;
  Require(header.layout_parts_ == 2 && header.parts_ == 5, "part counts");
  std::array<std::byte, kMaxPartSize> buffer{};
  auto values = EmptySummary();
  values[Field("vma_count")] = 70000;
  auto length = EncodeSummary(buffer, header, values);
  auto summary = Decode(std::span{buffer}.first(length));
  Require(summary && summary->header_.kind_ == PartKind::Summary &&
              summary->values_ == values && summary->header_.SameCycle(header),
          "summary round trip");
  std::vector<Vma> decoded;
  for (std::size_t index = 0; index < header.layout_parts_; ++index)
  {
    length = EncodeVmas(buffer, header, vmas, index);
    const auto part = Decode(std::span{buffer}.first(length));
    Require(part.has_value(), "layout part decodes");
    Require(part->header_.part_ == 1 + index && part->header_.SameCycle(header),
            "layout part numbering");
    std::ranges::copy(part->Vmas(), std::back_inserter(decoded));
  }
  Require(decoded == vmas, "layout round trip");
  const Detail detail{.vma_start_ = 0x10000,
                      .vma_end_ = 0x20000,
                      .pages_per_cell_ = 1,
                      .measured_pages_ = 9,
                      .status_ = DetailStatus::Measuring};
  std::vector<Cell> decoded_cells;
  for (std::size_t index = 0; index < DetailParts(cells.size()); ++index)
  {
    length = EncodeDetail(buffer, header, detail, cells, index);
    const auto part = Decode(std::span{buffer}.first(length));
    Require(part && part->header_.part_ == 3 + index &&
                part->detail_.cell_count_ == 300 &&
                part->detail_.first_cell_ == index * kCellsPerPart &&
                part->detail_.measured_pages_ == 9,
            "detail part");
    std::ranges::copy(part->Cells(), std::back_inserter(decoded_cells));
  }
  Require(decoded_cells == cells, "cell round trip");
}

// The decoders reject other formats, bad numbering, invalid values and
// changed bytes; a request is accepted only with the right token.
void TestMemoryRejects()
{
  using namespace memory_wire;
  std::array<std::byte, kMaxPartSize> buffer{};
  auto length = EncodeSummary(buffer, MemoryHeader(), EmptySummary());
  Require(Decode(std::span{buffer}.first(length)).has_value(), "valid summary");
  Require(!Decode(std::span{buffer}.first(length - 1)), "short summary");
  auto copy = buffer;
  copy[0] = std::byte{'X'};
  Require(!Decode(std::span{copy}.first(length)), "other magic");
  auto header = MemoryHeader();
  header.part_ = 1;
  length = EncodeSummary(buffer, header, EmptySummary());
  Require(Decode(std::span{buffer}.first(length)).has_value(),
          "the encoder sets the summary part number");
  header = MemoryHeader();
  header.interval_ms_ = 0;
  length = EncodeSummary(buffer, header, EmptySummary());
  Require(!Decode(std::span{buffer}.first(length)), "invalid interval");
  header = MemoryHeader();
  header.layout_parts_ = 1;
  header.parts_ = 2;
  Vma vma{.start_ = 2, .end_ = 1, .kind_ = VmaKind::Heap};
  length = EncodeVmas(buffer, header, std::span{&vma, 1}, 0);
  Require(!Decode(std::span{buffer}.first(length)), "reversed VMA");
  vma.end_ = 3;
  vma.kind_ = static_cast<VmaKind>(9);
  length = EncodeVmas(buffer, header, std::span{&vma, 1}, 0);
  Require(!Decode(std::span{buffer}.first(length)), "unknown VMA kind");
  header.parts_ = 3;
  const std::array<Cell, 1> bad_cell{Cell{255, 0, 0}};
  length = EncodeDetail(
      buffer, header,
      Detail{.vma_start_ = 1, .vma_end_ = 2, .status_ = DetailStatus::Complete},
      bad_cell, 0);
  Require(!Decode(std::span{buffer}.first(length)), "half-unmeasured cell");

  const auto token = Bytes("0123456789abcdef0123456789abcdef");
  const auto request = Sign(Request{.action_ = Action::Watch,
                                    .tier_ = Tier::Detail,
                                    .lease_s_ = 15,
                                    .counter_ = 1234,
                                    .vma_start_ = 0x7f00},
                            token);
  const auto bytes = wire::AsBytes(request);
  const auto decoded = DecodeRequest(bytes, token);
  Require(decoded && decoded->vma_start_ == 0x7f00 &&
              decoded->tier_ == Tier::Detail && decoded->lease_s_ == 15,
          "request round trip");
  Require(!DecodeRequest(bytes, Bytes("another token of at least 32 bytes")),
          "wrong token");
  std::array<std::byte, kRequestSize> changed{};
  std::ranges::copy(bytes, changed.begin());
  changed[24] ^= std::byte{1};  // the VMA start
  Require(!DecodeRequest(changed, token), "a changed request");
  Require(!DecodeRequest(bytes.first(kRequestSize - 1), token),
          "short request");
  const auto unsigned_action = Sign(Request{.action_ = static_cast<Action>(3),
                                            .tier_ = Tier::Layout,
                                            .lease_s_ = 1,
                                            .counter_ = 1},
                                    token);
  Require(!DecodeRequest(wire::AsBytes(unsigned_action), token),
          "unknown action");
}

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
    TestSha256AndHmac();
    TestMemoryRoundTrip();
    TestMemoryRejects();
    std::puts(
        "wire tests passed (thread, resource and memory-map round trips, "
        "rejection, SHA-256 and HMAC)");
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
