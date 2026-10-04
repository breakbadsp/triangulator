// Unit tests for the C++ collector: datagram decoding, thread-state
// classification and the Monitor (tick reassembly, sessions, rollups, live
// snapshot, health). Datagrams are built in memory and fed straight to the
// Monitor, so no sockets or timers are involved.

#include <stdlib.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <exception>
#include <filesystem>
#include <format>
#include <limits>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "../collector/engine.hpp"

namespace
{

using namespace triangulator;
using namespace triangulator::collector;

void Require(bool p_condition, std::string_view p_message)
{
  if (!p_condition)
  {
    throw std::runtime_error(std::string{p_message});
  }
}

void RequireNear(double p_actual, double p_expected, std::string_view p_message)
{
  Require(
      std::fabs(p_actual - p_expected) < 1e-9,
      std::format("{}: got {}, expected {}", p_message, p_actual, p_expected));
}

const Json& Field(const Json& p_object, std::string_view p_key)
{
  const auto* value = p_object.Find(p_key);
  Require(value != nullptr, std::format("missing field {}", p_key));
  return *value;
}

// A sleeping worker thread waiting on a futex, with every counter at zero.
Record MakeRecord()
{
  Record record;
  record.tid_ = 42;
  record.state_ = 'S';
  record.timeslices_ = 10;
  record.comm_ = "worker-1";
  record.wchan_ = "futex_do_wait";
  return record;
}

// One complete tick of a 1 Hz sampler: tick N is taken N seconds after the
// start, by both clocks.
Packet MakePacket(std::uint32_t p_sequence, std::vector<Record> p_records)
{
  Packet packet;
  packet.chunks_ = 1;
  packet.session_ = 1;
  packet.sequence_ = p_sequence;
  packet.monotonic_ns_ = (1000 + std::uint64_t{p_sequence}) * 1'000'000'000;
  packet.wall_ns_ = (1'700'000'000 + std::uint64_t{p_sequence}) * 1'000'000'000;
  packet.interval_ms_ = 1000;
  packet.pid_ = 123;
  packet.records_ = std::move(p_records);
  return packet;
}

Packet MakePacket(std::uint32_t p_sequence)
{
  return MakePacket(p_sequence, {MakeRecord()});
}

// The datagram the sampler would send for p_packet, using the sampler's own
// encoder for the header.
std::vector<std::byte> Encode(const Packet& p_packet)
{
  std::vector<std::byte> data(kHeaderSize +
                              p_packet.records_.size() * kRecordSize);
  wire::EncodeHeader(
      std::span{data}.first<kHeaderSize>(),
      wire::Header{static_cast<wire::Flags>(p_packet.flags_), p_packet.chunk_,
                   p_packet.chunks_, p_packet.session_, p_packet.sequence_,
                   static_cast<std::uint16_t>(p_packet.records_.size()),
                   p_packet.monotonic_ns_, p_packet.wall_ns_,
                   p_packet.interval_ms_, p_packet.pid_});
  std::size_t offset = kHeaderSize;
  for (const auto& record : p_packet.records_)
  {
    const auto buffer = std::span{data}.subspan(offset, kRecordSize);
    wire::WriteLittleEndian(buffer.subspan<0, 4>(), record.tid_);
    buffer[4] = static_cast<std::byte>(record.state_);
    buffer[5] = static_cast<std::byte>(record.flags_);
    wire::WriteLittleEndian(buffer.subspan<6, 2>(), record.processor_);
    wire::WriteLittleEndian(buffer.subspan<8, 8>(), record.utime_);
    wire::WriteLittleEndian(buffer.subspan<16, 8>(), record.stime_);
    wire::WriteLittleEndian(buffer.subspan<24, 8>(), record.run_delay_);
    wire::WriteLittleEndian(buffer.subspan<32, 8>(), record.timeslices_);
    wire::WriteLittleEndian(buffer.subspan<40, 8>(), record.major_faults_);
    wire::WriteLittleEndian(buffer.subspan<48, 8>(), record.read_bytes_);
    wire::WriteLittleEndian(buffer.subspan<56, 8>(), record.write_bytes_);
    std::ranges::copy(std::as_bytes(std::span{record.comm_}),
                      buffer.subspan(64, 16).begin());
    std::ranges::copy(std::as_bytes(std::span{record.wchan_}),
                      buffer.subspan(80, 32).begin());
    offset += kRecordSize;
  }
  return data;
}

void TestDecodeRoundTrip()
{
  auto record = MakeRecord();
  record.comm_ = "name ) ( space";
  record.wchan_ = "";
  record.flags_ = kIoUnavailable;
  record.read_bytes_ = std::numeric_limits<std::uint64_t>::max();
  auto packet = MakePacket(123, {record});
  packet.session_ = std::numeric_limits<std::uint64_t>::max();
  const auto decoded = Decode(Encode(packet));
  Require(decoded.has_value(), "a valid datagram decodes");
  Require(decoded->session_ == packet.session_ && decoded->sequence_ == 123 &&
              decoded->monotonic_ns_ == packet.monotonic_ns_ &&
              decoded->wall_ns_ == packet.wall_ns_ &&
              decoded->interval_ms_ == 1000 && decoded->pid_ == 123,
          "header fields survive a round trip");
  Require(decoded->records_.size() == 1 &&
              DumpJson(RecordJson(decoded->records_[0])) ==
                  DumpJson(RecordJson(record)),
          "record fields survive a round trip");
}

void TestDecodeRejectsInvalidDatagrams()
{
  const auto valid = Encode(MakePacket(0));
  const std::vector<std::byte> truncated(valid.begin(), valid.end() - 1);
  auto extended = valid;
  extended.push_back(std::byte{'x'});
  auto no_chunks = MakePacket(0);
  no_chunks.chunks_ = 0;
  // An absent-target heartbeat must have no records and no pid.
  auto absent_with_records = MakePacket(0);
  absent_with_records.flags_ = kTargetAbsent;
  auto duplicate_tid = MakePacket(0, {MakeRecord(), MakeRecord()});
  auto zero_interval = MakePacket(0);
  zero_interval.interval_ms_ = 0;
  auto bad_record_flags = MakePacket(0);
  bad_record_flags.records_[0].flags_ = 2;
  auto too_many = MakePacket(0, {});
  for (std::uint32_t tid = 1; tid <= 11; ++tid)
  {
    too_many.records_.push_back(MakeRecord());
    too_many.records_.back().tid_ = tid;
  }
  const std::vector<std::pair<std::string_view, std::vector<std::byte>>> cases{
      {"empty", {}},
      {"truncated", truncated},
      {"extra byte", extended},
      {"zero chunks", Encode(no_chunks)},
      {"absent with records", Encode(absent_with_records)},
      {"duplicate tid", Encode(duplicate_tid)},
      {"zero interval", Encode(zero_interval)},
      {"unknown record flag", Encode(bad_record_flags)},
      {"11 records", Encode(too_many)}};
  for (const auto& [name, data] : cases)
  {
    Require(!Decode(data).has_value(),
            std::format("invalid datagram is rejected: {}", name));
  }
}

void TestClassification()
{
  const auto with = [](char p_state, std::string_view p_wchan)
  {
    auto record = MakeRecord();
    record.state_ = p_state;
    record.wchan_ = p_wchan;
    return record;
  };
  const std::vector<std::pair<Record, std::string_view>> cases{
      {with('D', "futex_do_wait"), "kernel"},
      {with('R', ""), "running"},
      {with('t', "futex_do_wait"), "stopped"},
      {with('S', "futex_do_wait"), "futex"},
      {with('S', "futex_wait_queue"), "futex"},
      {with('S', "do_epoll_wait"), "poll"},
      {with('S', "poll_schedule_timeout"), "poll"},
      {with('S', "__skb_wait_for_more_packets"), "socket"},
      {with('S', "unix_stream_read_generic"), "socket"},
      {with('S', "anon_pipe_read"), "pipe"},
      {with('S', "hrtimer_nanosleep"), "sleep"},
      {with('S', "do_wait"), "other"},
      {with('S', ""), "no_access"}};
  for (const auto& [record, expected] : cases)
  {
    Require(Classify(record) == expected,
            std::format("state {} wchan '{}' is {}, not {}", record.state_,
                        record.wchan_, expected, Classify(record)));
  }
}

// A fresh directory under /tmp, removed with its contents on destruction.
class TempDirectory
{
 public:
  TempDirectory()
  {
    std::string pattern =
        (std::filesystem::temp_directory_path() / "collector-test-XXXXXX")
            .string();
    Require(::mkdtemp(pattern.data()) != nullptr, "mkdtemp failed");
    path_ = pattern;
  }
  TempDirectory(const TempDirectory&) = delete;
  TempDirectory& operator=(const TempDirectory&) = delete;
  ~TempDirectory()
  {
    std::error_code error;
    std::filesystem::remove_all(path_, error);
  }

  [[nodiscard]] const std::filesystem::path& Path() const noexcept
  {
    return path_;
  }

 private:
  std::filesystem::path path_;
};

// A Monitor writing to a temporary directory, with one "worker" group. As in
// the real collector, the config is shared by reference, so tests may change
// it after construction.
struct MonitorFixture
{
  TempDirectory directory_;
  Config config_ = MakeConfig();
  Storage storage_{directory_.Path(), 7, false};
  Monitor monitor_{config_, storage_, 1'700'000'000};

  static Config MakeConfig()
  {
    Config config;
    config.max_live_samples_ = 10'000;
    config.groups_.push_back({"worker", "worker-"});
    return config;
  }

  // Delivers a tick as if it arrived at its own wall time and processes it
  // at once, without waiting for missing chunks.
  void Feed(const Packet& p_packet)
  {
    const double received = static_cast<double>(p_packet.wall_ns_) / 1e9;
    monitor_.Accept(p_packet, received);
    monitor_.Drain(received, true);
  }

  void Feed(std::uint32_t p_sequence, Record p_record)
  {
    Feed(MakePacket(p_sequence, {std::move(p_record)}));
  }

  [[nodiscard]] JsonArray Threads(double p_now) const
  {
    return Field(monitor_.Snapshot(p_now), "threads").AsArray();
  }

  [[nodiscard]] Json Thread(double p_now) const
  {
    const auto threads = Threads(p_now);
    Require(threads.size() == 1, "one live thread");
    return threads[0];
  }

  [[nodiscard]] JsonArray Rollups(std::int64_t p_tid = 42,
                                  std::string_view p_session = "1")
  {
    storage_.Flush(1'700'000'100);
    return History(directory_.Path(), p_session, p_tid, 1'700'000'000,
                   1'700'000'100);
  }
};

Record WithUtime(std::uint64_t p_utime)
{
  auto record = MakeRecord();
  record.utime_ = p_utime;
  return record;
}

void TestCounterResetAndSessionReset()
{
  MonitorFixture fixture;
  fixture.Feed(0, WithUtime(100));
  fixture.Feed(1, WithUtime(1));
  Require(Field(fixture.Thread(1'700'000'001), "generation").AsInt() == 1,
          "a counter going backwards means the tid is a new thread");
  auto next_session = MakePacket(2, {WithUtime(1000)});
  next_session.session_ = 2;
  fixture.Feed(next_session);
  Require(Field(fixture.Thread(1'700'000'002), "generation").AsInt() == 0,
          "a new session starts every thread over");
  auto old_session = MakePacket(3);
  fixture.monitor_.Accept(old_session, 1'700'000'003);
  const auto health = fixture.monitor_.Health(1'700'000'003);
  Require(Field(health, "session").AsString() == "2",
          "a late datagram from the old session does not switch back");
  Require(Field(health, "late_packets").AsInt() == 1, "it is counted as late");
}

void TestReorderedChunksDuplicatesPartialTicksAndLoss()
{
  MonitorFixture fixture;
  auto& monitor = fixture.monitor_;
  const auto chunk =
      [](std::uint32_t p_sequence, std::uint8_t p_chunk, std::uint32_t p_tid)
  {
    auto record = MakeRecord();
    record.tid_ = p_tid;
    auto packet = MakePacket(p_sequence, {record});
    packet.chunk_ = p_chunk;
    packet.chunks_ = 2;
    return packet;
  };
  monitor.Accept(chunk(1, 1, 43), 1'700'000'001);
  monitor.Accept(MakePacket(0), 1'700'000'001.1);
  monitor.Accept(chunk(1, 0, 42), 1'700'000'001.2);
  monitor.Accept(chunk(1, 0, 42), 1'700'000'001.3);
  monitor.Drain(1'700'000'005);
  Require(fixture.Threads(1'700'000'005).size() == 2,
          "chunks arriving out of order are joined");
  Require(Field(monitor.Health(1'700'000'005), "duplicates").AsInt() == 1,
          "a repeated chunk is counted once as a duplicate");
  monitor.Accept(chunk(2, 0, 42), 1'700'000'006);
  monitor.Drain(1'700'000'009);
  Require(fixture.Threads(1'700'000'009).size() == 2,
          "a missing chunk does not mean its threads exited");
  Require(
      Field(monitor.Health(1'700'000'009), "packet_loss_pct").AsNumber() > 0,
      "a missing chunk counts as packet loss");
  monitor.Accept(chunk(2, 1, 43), 1'700'000'010);
  Require(Field(monitor.Health(1'700'000'010), "late_packets").AsInt() == 1,
          "a chunk for an already processed tick is late");
}

void TestHealthAbsenceAccessAndSilence()
{
  MonitorFixture fixture;
  auto absent = MakePacket(0, {});
  absent.flags_ = kTargetAbsent;
  absent.pid_ = 0;
  fixture.Feed(absent);
  auto health = fixture.monitor_.Health(1'700'000'005);
  Require(Field(health, "target_absent").AsBool(), "target reported absent");
  Require(!Field(health, "sampler_silent").AsBool(), "sampler still heard");
  Require(
      Field(fixture.monitor_.Health(1'700'000'011), "sampler_silent").AsBool(),
      "no datagram for ten seconds means the sampler is silent");
  auto hidden = MakeRecord();
  hidden.wchan_ = "";
  fixture.Feed(12, hidden);
  health = fixture.monitor_.Health(1'700'000'012);
  Require(!Field(health, "sampler_silent").AsBool() &&
              !Field(health, "target_absent").AsBool(),
          "a fresh tick clears silence and absence");
  Require(
      Field(fixture.Thread(1'700'000'012), "state").AsString() == "no_access",
      "an empty wait channel shows as no_access");
}

void TestRollupsRetentionAndBoundedMemory()
{
  MonitorFixture fixture;
  fixture.config_.max_live_samples_ = 5;
  for (std::uint32_t sequence = 0; sequence <= 10; ++sequence)
  {
    fixture.Feed(MakePacket(sequence));
  }
  Require(
      Field(fixture.monitor_.Health(1'700'000'010), "raw_samples").AsInt() <= 5,
      "live samples are capped by max_live_samples");
  const auto rows = fixture.Rollups();
  Require(rows.size() == 2, "two finished 5-second windows are stored");
  Require(DumpJson(Field(rows[0], "sample_counts")) == R"({"futex":5})",
          "a rollup counts samples per state");
  Require(Field(rows[0], "group_name").AsString() == "worker",
          "threads are grouped by name prefix");
  fixture.storage_.Flush(1'700'000'000 + 10 * 86400);
  Require(DayFiles(fixture.directory_.Path()).empty(),
          "day files past the retention period are deleted");
}

void TestIoFaultAndSwitchRates()
{
  MonitorFixture fixture;
  for (std::uint32_t sequence = 0; sequence <= 10; ++sequence)
  {
    auto record = MakeRecord();
    record.wchan_ = "do_epoll_wait";
    record.read_bytes_ = sequence * 4096;
    record.write_bytes_ = sequence * 100;
    record.major_faults_ = sequence;
    record.timeslices_ = sequence * 3;
    fixture.Feed(sequence, record);
  }
  const auto live = fixture.Thread(1'700'000'010);
  Require(Field(live, "wchan").AsString() == "do_epoll_wait", "live wchan");
  RequireNear(Field(live, "read_bps").AsNumber(), 4096, "live read rate");
  RequireNear(Field(live, "write_bps").AsNumber(), 100, "live write rate");
  RequireNear(Field(live, "switches_per_s").AsNumber(), 3,
              "live context switch rate");
  RequireNear(Field(live, "major_faults_per_s").AsNumber(), 1,
              "live major fault rate");
  const auto rows = fixture.Rollups();
  Require(rows.size() == 2, "two finished windows");
  const auto& row = rows[1];
  RequireNear(Field(row, "read_bps").AsNumber(), 4096, "rollup read rate");
  RequireNear(Field(row, "write_bps").AsNumber(), 100, "rollup write rate");
  Require(Field(row, "major_faults_delta").AsInt() == 5, "rollup major faults");
  Require(Field(row, "timeslices_delta").AsInt() == 15,
          "rollup context switches");
  Require(DumpJson(Field(row, "sample_counts")) == R"({"poll":5})",
          "epoll waits count as poll");
  // Without readable io files there is no I/O rate at all, rather than zero.
  for (std::uint32_t sequence = 11; sequence <= 12; ++sequence)
  {
    auto record = MakeRecord();
    record.flags_ = kIoUnavailable;
    auto packet = MakePacket(sequence, {record});
    packet.session_ = 2;
    fixture.Feed(packet);
  }
  Require(Field(fixture.Thread(1'700'000'012), "read_bps").IsNull(),
          "unreadable io gives no read rate");
}

void TestUnreadableIoSampleDoesNotResetThread()
{
  MonitorFixture fixture;
  const auto with_io = [](std::uint64_t p_read, std::uint64_t p_write)
  {
    auto record = MakeRecord();
    record.read_bytes_ = p_read;
    record.write_bytes_ = p_write;
    return record;
  };
  for (std::uint32_t sequence = 0; sequence < 3; ++sequence)
  {
    fixture.Feed(sequence, with_io(5000, 5000));
  }
  auto unreadable = MakeRecord();
  unreadable.flags_ = kIoUnavailable;
  fixture.Feed(3, unreadable);
  auto live = fixture.Thread(1'700'000'003);
  Require(Field(live, "generation").AsInt() == 0,
          "io counters reading zero because io is unreadable is not tid reuse");
  Require(Field(live, "read_bps").IsNull(), "and does not fake traffic");
  for (std::uint32_t sequence = 4; sequence <= 10; ++sequence)
  {
    fixture.Feed(sequence, with_io(5000 + (sequence - 3) * 100, 5000));
  }
  live = fixture.Thread(1'700'000'010);
  Require(Field(live, "generation").AsInt() == 0, "still the same thread");
  // 700 bytes over the 10 s since sample 0.
  RequireNear(Field(live, "read_bps").AsNumber(), 70, "live read rate");
  RequireNear(Field(fixture.Rollups()[1], "read_bps").AsNumber(), 100,
              "rollup read rate");
  fixture.Feed(11, with_io(0, 0));
  Require(Field(fixture.Thread(1'700'000'011), "generation").AsInt() == 1,
          "a real counter drop is still tid reuse");
}

void TestExistingDayFileGainsNewRollupColumns()
{
  MonitorFixture fixture;
  {
    // thread_rollup as it was before read_bps, write_bps and
    // major_faults_delta were added.
    auto old =
        OpenDatabase(fixture.directory_.Path() / "2023-11-14.sqlite3", false);
    Execute(old.get(),
            "CREATE TABLE thread_rollup (ts REAL NOT NULL, session TEXT NOT "
            "NULL, tid INTEGER NOT NULL, name TEXT NOT NULL, group_name TEXT "
            "NOT NULL, cpu_pct REAL, run_delay_pct REAL, sample_counts TEXT "
            "NOT NULL, timeslices_delta INTEGER, samples INTEGER NOT NULL, "
            "expected_samples REAL NOT NULL, valid INTEGER NOT NULL, "
            "generation INTEGER NOT NULL, PRIMARY KEY(ts, session, tid, "
            "generation))");
  }
  for (std::uint32_t sequence = 0; sequence <= 10; ++sequence)
  {
    fixture.Feed(MakePacket(sequence));
  }
  const auto rows = fixture.Rollups();
  Require(!rows.empty(), "rows are written to the old day file");
  RequireNear(Field(rows[0], "read_bps").AsNumber(), 0,
              "the old file gained the read_bps column");
}

void TestLowestRateProducesValidWindows()
{
  MonitorFixture fixture;
  // 0.2 Hz: one sample per 5-second window, each a busy thread.
  for (std::uint32_t sequence = 0; sequence < 5; ++sequence)
  {
    auto record = WithUtime(sequence * 500);
    record.state_ = 'R';
    auto packet = MakePacket(sequence, {record});
    packet.interval_ms_ = 5000;
    packet.monotonic_ns_ = (1000 + std::uint64_t{sequence} * 5) * 1'000'000'000;
    packet.wall_ns_ =
        (1'700'000'000 + std::uint64_t{sequence} * 5) * 1'000'000'000;
    fixture.Feed(packet);
  }
  const auto rows = fixture.Rollups();
  Require(rows.size() == 4, "one rollup per finished window");
  Require(Field(rows[0], "valid").AsInt() == 0,
          "the first window has no earlier sample to measure from");
  for (std::size_t index = 1; index < rows.size(); ++index)
  {
    Require(Field(rows[index], "valid").AsInt() == 1,
            "later windows measure from the previous window's last sample");
    RequireNear(Field(rows[index], "cpu_pct").AsNumber(), 100,
                "rollup CPU at the lowest rate");
  }
}

void TestFallbackHasNoRunDelay()
{
  MonitorFixture fixture;
  for (std::uint32_t sequence = 0; sequence <= 10; ++sequence)
  {
    auto record = MakeRecord();
    record.state_ = 'R';
    record.run_delay_ = sequence;
    auto packet = MakePacket(sequence, {record});
    packet.flags_ = kStatusFallback;
    fixture.Feed(packet);
  }
  Require(Field(fixture.Thread(1'700'000'010), "run_delay_pct").IsNull(),
          "fallback mode has no live run delay");
  const auto rows = fixture.Rollups();
  Require(rows.size() == 2 && Field(rows[1], "valid").AsInt() == 1,
          "fallback windows are still valid");
  Require(Field(rows[1], "run_delay_pct").IsNull(),
          "fallback mode has no rollup run delay");
}

void TestSequenceWrapIsNotPacketLoss()
{
  MonitorFixture fixture;
  auto last = MakePacket(std::numeric_limits<std::uint32_t>::max());
  last.monotonic_ns_ = 1000ULL * 1'000'000'000;
  last.wall_ns_ = 1'700'000'000ULL * 1'000'000'000;
  auto first = MakePacket(0);
  first.monotonic_ns_ = 1001ULL * 1'000'000'000;
  first.wall_ns_ = 1'700'000'001ULL * 1'000'000'000;
  fixture.Feed(last);
  fixture.Feed(first);
  RequireNear(Field(fixture.monitor_.Health(1'700'000'001), "packet_loss_pct")
                  .AsNumber(),
              0, "the sequence number wrapping to 0 is not loss");
}

}  // namespace

int main()
{
  try
  {
    TestDecodeRoundTrip();
    TestDecodeRejectsInvalidDatagrams();
    TestClassification();
    TestCounterResetAndSessionReset();
    TestReorderedChunksDuplicatesPartialTicksAndLoss();
    TestHealthAbsenceAccessAndSilence();
    TestRollupsRetentionAndBoundedMemory();
    TestIoFaultAndSwitchRates();
    TestUnreadableIoSampleDoesNotResetThread();
    TestExistingDayFileGainsNewRollupColumns();
    TestLowestRateProducesValidWindows();
    TestFallbackHasNoRunDelay();
    TestSequenceWrapIsNotPacketLoss();
    std::puts(
        "C++ collector tests passed (decoding, classification, ticks, "
        "sessions, rollups, storage, health)");
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
