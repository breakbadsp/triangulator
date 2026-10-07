// Unit tests for the C++ collector: datagram decoding, thread-state
// classification and the Monitor (tick reassembly, sessions, rollups, live
// snapshot, health). Datagrams are built in memory and fed straight to the
// Monitor, so no sockets or timers are involved.

#include <stdlib.h>
#include <sys/stat.h>

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <exception>
#include <filesystem>
#include <format>
#include <fstream>
#include <limits>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "../collector/config.hpp"
#include "../collector/engine.hpp"
#include "../collector/memory_map.hpp"
#include "../collector/replay.hpp"
#include "../collector/resources.hpp"

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
  Require(p_records.size() <= kRecordsPerPacket, "a datagram has few records");
  std::ranges::copy(p_records, packet.records_.begin());
  packet.count_ = p_records.size();
  return packet;
}

Packet MakePacket(std::uint32_t p_sequence)
{
  return MakePacket(p_sequence, {MakeRecord()});
}

// The datagram the sampler would send for p_packet, made of the shared wire
// structs. It can hold more than kRecordsPerPacket records, to test that
// the collector rejects them.
std::vector<std::byte> Encode(const Packet& p_packet,
                              std::span<const Record> p_records)
{
  const auto append = [](std::vector<std::byte>& p_data, const auto& p_value)
  {
    const auto bytes = wire::AsBytes(p_value);
    p_data.insert(p_data.end(), bytes.begin(), bytes.end());
  };
  std::vector<std::byte> data;
  append(data,
         wire::Header{.flags_ = static_cast<wire::Flags>(p_packet.flags_),
                      .chunk_ = p_packet.chunk_,
                      .chunks_ = p_packet.chunks_,
                      .session_ = p_packet.session_,
                      .sequence_ = p_packet.sequence_,
                      .records_ = static_cast<std::uint16_t>(p_records.size()),
                      .monotonic_ns_ = p_packet.monotonic_ns_,
                      .wall_ns_ = p_packet.wall_ns_,
                      .interval_ms_ = p_packet.interval_ms_,
                      .pid_ = p_packet.pid_});
  for (const auto& record : p_records)
  {
    wire::Record wire_record{
        .tid_ = record.tid_,
        .state_ = record.state_,
        .flags_ = static_cast<wire::RecordFlags>(record.flags_),
        .processor_ = record.processor_,
        .utime_ = record.utime_,
        .stime_ = record.stime_,
        .run_delay_ = record.run_delay_,
        .timeslices_ = record.timeslices_,
        .major_faults_ = record.major_faults_,
        .read_bytes_ = record.read_bytes_,
        .write_bytes_ = record.write_bytes_};
    std::ranges::copy(record.comm_.View(), wire_record.comm_.begin());
    std::ranges::copy(record.wchan_.View(), wire_record.wchan_.begin());
    append(data, wire_record);
  }
  return data;
}

std::vector<std::byte> Encode(const Packet& p_packet)
{
  return Encode(p_packet, p_packet.Records());
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
  RecordJsonText decoded_text;
  RecordJsonText record_text;
  AppendRecordJson(decoded_text, decoded->records_[0]);
  AppendRecordJson(record_text, record);
  Require(decoded->count_ == 1 && decoded_text == record_text,
          "record fields survive a round trip");
}

void TestDecodeRejectsInvalidDatagrams()
{
  const auto valid = Encode(MakePacket(0));
  const std::vector<std::byte> truncated(valid.begin(), valid.end() - 1);
  auto extended = valid;
  extended.push_back(std::byte{'x'});
  // Header bytes 22 and 23 are reserved_ and must be zero.
  auto reserved = valid;
  reserved[22] = std::byte{1};
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
  std::vector<Record> too_many;
  for (std::uint32_t tid = 1; tid <= 11; ++tid)
  {
    too_many.push_back(MakeRecord());
    too_many.back().tid_ = tid;
  }
  auto huge_tid = MakePacket(0);
  huge_tid.records_[0].tid_ = kMaxTid + 1;
  const std::vector<std::pair<std::string_view, std::vector<std::byte>>> cases{
      {"empty", {}},
      {"truncated", truncated},
      {"extra byte", extended},
      {"reserved header byte", reserved},
      {"zero chunks", Encode(no_chunks)},
      {"absent with records", Encode(absent_with_records)},
      {"duplicate tid", Encode(duplicate_tid)},
      {"zero interval", Encode(zero_interval)},
      {"unknown record flag", Encode(bad_record_flags)},
      {"11 records", Encode(MakePacket(0, {}), too_many)},
      {"thread id above the Linux limit", Encode(huge_tid)}};
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
                        record.wchan_.View(), expected, Classify(record)));
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

// A RowSink that keeps the resource rows it receives.
struct RowCollector final : RowSink
{
  std::vector<ResourceRow> resource_;

  void Rollup(const RollupRow&) override
  {
  }
  void Raw(const RawRow&) override
  {
  }
  void Resource(const ResourceRow& p_row) override
  {
    resource_.push_back(p_row);
  }
};

// A Monitor whose rows go to a temporary directory, with one "worker" group.
// As in the real collector, the config is shared by reference, so tests may
// change it after construction.
struct MonitorFixture
{
  TempDirectory directory_;
  Config config_ = MakeConfig();
  Storage storage_ = MakeStorage(directory_.Path());
  StorageSink sink_{storage_};
  Monitor monitor_{config_, 1'700'000'000, sink_};

  static Storage MakeStorage(const std::filesystem::path& p_directory)
  {
    auto storage = Storage::Create(p_directory, 7);
    Require(storage.has_value(), "storage opens the data directory");
    return std::move(*storage);
  }

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
    WriteRows();
  }

  // Checks that every row the monitor produced so far was written.
  void WriteRows()
  {
    Require(sink_.Status().has_value(), "rows are written");
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
    WriteRows();
    Require(storage_.Flush(1'700'000'100).has_value(), "rows are committed");
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
  Require(fixture.storage_.Flush(1'700'000'000 + 10 * 86400).has_value(),
          "a flush on a later day succeeds");
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
    Require(old.has_value(), "the old day file opens");
    const auto created = Execute(
        old->get(),
        "CREATE TABLE thread_rollup (ts REAL NOT NULL, session TEXT NOT "
        "NULL, tid INTEGER NOT NULL, name TEXT NOT NULL, group_name TEXT "
        "NOT NULL, cpu_pct REAL, run_delay_pct REAL, sample_counts TEXT "
        "NOT NULL, timeslices_delta INTEGER, samples INTEGER NOT NULL, "
        "expected_samples REAL NOT NULL, valid INTEGER NOT NULL, "
        "generation INTEGER NOT NULL, PRIMARY KEY(ts, session, tid, "
        "generation))");
    Require(created.has_value(), "the old table is created");
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

// Parses the stored view a replay query returned.
Json ReplaySnapshot(const ReplayResult& p_result)
{
  Require(p_result.snapshot_.has_value(), "a recording is found");
  auto snapshot = ParseJson(*p_result.snapshot_);
  Require(snapshot.has_value(), "the stored view is JSON");
  return std::move(*snapshot);
}

// Replay preserves complete views across midnight and sampler sessions, uses
// strict stepping, and reports missing history rather than inventing a state.
void TestReplaySnapshots()
{
  TempDirectory directory;
  auto writer = ReplayWriter::Create(ReplayDirectory(directory.Path()), 7);
  Require(writer.has_value(), "the replay directory is created");
  constexpr double kMidnight = 1'700'006'400;
  const auto save = [&](double p_timestamp, std::string_view p_session,
                        std::string_view p_state)
  {
    Json snapshot =
        JsonObject{{"recorded_at", p_timestamp},
                   {"health", JsonObject{{"session", p_session}, {"pid", 42}}},
                   {"threads", JsonArray{JsonObject{{"tid", 42},
                                                    {"generation", 1},
                                                    {"state", p_state},
                                                    {"wchan", "futex_wait"},
                                                    {"cpu", 3},
                                                    {"cpu_pct", 25.0}}}}};
    Require(writer->Write(p_timestamp, DumpJson(snapshot)).has_value(),
            "complete snapshot is stored");
  };
  save(kMidnight - 1, "18446744073709551615", "futex");
  save(kMidnight + 1, "2", "running");
  save(kMidnight + 3, "2", "sleep");
  const auto bounds = Replay(directory.Path(), {});
  Require(bounds.first_ && bounds.last_ && !bounds.snapshot_,
          "bounds load without a snapshot");
  RequireNear(*bounds.first_, kMidnight - 1, "bounds include yesterday");
  RequireNear(*bounds.last_, kMidnight + 3, "bounds include today");
  const auto exact = ReplaySnapshot(Replay(directory.Path(), {kMidnight + 1}));
  Require(Field(Field(exact, "health"), "session").AsString() == "2",
          "process session comes from the recording");
  Require(Field(Field(exact, "threads").AsArray()[0], "state").AsString() ==
              "running",
          "recorded thread state is preserved");
  const auto between = ReplaySnapshot(Replay(directory.Path(), {kMidnight}));
  Require(Field(Field(between, "health"), "session").AsString() ==
              "18446744073709551615",
          "previous frame retains an old session without numeric rounding");
  RequireNear(Field(ReplaySnapshot(
                        Replay(directory.Path(), {kMidnight + 1, "previous"})),
                    "recorded_at")
                  .AsNumber(),
              kMidnight - 1, "previous crosses UTC midnight");
  RequireNear(
      Field(ReplaySnapshot(Replay(directory.Path(), {kMidnight - 1, "next"})),
            "recorded_at")
          .AsNumber(),
      kMidnight + 1, "next excludes the current frame");
  for (const ReplayQuery query :
       {ReplayQuery{kMidnight - 2, "at"}, ReplayQuery{kMidnight + 3, "next"}})
  {
    Require(!Replay(directory.Path(), query).snapshot_,
            "missing recordings stay missing");
  }
  // A new day prunes recordings older than the retention period.
  save(kMidnight + 8 * 86400, "3", "sleep");
  Require(*Replay(directory.Path(), {}).first_ == kMidnight + 8 * 86400,
          "day retention deletes old recordings");
}

// A damaged or half-created replay file is skipped: the others still answer.
void TestReplaySkipsUnreadableFiles()
{
  TempDirectory directory;
  auto writer = ReplayWriter::Create(ReplayDirectory(directory.Path()), 7);
  Require(writer.has_value(), "the replay directory is created");
  constexpr double kDay = 1'700'006'400;  // 2023-11-15 UTC
  Require(writer->Write(kDay + 10, R"({"recorded_at":1})").has_value() &&
              writer->Write(kDay + 86400 + 10, R"({"recorded_at":2})"),
          "two days are recorded");
  {
    std::ofstream garbage{ReplayDirectory(directory.Path()) /
                          "2023-11-14.sqlite3"};
    for (int line = 0; line < 100; ++line)
    {
      garbage << "not a database";
    }
  }
  auto empty = OpenDatabase(
      ReplayDirectory(directory.Path()) / "2023-11-17.sqlite3", false);
  Require(empty.has_value(), "a file without the table is created");
  const auto bounds = Replay(directory.Path(), {});
  Require(bounds.first_ && *bounds.first_ == kDay + 10,
          "the oldest readable file gives the first bound");
  Require(bounds.last_ && *bounds.last_ == kDay + 86400 + 10,
          "the newest readable file gives the last bound");
  Require(Replay(directory.Path(), {kDay + 3 * 86400}).snapshot_ ==
              R"({"recorded_at":2})",
          "the search continues past an unreadable day");
  Require(Replay(directory.Path(), {kDay - 86400, "next"}).snapshot_ ==
              R"({"recorded_at":1})",
          "next skips the damaged older file");
}

// The recorder writes on its own thread; failures are logged, not fatal,
// and a disabled recorder writes nothing.
void TestSnapshotRecorder()
{
  TempDirectory directory;
  const auto view =
      std::make_shared<const std::string>(R"({"recorded_at":1700006410})");
  {
    SnapshotRecorder disabled{directory.Path(), 7, 0};
    Require(disabled.Start().has_value(), "a disabled recorder starts");
    disabled.Offer(1'700'006'410, view);
  }
  Require(!std::filesystem::exists(ReplayDirectory(directory.Path())),
          "a disabled recorder creates nothing");
  const auto blocker = directory.Path() / "file";
  std::ofstream{blocker} << "";
  {
    SnapshotRecorder failing{blocker / "data", 7, 1};
    Require(failing.Start().has_value(), "the recorder starts");
    failing.Offer(1'700'006'410, view);
    failing.Stop();
  }
  SnapshotRecorder recorder{directory.Path(), 7, 60};
  Require(recorder.Start().has_value(), "the recorder starts");
  recorder.Offer(1'700'006'410, view);
  recorder.Offer(1'700'006'411, view);
  recorder.Stop();
  const auto bounds = Replay(directory.Path(), {});
  Require(bounds.first_ && *bounds.first_ == 1'700'006'410 &&
              *bounds.last_ == 1'700'006'410,
          "stopping writes the waiting view, one per interval");
}

// Invalid recording intervals, and a max_live_samples above the limit, fail
// configuration validation before startup.
void TestReplayConfig()
{
  for (const std::string_view text :
       {"replay_interval_s=0", "replay_interval_s=0.5", "replay_interval_s=1",
        "replay_interval_s=60"})
  {
    Require(ParseConfig(text).has_value(), "supported recording cadence");
  }
  for (const std::string_view text :
       {"replay_interval_s=-1", "replay_interval_s=0.1", "replay_interval_s=61",
        "replay_interval_s=true", "replay_interval_s=nan"})
  {
    Require(!ParseConfig(text), "invalid recording cadence is rejected");
  }
  Require(ParseConfig("max_live_samples=10000000").has_value() &&
              !ParseConfig("max_live_samples=10000001"),
          "max_live_samples has an upper limit");
}

// Storage failures come back as values, not exceptions: a data directory
// that can't be created, a day file that isn't a database, and History
// skipping a file it can't read.
void TestStorageReportsErrors()
{
  TempDirectory directory;
  const auto blocker = directory.Path() / "file";
  std::ofstream{blocker} << "";
  const auto unusable = Storage::Create(blocker / "data", 7);
  Require(!unusable.has_value(), "a data_dir under a regular file fails");
  Require(unusable.error().starts_with("cannot create"),
          "the error names the failed step");

  {
    std::ofstream garbage{directory.Path() / "2023-11-14.sqlite3"};
    for (int line = 0; line < 100; ++line)
    {
      garbage << "not a database";
    }
  }
  auto storage = Storage::Create(directory.Path(), 7);
  Require(storage.has_value(), "storage opens the data directory");
  RollupRow row;
  row.ts_ = 1'700'000'000;  // 2023-11-14 UTC
  row.session_ = "1";
  row.tid_ = 42;
  const auto written = storage->Rollup(row);
  Require(!written.has_value(), "writing to a damaged day file fails");
  Require(written.error() == "file is not a database",
          std::format("the SQLite message is kept, got: {}", written.error()));
  Require(
      History(directory.Path(), "1", 42, 1'700'000'000, 1'700'000'100).empty(),
      "History skips a day file it can't read");
}

// ---------- Resource samples ----------

// A resource sample header taken p_sequence * 5 s after the start.
resource_wire::Header ResourceHeader(std::uint32_t p_sequence,
                                     std::uint8_t p_parts = 1,
                                     std::uint64_t p_session = 1)
{
  return resource_wire::Header{
      .parts_ = p_parts,
      .session_ = p_session,
      .sequence_ = p_sequence,
      .monotonic_ns_ = (1000 + std::uint64_t{p_sequence} * 5) * 1'000'000'000,
      .wall_ns_ =
          (1'700'000'000 + std::uint64_t{p_sequence} * 5) * 1'000'000'000,
      .interval_ms_ = 5000,
      .pid_ = 123,
      .process_start_ = 77};
}

// Encodes and decodes, as the collector receives them.
resource_wire::Part Summary(const resource_wire::Header& p_header,
                            const resource_wire::SummaryValues& p_values)
{
  std::array<std::byte, resource_wire::kMaxPartSize> bytes{};
  const auto length =
      resource_wire::EncodeSummary(bytes, p_header, p_values, "/app.slice");
  auto part = resource_wire::Decode(std::span{bytes}.first(length));
  Require(part.has_value(), "a test summary decodes");
  return std::move(*part);
}

resource_wire::Part Sockets(const resource_wire::Header& p_header,
                            std::span<const resource_wire::Socket> p_sockets,
                            std::uint8_t p_part = 1)
{
  std::array<std::byte, resource_wire::kMaxPartSize> bytes{};
  const auto length =
      resource_wire::EncodeSockets(bytes, p_header, p_sockets, p_part);
  auto part = resource_wire::Decode(std::span{bytes}.first(length));
  Require(part.has_value(), "a test socket part decodes");
  return std::move(*part);
}

// Summary values that grow with p_sequence: every PSI total by 1 s of stall
// per 5 s sample (20%), storage reads by 5,000 bytes per sample, listen
// overflows by 3.
resource_wire::SummaryValues GrowingValues(std::uint64_t p_sequence)
{
  auto values = resource_wire::EmptySummary();
  for (std::size_t field = resource_wire::Field("host_cpu_some_total");
       field <= resource_wire::Field("cgroup_io_full_total"); field += 2)
  {
    values[field] = 5'000'000 + p_sequence * 1'000'000;
    values[field - 1] = 2000;  // avg10 20.00%
  }
  values[resource_wire::Field("io_read_bytes")] = p_sequence * 5000;
  values[resource_wire::Field("io_write_bytes")] = 0;
  values[resource_wire::Field("net_listen_overflows")] = 10 + p_sequence * 3;
  values[resource_wire::Field("fd_open")] = 900;
  values[resource_wire::Field("fd_soft_limit")] = 1024;
  values[resource_wire::Field("tcp_sockets")] = 2;
  return values;
}

resource_wire::Socket TcpSocket(std::uint64_t p_inode, std::uint32_t p_used)
{
  resource_wire::Socket socket;
  socket.kind_ = resource_wire::SocketKind::Tcp6;
  socket.state_ = 1;
  socket.flags_ = 15;
  socket.fd_ = 7;
  socket.inode_ = p_inode;
  // ::ffff:10.0.0.5, an IPv4 client on a dual-stack socket.
  socket.remote_address_ = {0, 0, 0,    0,    0,  0, 0, 0,
                            0, 0, 0xff, 0xff, 10, 0, 0, 5};
  socket.local_address_[15] = 1;  // ::1
  socket.local_port_ = 8080;
  socket.remote_port_ = 40000;
  socket.rx_queue_ = p_used;
  socket.rcvbuf_ = 1000;
  socket.rmem_alloc_ = p_used;
  socket.sndbuf_ = 1000;
  return socket;
}

const Json& ResourceField(const Json& p_live, std::string_view p_path)
{
  const Json* value = &p_live;
  while (!p_path.empty())
  {
    const auto dot = p_path.find('.');
    value = &Field(*value, p_path.substr(0, dot));
    p_path = dot == std::string_view::npos ? std::string_view{}
                                           : p_path.substr(dot + 1);
  }
  return *value;
}

void TestResourceRatesAndSockets()
{
  RowCollector sink;
  ResourceMonitor monitor{sink};
  Require(!Field(monitor.Snapshot(0), "available").AsBool(), "no sample yet");
  auto first = TcpSocket(5, 100);
  first.rwnd_limited_us_ = 1'000'000;
  first.total_retrans_ = 4;
  monitor.Accept(Summary(ResourceHeader(0, 2), GrowingValues(0)), 1);
  Require(sink.resource_.empty(), "a sample waits for its socket part");
  monitor.Accept(Sockets(ResourceHeader(0, 2), std::span{&first, 1}), 1);
  Require(sink.resource_.size() == 1, "a complete sample is used");
  auto second = TcpSocket(5, 950);
  second.rwnd_limited_us_ = 3'500'000;  // limited for 2.5 of 5 s
  second.total_retrans_ = 6;
  monitor.Accept(Sockets(ResourceHeader(1, 2), std::span{&second, 1}), 6);
  monitor.Accept(Summary(ResourceHeader(1, 2), GrowingValues(1)), 6);
  const auto live = monitor.Snapshot(6);
  Require(Field(live, "available").AsBool() && !Field(live, "stale").AsBool(),
          "the latest sample is live");
  RequireNear(Field(live, "elapsed_s").AsNumber(), 5, "elapsed");
  RequireNear(ResourceField(live, "pressure.host.io.some.pct").AsNumber(), 20,
              "PSI stall share over the interval");
  RequireNear(
      ResourceField(live, "pressure.cgroup.memory.full.avg10").AsNumber(), 20,
      "PSI avg10 in percent");
  RequireNear(ResourceField(live, "io.read_bps").AsNumber(), 1000,
              "storage read rate");
  Require(ResourceField(live, "io.rchar_bps").IsNull(),
          "an unavailable counter has no rate");
  Require(ResourceField(live, "network.listen_overflows.delta").AsInt() == 3,
          "namespace counter growth");
  RequireNear(ResourceField(live, "network.listen_overflows.per_s").AsNumber(),
              0.6, "namespace counter rate");
  Require(ResourceField(live, "fds.open").AsInt() == 900, "descriptor count");
  const auto& top = ResourceField(live, "sockets.top").AsArray();
  Require(top.size() == 1, "one socket");
  RequireNear(Field(top[0], "rx_fill_pct").AsNumber(), 95, "receive fill");
  Require(Field(top[0], "local").AsString() == "[::1]:8080" &&
              Field(top[0], "remote").AsString() == "10.0.0.5:40000",
          std::format("endpoints, got {}", DumpJson(top[0])));
  RequireNear(ResourceField(top[0], "tcp.rwnd_limited_pct").AsNumber(), 50,
              "share of the interval limited by the peer's window");
  Require(ResourceField(top[0], "tcp.retrans_delta").AsInt() == 2,
          "per-socket retransmissions in the interval");

  const auto& rows = sink.resource_;
  Require(rows.size() == 2, "one row per sample");
  const auto& row = rows[1];
  const auto real = [&](std::string_view p_column)
  {
    return std::get<double>(row[std::ranges::find(kResourceColumns, p_column,
                                                  &ResourceColumn::name_) -
                                kResourceColumns.begin()]);
  };
  RequireNear(real("host_io_some_pct"), 20, "stored stall share");
  RequireNear(real("read_bps"), 1000, "stored read rate");
  RequireNear(real("max_rx_fill_pct"), 95, "stored fullest socket");
  Require(std::get<std::int64_t>(
              row[ResourceColumnIndex("listen_overflows_delta")]) == 3,
          "stored counter growth");
  Require(std::holds_alternative<std::monostate>(
              rows[0][ResourceColumnIndex("elapsed_s")]),
          "the first sample has no interval");
  const auto stored = ParseJson(std::string{row.sockets_.View()});
  Require(stored && stored->AsArray().size() == 1,
          "a busy socket is stored with the row");
  Require(rows[0].cgroup_.View() == "/app.slice", "cgroup path is stored");
}

void TestResourceResetsLossAndOrder()
{
  RowCollector sink;
  ResourceMonitor monitor{sink};
  monitor.Accept(Summary(ResourceHeader(0), GrowingValues(5)), 1);
  // Counters went backwards (a namespace or host restart): no rates.
  monitor.Accept(Summary(ResourceHeader(1), GrowingValues(0)), 6);
  auto live = monitor.Snapshot(6);
  Require(ResourceField(live, "network.listen_overflows.delta").IsNull() &&
              ResourceField(live, "pressure.host.cpu.some.pct").IsNull(),
          "a counter that went backwards has no rate");
  // A late part of an older sample is ignored.
  monitor.Accept(Summary(ResourceHeader(0), GrowingValues(0)), 7);
  Require(ResourceField(monitor.Snapshot(7), "stats.late").AsInt() == 1,
          "an older sample is late");
  // A lost socket part: the summary is used after the grace period.
  monitor.Accept(Summary(ResourceHeader(2, 2), GrowingValues(1)), 11);
  monitor.Drain(12);
  Require(Field(monitor.Snapshot(12), "sequence").AsInt() == 1,
          "waiting for the socket part");
  monitor.Drain(11 + ResourceMonitor::kGraceSeconds);
  live = monitor.Snapshot(13);
  Require(Field(live, "sequence").AsInt() == 2 &&
              !ResourceField(live, "sockets.complete").AsBool() &&
              ResourceField(live, "stats.incomplete").AsInt() == 1,
          "a partial sample is used and marked");
  // A part that disagrees with its sample's header is refused.
  auto other = ResourceHeader(3, 2);
  monitor.Accept(Summary(other, GrowingValues(2)), 16);
  other.wall_ns_ += 1;
  const auto socket = TcpSocket(1, 1);
  monitor.Accept(Sockets(other, std::span{&socket, 1}), 16);
  Require(monitor.bad_parts_ == 1, "a mismatched part is refused");
  // A new session starts without rates.
  monitor.Accept(Summary(ResourceHeader(0, 1, 2), GrowingValues(9)), 20);
  live = monitor.Snapshot(20);
  Require(Field(live, "session").AsString() == "2" &&
              Field(live, "elapsed_s").IsNull(),
          "a new session has no interval");
  Require(Field(monitor.Snapshot(60), "stale").AsBool(),
          "a silent resource stream is stale");
}

// Pending and delayed packets from an old target must not replace the new
// target, including when the old session never published a complete sample.
void TestResourceRetiredSessions()
{
  for (const bool prior_sample : {false, true})
  {
    for (const bool complete_old : {false, true})
    {
      RowCollector sink;
      ResourceMonitor monitor{sink};
      auto old_header = ResourceHeader(0);
      old_header.pid_ = 111;
      if (prior_sample)
      {
        monitor.Accept(Summary(old_header, GrowingValues(0)), 0);
      }
      old_header.sequence_ = 1;
      old_header.parts_ = 2;
      monitor.Accept(Summary(old_header, GrowingValues(1)), 1);
      auto new_header = ResourceHeader(0, 1, 2);
      new_header.pid_ = 222;
      monitor.Accept(Summary(new_header, GrowingValues(2)), 2);
      const auto row_count = sink.resource_.size();
      if (complete_old)
      {
        const auto socket = TcpSocket(5, 100);
        monitor.Accept(Sockets(old_header, std::span{&socket, 1}), 3);
      }
      monitor.Drain(3);
      // Even a higher sequence from the retired session remains late.
      old_header.sequence_ = 2;
      old_header.parts_ = 1;
      monitor.Accept(Summary(old_header, GrowingValues(3)), 4);
      monitor.Drain(4, true);
      const auto live = monitor.Snapshot(4);
      Require(Field(live, "session").AsString() == "2" &&
                  Field(live, "pid").AsInt() == 222 &&
                  Field(live, "elapsed_s").IsNull(),
              "retired sessions cannot replace the current target or rates");
      Require(sink.resource_.size() == row_count,
              "retired packets do not create new stored samples");
      Require(ResourceField(live, "stats.late").AsInt() > 0,
              "retired packets are counted as late");
    }
  }
}

// Memory, cgroup limits and interface counters: signed RSS growth, the share
// of CPU periods throttled, OOM kills and interface drops over the interval,
// and "no limit" staying unavailable.
void TestMemoryCgroupAndInterfaceRates()
{
  const auto values = [](std::uint64_t p_step)
  {
    auto summary = resource_wire::EmptySummary();
    summary[resource_wire::Field("rss_bytes")] = 900'000 - p_step * 50'000;
    summary[resource_wire::Field("swap_bytes")] = 0;
    summary[resource_wire::Field("cgroup_memory_current")] = 800'000;
    summary[resource_wire::Field("cgroup_memory_max")] = 1'000'000;
    summary[resource_wire::Field("cgroup_memory_oom_kill")] = p_step * 2;
    summary[resource_wire::Field("cgroup_memory_max_events")] = 5 + p_step * 7;
    summary[resource_wire::Field("cgroup_cpu_nr_periods")] = 100 + p_step * 50;
    summary[resource_wire::Field("cgroup_cpu_nr_throttled")] = 10 + p_step * 20;
    summary[resource_wire::Field("net_if_rx_errors")] = 1 + p_step;
    summary[resource_wire::Field("net_if_rx_dropped")] = 10 + p_step * 3;
    summary[resource_wire::Field("net_if_tx_errors")] = 2;
    summary[resource_wire::Field("net_if_tx_dropped")] = 20 + p_step * 4;
    return summary;
  };
  RowCollector sink;
  ResourceMonitor monitor{sink};
  monitor.Accept(Summary(ResourceHeader(0), values(0)), 1);
  Require(
      Field(monitor.Snapshot(1), "memory").Find("rss_growth_per_s")->IsNull(),
      "no growth before a second sample");
  monitor.Accept(Summary(ResourceHeader(1), values(1)), 6);
  const auto live = monitor.Snapshot(6);
  RequireNear(ResourceField(live, "memory.rss_growth_per_s").AsNumber(),
              -10'000, "a shrinking RSS has negative growth");
  Require(ResourceField(live, "memory.rss").AsInt() == 850'000 &&
              ResourceField(live, "memory.swap").AsInt() == 0 &&
              ResourceField(live, "memory.peak").IsNull(),
          "memory values; an unreported one is null");
  RequireNear(ResourceField(live, "cgroup_limits.cpu.throttled_pct").AsNumber(),
              40, "20 of 50 periods throttled");
  Require(
      ResourceField(live, "cgroup_limits.memory.oom_kill_delta").AsInt() == 2 &&
          ResourceField(live, "cgroup_limits.memory.max_events_delta")
                  .AsInt() == 7,
      "OOM kills and limit hits in the interval");
  Require(
      ResourceField(live, "cgroup_limits.memory.max").AsInt() == 1'000'000 &&
          ResourceField(live, "cgroup_limits.memory.high").IsNull() &&
          ResourceField(live, "cgroup_limits.cpu.quota_us").IsNull(),
      "an unlimited or unreadable limit is null, not zero");
  Require(ResourceField(live, "network.if_rx_dropped.delta").AsInt() == 3 &&
              ResourceField(live, "network.if_tx_errors.delta").AsInt() == 0,
          "interface counters are in the network object");
  const auto& row = sink.resource_[1];
  const auto integer = [&](std::string_view p_column)
  {
    return std::get<std::int64_t>(
        row[std::ranges::find(kResourceColumns, p_column,
                              &ResourceColumn::name_) -
            kResourceColumns.begin()]);
  };
  Require(integer("rss_bytes") == 850'000 &&
              integer("cgroup_memory_max") == 1'000'000 &&
              integer("cgroup_memory_oom_kill_delta") == 2 &&
              integer("if_errors_delta") == 1 &&
              integer("if_dropped_delta") == 7,
          "stored memory, OOM and interface growth (errors and drops summed)");
  RequireNear(
      std::get<double>(row[ResourceColumnIndex("cgroup_cpu_throttled_pct")]),
      40, "stored throttled share");
  Require(std::holds_alternative<std::monostate>(
              row[ResourceColumnIndex("cgroup_pids_current")]),
          "an unreported value is stored as NULL");
  // A counter reset (the cgroup was recreated) gives no OOM growth.
  monitor.Accept(Summary(ResourceHeader(2), values(0)), 11);
  Require(
      ResourceField(monitor.Snapshot(11), "cgroup_limits.memory.oom_kill_delta")
          .IsNull(),
      "counters that went backwards have no growth");
}

// An old resource table keeps its rows and gains missing measurements.
// History must also read a previous day without changing that file.
void TestExistingDayFileGainsNewResourceColumns()
{
  TempDirectory directory;
  const auto path = directory.Path() / "2023-11-14.sqlite3";
  {
    auto old = OpenDatabase(path, false);
    Require(old.has_value(), "the old resource day file opens");
    auto schema = ResourceTableSql();
    const auto first = schema.find("rss_bytes INTEGER, ");
    const auto last = schema.find("flags INTEGER NOT NULL, ");
    Require(first != std::string::npos && last > first,
            "the new measurements are in the schema");
    schema.erase(first, last - first);
    Require(Execute(old->get(), schema).has_value(),
            "the old resource table is created");
    Require(Execute(old->get(),
                    "INSERT INTO resource_sample "
                    "(ts,session,sequence,pid,fd_open,flags,cgroup,sockets,"
                    "sockets_complete) VALUES "
                    "(1700000000,'1',0,123,17,0,'','[]',1)")
                .has_value(),
            "an old resource row is stored");
  }
  const auto before =
      ResourceHistory(directory.Path(), 1'700'000'000, 1'700'000'100, 1);
  Require(!before.read_error_ && before.rows_.size() == 1,
          "old resource history stays readable");
  Require(Field(before.rows_[0], "fd_open").AsInt() == 17 &&
              Field(before.rows_[0], "rss_bytes").IsNull(),
          "old values stay available and missing measurements are null");
  {
    auto old = OpenDatabase(path, true);
    Require(old.has_value(), "the old resource day file reopens");
    const auto columns = TableColumns(old->get(), "resource_sample");
    Require(columns.has_value() && columns->size() == 51,
            "history does not change the old schema");
  }
  RowCollector sink;
  ResourceMonitor monitor{sink};
  auto values = resource_wire::EmptySummary();
  values[resource_wire::Field("rss_bytes")] = 123'456;
  monitor.Accept(Summary(ResourceHeader(1), values), 1'700'000'005);
  for (int attempt = 0; attempt < 2; ++attempt)
  {
    auto storage = Storage::Create(directory.Path(), 7);
    Require(storage.has_value(), "storage opens the old directory");
    Require(storage->Resource(sink.resource_[0]).has_value(),
            "a new resource row is written to the old file");
    Require(storage->Close().has_value(), "resource rows commit");
  }
  const auto after =
      ResourceHistory(directory.Path(), 1'700'000'000, 1'700'000'100, 1);
  Require(!after.read_error_ && after.rows_.size() == 2,
          "old and new rows remain after the schema update and reopen");
  Require(Field(after.rows_[0], "fd_open").AsInt() == 17 &&
              Field(after.rows_[0], "rss_bytes").IsNull() &&
              Field(after.rows_[1], "rss_bytes").AsInt() == 123'456,
          "the schema update preserves old data and stores new measurements");
}

// Rows reach SQLite, older day files gain the table, and history buckets
// keep peaks (Max) and add up growth (Sum).
void TestResourceStorageAndHistory()
{
  TempDirectory directory;
  {
    auto old = OpenDatabase(directory.Path() / "2023-11-14.sqlite3", false);
    Require(old.has_value() &&
                Execute(old->get(),
                        "CREATE TABLE raw_sample (ts REAL NOT NULL, session "
                        "TEXT NOT NULL, tid INTEGER NOT NULL, sample TEXT NOT "
                        "NULL)")
                    .has_value(),
            "a day file from before resource samples");
  }
  Require(ResourceHistory(directory.Path(), 1'699'999'000, 1'700'001'000, 60)
              .rows_.empty(),
          "no rows yet");
  Require(!ResourceHistory(directory.Path(), 1'699'999'000, 1'700'001'000, 60)
               .read_error_,
          "a day file without the table is not an error");
  RowCollector sink;
  ResourceMonitor monitor{sink};
  for (std::uint32_t sequence = 0; sequence < 13; ++sequence)
  {
    auto values = GrowingValues(sequence);
    values[resource_wire::Field("fd_open")] = 900 + sequence;
    monitor.Accept(Summary(ResourceHeader(sequence), values),
                   1'700'000'000 + sequence * 5.0);
  }
  auto storage = Storage::Create(directory.Path(), 7);
  Require(storage.has_value(), "storage opens");
  for (const auto& row : sink.resource_)
  {
    Require(storage->Resource(row).has_value(), "a resource row is written");
  }
  Require(storage->Flush(1'700'000'100).has_value(), "rows commit");
  // Buckets align to multiples of their size since the epoch, so the same
  // query always draws the same boundaries.
  const auto history =
      ResourceHistory(directory.Path(), 1'700'000'000, 1'700'000'100, 20);
  Require(!history.truncated_ && !history.read_error_, "complete history");
  // 13 samples at 0, 5, ..., 60 s: buckets [0,20) [20,40) [40,60) [60,80).
  Require(history.rows_.size() == 4, "four 20-second buckets");
  const auto& second = history.rows_[1];
  Require(Field(second, "samples").AsInt() == 4, "four samples per bucket");
  Require(Field(second, "fd_open").AsInt() == 907, "a bucket keeps the peak");
  Require(Field(second, "listen_overflows_delta").AsInt() == 12,
          "a bucket adds up counter growth");
  RequireNear(Field(second, "elapsed_s").AsNumber(), 20,
              "a bucket adds up elapsed time");
  RequireNear(Field(second, "ts").AsNumber(), 1'700'000'020,
              "a bucket starts at its earliest sample");
  const auto limited =
      ResourceHistory(directory.Path(), 1'700'000'000, 1'700'000'100, 20, 4);
  Require(limited.truncated_ && limited.rows_.size() == 1,
          "history reads a bounded number of samples");
}

}  // namespace

// ---------- Memory map ----------

memory_wire::Header MemoryHeader(std::uint32_t p_sequence,
                                 std::uint16_t p_layout_parts,
                                 std::uint16_t p_detail_parts)
{
  return memory_wire::Header{
      .parts_ = static_cast<std::uint16_t>(1 + p_layout_parts + p_detail_parts),
      .sequence_ = p_sequence,
      .session_ = 9,
      .monotonic_ns_ = 1,
      .wall_ns_ = 2,
      .pid_ = 123,
      .interval_ms_ = 2000,
      .generation_ = p_sequence,
      .layout_parts_ = p_layout_parts};
}

// The parts of one cycle, encoded and decoded as the collector receives
// them: the summary, then the layout parts, then the detail parts.
std::vector<memory_wire::Part> MemoryCycle(
    std::uint32_t p_sequence, std::span<const memory_wire::Vma> p_vmas,
    std::span<const memory_wire::Cell> p_cells)
{
  using memory_wire::DetailParts;
  using memory_wire::LayoutParts;
  const auto layout_parts =
      static_cast<std::uint16_t>(LayoutParts(p_vmas.size()));
  const auto detail_parts = static_cast<std::uint16_t>(
      p_cells.empty() ? 0 : DetailParts(p_cells.size()));
  const auto header = MemoryHeader(p_sequence, layout_parts, detail_parts);
  std::array<std::byte, memory_wire::kMaxPartSize> bytes{};
  std::vector<memory_wire::Part> parts;
  const auto add = [&](std::size_t p_length)
  {
    auto part = memory_wire::Decode(std::span{bytes}.first(p_length));
    Require(part.has_value(), "a test memory part decodes");
    parts.push_back(*part);
  };
  auto values = memory_wire::EmptySummary();
  values[memory_wire::Field("vma_count")] = p_vmas.size();
  values[memory_wire::Field("heap_end")] = 0x5000'0000'0000;
  values[memory_wire::Field("vm_rss_bytes")] = 4096;
  add(memory_wire::EncodeSummary(bytes, header, values));
  for (std::size_t index = 0; index < layout_parts; ++index)
  {
    add(memory_wire::EncodeVmas(bytes, header, p_vmas, index));
  }
  for (std::size_t index = 0; index < detail_parts; ++index)
  {
    add(memory_wire::EncodeDetail(
        bytes, header,
        memory_wire::Detail{.vma_start_ = p_vmas.front().start_,
                            .vma_end_ = p_vmas.front().end_,
                            .pages_per_cell_ = 1,
                            .measured_pages_ = 3,
                            .resident_pages_ = 2,
                            .status_ = memory_wire::DetailStatus::Complete},
        p_cells, index));
  }
  return parts;
}

std::vector<memory_wire::Vma> MemoryVmas(std::size_t p_count)
{
  std::vector<memory_wire::Vma> vmas(p_count);
  for (std::size_t index = 0; index < p_count; ++index)
  {
    vmas[index].start_ = 0x7f00'0000'0000 + index * 0x10000;
    vmas[index].end_ = vmas[index].start_ + 0x2000;
    vmas[index].kind_ = memory_wire::VmaKind::File;
    vmas[index].permissions_ = 5;
    vmas[index].SetName(std::format("/lib/\"quoted\"-{}.so", index));
  }
  vmas[0].kind_ = memory_wire::VmaKind::Heap;
  vmas[0].SetName("[heap]");
  return vmas;
}

// Reassembly: parts in any order make one list; a list that lost a part is
// not used, and the previous list stays; parts of an older cycle are late.
// The JSON keeps addresses as hex text and marks unmeasured cells null.
void TestMemoryMapAssembly()
{
  MemoryMapMonitor monitor;
  const auto parsed = [&](double p_now)
  {
    auto json = ParseJson(monitor.Json(p_now));
    Require(json.has_value(), "the memory-map JSON parses");
    return std::move(*json);
  };
  Require(Field(parsed(0), "state").AsString() == "waiting", "nothing yet");
  const auto vmas = MemoryVmas(30);
  const std::array<memory_wire::Cell, 3> cells{memory_wire::Cell{254, 0, 0},
                                               memory_wire::Cell{0, 254, 0},
                                               memory_wire::kUnmeasuredCell};
  auto parts = MemoryCycle(1, vmas, cells);
  Require(parts.size() == 1 + 3 + 1, "summary, three layout parts, detail");
  std::swap(parts[1], parts[3]);  // reordered on the network
  for (const auto& part : parts)
  {
    monitor.Accept(part, 100);
  }
  auto json = parsed(100);
  Require(Field(json, "state").AsString() == "live", "live");
  const auto& layout = Field(json, "layout");
  Require(Field(layout, "rows").AsArray().size() == 30 &&
              Field(layout, "generation").AsInt() == 1,
          "the whole list");
  const auto& heap = Field(layout, "rows").AsArray()[0].AsArray();
  Require(heap[0].AsString() == "7f0000000000" && heap[2].AsInt() == 0x2000 &&
              heap[6].AsString() == "r-xp" && heap[7].AsString() == "heap" &&
              heap[10].AsString() == "[heap]",
          "a row: hex start, size, permissions, kind, name");
  Require(Field(layout, "rows").AsArray()[1].AsArray()[10].AsString() ==
              "/lib/\"quoted\"-1.so",
          "names are escaped JSON text");
  const auto& values = Field(Field(json, "summary"), "values");
  Require(Field(values, "heap_end").AsString() == "500000000000" &&
              Field(values, "vm_rss_bytes").AsInt() == 4096 &&
              Field(values, "vm_size_bytes").IsNull(),
          "summary: hex addresses, numbers, null when unavailable");
  const auto& detail = Field(json, "detail");
  Require(Field(detail, "status").AsString() == "complete" &&
              Field(detail, "cells").AsArray().size() == 3 &&
              Field(detail, "cells").AsArray()[2].IsNull() &&
              Field(detail, "cells").AsArray()[1].AsArray()[1].AsInt() == 254,
          "detail cells");

  // Cycle 2 loses its second layout part; cycle 3 has no layout at all.
  auto lost = MemoryCycle(2, MemoryVmas(20), {});
  lost.erase(lost.begin() + 2);
  for (const auto& part : lost)
  {
    monitor.Accept(part, 102);
  }
  for (const auto& part : MemoryCycle(3, MemoryVmas(20), {}))
  {
    monitor.Accept(part, 104);
  }
  json = parsed(104);
  Require(Field(Field(json, "layout"), "generation").AsInt() == 3 &&
              Field(Field(json, "layout"), "rows").AsArray().size() == 20,
          "the next complete list replaces it");
  Require(Field(json, "incomplete_layouts").AsInt() == 1,
          "the list that lost a part is counted");
  Require(Field(json, "detail").IsNull(),
          "a cycle without detail ends the selection");
  const auto old = MemoryCycle(1, vmas, {});
  monitor.Accept(old[1], 105);
  Require(Field(parsed(105), "late_parts").AsInt() == 1, "an old part is late");
  Require(Field(parsed(104 + 2 * 3 + 2), "state").AsString() == "stale",
          "stale after three intervals without data");
}

// Rows to store: a summary row at most once a minute; the first complete
// list of each watch and then one an hour. Storage writes them only when
// the memory map is enabled, and old rows go after their retention.
void TestMemoryMapStorage()
{
  MemoryMapMonitor monitor;
  const auto vmas = MemoryVmas(3);
  const auto feed =
      [&](std::uint32_t p_sequence, double p_now, bool p_layout = true)
  {
    for (const auto& part : MemoryCycle(
             p_sequence,
             p_layout ? std::span{vmas} : std::span<memory_wire::Vma>{}, {}))
    {
      monitor.Accept(part, p_now);
    }
  };
  const double start = 1'700'000'000;
  feed(1, start);
  auto summary = monitor.TakeSummaryRow();
  auto snapshot = monitor.TakeSnapshot();
  Require(summary && snapshot && snapshot->vma_count_ == 3 &&
              snapshot->rows_.starts_with("[[\"7f0000000000\""),
          "the first summary and list are stored");
  feed(2, start + 30);
  Require(!monitor.TakeSummaryRow() && !monitor.TakeSnapshot(),
          "nothing more within a minute and an hour");
  feed(3, start + 61);
  Require(monitor.TakeSummaryRow().has_value(), "a minute later: a summary");
  Require(!monitor.TakeSnapshot(), "the list only each hour");
  feed(4, start + 61 + 120);  // two minutes without data: a new watch
  Require(monitor.TakeSnapshot().has_value(),
          "the first list of a new watch is stored");

  TempDirectory directory;
  auto storage = Storage::Create(directory.Path(), 7, 2);
  Require(storage.has_value(), "storage");
  Require(storage->MemorySummary(*summary).has_value() &&
              storage->MemorySnapshot(*snapshot).has_value() &&
              storage->Flush(start).has_value(),
          "memory rows are written");
  const auto day = directory.Path() / "2023-11-14.sqlite3";
  const auto count =
      [](const std::filesystem::path& p_path, std::string_view p_sql)
  {
    auto database = OpenDatabase(p_path, true);
    Require(database.has_value(), "open the day file");
    auto statement = Prepare(database->get(), p_sql);
    if (!statement)
    {
      return std::int64_t{-1};  // no such table
    }
    Require(::sqlite3_step(statement->get()) == SQLITE_ROW, "a count");
    return std::int64_t{::sqlite3_column_int64(statement->get(), 0)};
  };
  Require(count(day,
                "SELECT count(*) FROM vm_summary WHERE vm_rss_bytes = "
                "4096 AND vm_size_bytes IS NULL") == 1,
          "a summary row with NULL for unavailable values");
  Require(count(day,
                "SELECT count(*) FROM vm_snapshot WHERE vma_count = 3 "
                "AND json_array_length(vmas) = 3") == 1,
          "a snapshot row with the list as JSON");
  Require(storage->Close().has_value(), "close");

  // Three days later the memory rows are past their two days; the day
  // file is within its seven.
  auto later = Storage::Create(directory.Path(), 7, 2);
  Require(later.has_value() && later->Flush(start + 3 * 86400).has_value(),
          "the daily prune runs");
  Require(count(day, "SELECT count(*) FROM vm_summary") == 0 &&
              count(day, "SELECT count(*) FROM vm_snapshot") == 0 &&
              std::filesystem::exists(day),
          "memory rows deleted, the day file kept");
  Require(later->Close().has_value(), "close");

  TempDirectory plain;
  auto disabled = Storage::Create(plain.Path(), 7);
  RollupRow row;
  row.ts_ = start;
  row.session_ = "1";
  row.group_ = "ungrouped";
  Require(disabled && disabled->Rollup(row).has_value() &&
              disabled->Close().has_value(),
          "storage without the memory map");
  Require(count(plain.Path() / "2023-11-14.sqlite3",
                "SELECT count(*) FROM vm_summary") == -1,
          "no vm tables when the memory map is off");
}

// [memory_map]: off unless enabled; enabled needs the control address and
// a token file with safe permissions; its retention fits in the global one.
void TestMemoryMapConfig()
{
  Require(!ParseConfig("")->memory_map_, "off by default");
  Require(!ParseConfig("[memory_map]\nenabled = false\n")->memory_map_,
          "off when disabled");
  const auto enabled = ParseConfig(
      "[memory_map]\nenabled = true\nsampler_control = \"[::1]:9402\"\n"
      "token_file = \"/x\"\nretention_days = 3\n");
  Require(enabled && enabled->memory_map_ &&
              enabled->memory_map_->address_.ss_family == AF_INET6 &&
              enabled->memory_map_->retention_days_ == 3,
          "enabled");
  for (const auto invalid :
       {"[memory_map]\nenabled = true\n", "[memory_map]\nenabled = 1\n",
        "[memory_map]\nenabled = true\nsampler_control = \"host:9402\"\n"
        "token_file = \"/x\"\n",
        "[memory_map]\nenabled = true\nsampler_control = \"127.0.0.1:0\"\n"
        "token_file = \"/x\"\n",
        "retention_days = 2\n[memory_map]\nenabled = true\n"
        "sampler_control = \"127.0.0.1:9402\"\ntoken_file = \"/x\"\n",
        "[memory_map]\nenabled = true\nsampler_control = \"127.0.0.1:9402\"\n"
        "token_file = \"/x\"\nretention_days = 91\n"})
  {
    Require(!ParseConfig(invalid), std::format("invalid: {}", invalid));
  }
  TempDirectory directory;
  const auto token = directory.Path() / "token";
  std::ofstream{token} << "  0123456789abcdef0123456789abcdef  \nrest\n";
  ::chmod(token.c_str(), 0600);
  const auto read = ReadMemoryMapToken(token.string());
  Require(read && read->size() == 32, "the first line, trimmed");
  ::chmod(token.c_str(), 0640);
  Require(!ReadMemoryMapToken(token.string()), "group-readable is refused");
  ::chmod(token.c_str(), 0600);
  std::ofstream{token} << "short\n";
  Require(!ReadMemoryMapToken(token.string()), "a short token is refused");
}

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
    TestStorageReportsErrors();
    TestResourceRatesAndSockets();
    TestResourceResetsLossAndOrder();
    TestResourceRetiredSessions();
    TestMemoryCgroupAndInterfaceRates();
    TestExistingDayFileGainsNewResourceColumns();
    TestResourceStorageAndHistory();
    TestReplaySnapshots();
    TestReplaySkipsUnreadableFiles();
    TestSnapshotRecorder();
    TestReplayConfig();
    TestMemoryMapAssembly();
    TestMemoryMapStorage();
    TestMemoryMapConfig();
    std::puts(
        "C++ collector tests passed (decoding, classification, ticks, "
        "sessions, rollups, storage, health, resource samples, memory map)");
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
