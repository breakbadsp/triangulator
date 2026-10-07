#pragma once

#include <sqlite3.h>

#include <algorithm>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <expected>
#include <filesystem>
#include <format>
#include <functional>
#include <iterator>
#include <limits>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <variant>
#include <vector>

#include "../common/resource_wire.hpp"
#include "../socket_sampler/protocol.hpp"
#include "bounded.hpp"
#include "json.hpp"
#include "memory_map.hpp"
#include "protocol.hpp"
#include "text.hpp"

namespace triangulator::collector
{

inline constexpr std::string_view kSchema = R"(
CREATE TABLE IF NOT EXISTS thread_rollup (
 ts REAL NOT NULL, session TEXT NOT NULL, tid INTEGER NOT NULL,
 name TEXT NOT NULL, group_name TEXT NOT NULL, cpu_pct REAL,
 run_delay_pct REAL, sample_counts TEXT NOT NULL, timeslices_delta INTEGER,
 samples INTEGER NOT NULL, expected_samples REAL NOT NULL, valid INTEGER NOT NULL,
 generation INTEGER NOT NULL, read_bps REAL, write_bps REAL, major_faults_delta INTEGER,
 PRIMARY KEY(ts, session, tid, generation)
);
CREATE INDEX IF NOT EXISTS rollup_thread ON thread_rollup(session, tid, ts);
CREATE TABLE IF NOT EXISTS alert_event (
 id INTEGER PRIMARY KEY, ts REAL NOT NULL, rule TEXT NOT NULL,
 group_name TEXT NOT NULL, tid INTEGER NOT NULL, name TEXT NOT NULL,
 detail TEXT NOT NULL, status TEXT NOT NULL, severity TEXT NOT NULL,
 session TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS socket_observation (
 received REAL NOT NULL, observer TEXT NOT NULL, pid INTEGER NOT NULL,
 sequence INTEGER NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL,
 packet BLOB NOT NULL, PRIMARY KEY(observer, sequence, part)
);
CREATE INDEX IF NOT EXISTS socket_latest ON socket_observation(pid, received);
CREATE INDEX IF NOT EXISTS socket_heartbeat_pid
 ON socket_observation(pid, received) WHERE part=0;
CREATE INDEX IF NOT EXISTS socket_heartbeat_received
 ON socket_observation(received) WHERE part=0;
CREATE TABLE IF NOT EXISTS raw_sample (
 ts REAL NOT NULL, session TEXT NOT NULL, tid INTEGER NOT NULL, sample TEXT NOT NULL
);
)";
// The schema matches the day files the retired Python collector wrote, so
// those stay readable. This collector never writes alert_event; alerting is
// a separate program.
// Columns added after the first release; older day files gain them on open.
inline constexpr std::array<std::pair<std::string_view, std::string_view>, 3>
    kAddedRollupColumns{{{"read_bps", "REAL"},
                         {"write_bps", "REAL"},
                         {"major_faults_delta", "INTEGER"}}};

// The sample_counts column: a JSON object of state counts, such as
// {"running": 3, "futex": 2}. It has at most kMaxStates entries. Each entry
// is the quoted name, ": ", a count of at most 20 digits and ", ".
using SampleCountsText =
    FixedText<kMaxStates*(kMaxStateNameSize + 2 + 2 + 20 + 2) + 2>;

// One rollup row. It holds its own text, except the group name, which views
// the group name in the Config.
struct RollupRow
{
  double ts_{};
  FixedText<24> session_;
  std::int64_t tid_{};
  FixedText<SanitizedSize(kCommSize)> name_;
  std::string_view group_;
  std::optional<double> cpu_pct_;
  std::optional<double> run_delay_pct_;
  SampleCountsText sample_counts_;
  std::optional<std::int64_t> timeslices_delta_;
  std::int64_t samples_{};
  double expected_samples_{};
  bool valid_{};
  std::int64_t generation_{};
  std::optional<double> read_bps_;
  std::optional<double> write_bps_;
  std::optional<std::int64_t> major_faults_delta_;
};

// One raw sample for the raw_sample table (written only when store_raw is
// on).
struct RawRow
{
  double ts_{};
  FixedText<24> session_;
  Record record_;
};

// How a resource column combines rows into one history bucket: the
// highest value (gauges, where the peak is what an incident review needs),
// the sum (per-interval deltas and their elapsed time), the earliest
// (timestamps), or not at all (identities and text).
enum class Combine
{
  None = 0,
  Max,
  Sum,
  Min
};

struct ResourceColumn
{
  std::string_view name_;
  std::string_view type_;
  Combine combine_;
};

// The resource_sample table, one row per resource sample. Percentages are
// over the interval since the previous sample (elapsed_s); "_delta" columns
// are how much a namespace counter grew in that interval. The schema, the
// insert statement and history buckets all come from this list.
inline constexpr std::array<ResourceColumn, 61> kResourceColumns{{
    {"ts", "REAL NOT NULL", Combine::Min},
    {"session", "TEXT NOT NULL", Combine::None},
    {"sequence", "INTEGER NOT NULL", Combine::None},
    {"pid", "INTEGER NOT NULL", Combine::Max},
    {"elapsed_s", "REAL", Combine::Sum},
    {"host_cpu_some_pct", "REAL", Combine::Max},
    {"host_cpu_full_pct", "REAL", Combine::Max},
    {"host_memory_some_pct", "REAL", Combine::Max},
    {"host_memory_full_pct", "REAL", Combine::Max},
    {"host_io_some_pct", "REAL", Combine::Max},
    {"host_io_full_pct", "REAL", Combine::Max},
    {"cgroup_cpu_some_pct", "REAL", Combine::Max},
    {"cgroup_cpu_full_pct", "REAL", Combine::Max},
    {"cgroup_memory_some_pct", "REAL", Combine::Max},
    {"cgroup_memory_full_pct", "REAL", Combine::Max},
    {"cgroup_io_some_pct", "REAL", Combine::Max},
    {"cgroup_io_full_pct", "REAL", Combine::Max},
    {"fd_open", "INTEGER", Combine::Max},
    {"fd_soft_limit", "INTEGER", Combine::Max},
    {"fd_sockets", "INTEGER", Combine::Max},
    {"read_bps", "REAL", Combine::Max},
    {"write_bps", "REAL", Combine::Max},
    {"tcp_sockets", "INTEGER", Combine::Max},
    {"udp_sockets", "INTEGER", Combine::Max},
    {"unix_sockets", "INTEGER", Combine::Max},
    {"rx_queue_bytes", "INTEGER", Combine::Max},
    {"tx_queue_bytes", "INTEGER", Combine::Max},
    {"socket_drops", "INTEGER", Combine::Max},
    {"max_rx_fill_pct", "REAL", Combine::Max},
    {"max_tx_fill_pct", "REAL", Combine::Max},
    {"max_accept_fill_pct", "REAL", Combine::Max},
    {"tcp_established", "INTEGER", Combine::Max},
    {"tcp_close_wait", "INTEGER", Combine::Max},
    {"tcp_retrans_segs_delta", "INTEGER", Combine::Sum},
    {"tcp_timeouts_delta", "INTEGER", Combine::Sum},
    {"tcp_estab_resets_delta", "INTEGER", Combine::Sum},
    {"listen_overflows_delta", "INTEGER", Combine::Sum},
    {"listen_drops_delta", "INTEGER", Combine::Sum},
    {"tcp_backlog_drop_delta", "INTEGER", Combine::Sum},
    {"tcp_rcvq_drop_delta", "INTEGER", Combine::Sum},
    {"tcp_zero_window_drop_delta", "INTEGER", Combine::Sum},
    {"tcp_abort_on_memory_delta", "INTEGER", Combine::Sum},
    {"tcp_memory_pressures_delta", "INTEGER", Combine::Sum},
    {"udp_rcvbuf_errors_delta", "INTEGER", Combine::Sum},
    {"udp_sndbuf_errors_delta", "INTEGER", Combine::Sum},
    {"udp_in_errors_delta", "INTEGER", Combine::Sum},
    {"sockstat_tcp_mem", "INTEGER", Combine::Max},
    {"rss_bytes", "INTEGER", Combine::Max},
    {"swap_bytes", "INTEGER", Combine::Max},
    {"cgroup_memory_current", "INTEGER", Combine::Max},
    {"cgroup_memory_max", "INTEGER", Combine::Max},
    {"cgroup_memory_max_events_delta", "INTEGER", Combine::Sum},
    {"cgroup_memory_oom_kill_delta", "INTEGER", Combine::Sum},
    {"cgroup_cpu_throttled_pct", "REAL", Combine::Max},
    {"cgroup_pids_current", "INTEGER", Combine::Max},
    {"if_errors_delta", "INTEGER", Combine::Sum},
    {"if_dropped_delta", "INTEGER", Combine::Sum},
    {"flags", "INTEGER NOT NULL", Combine::None},
    {"cgroup", "TEXT NOT NULL", Combine::None},
    {"sockets", "TEXT NOT NULL", Combine::None},
    {"sockets_complete", "INTEGER NOT NULL", Combine::None},
}};

// Index of a resource column. consteval, so a misspelt name fails to compile.
consteval std::size_t ResourceColumnIndex(std::string_view p_name)
{
  for (std::size_t index = 0; index < kResourceColumns.size(); ++index)
  {
    if (kResourceColumns[index].name_ == p_name)
    {
      return index;
    }
  }
  throw "unknown resource column";
}

inline constexpr std::size_t kResourceTsColumn = ResourceColumnIndex("ts");
inline constexpr std::size_t kResourceSessionColumn =
    ResourceColumnIndex("session");
inline constexpr std::size_t kResourceCgroupColumn =
    ResourceColumnIndex("cgroup");
inline constexpr std::size_t kResourceSocketsColumn =
    ResourceColumnIndex("sockets");

// A value for one numeric SQLite column: NULL, integer or real.
using SqlValue = std::variant<std::monostate, std::int64_t, double>;

// The text of the stored sockets column, a JSON array of at most
// kStoredSockets sockets. A socket that does not fit is left out.
using StoredSocketsText = FixedText<4096>;

// One resource_sample row. The numeric columns are in values_, indexed by
// ResourceColumnIndex. The three text columns (session, cgroup and sockets)
// have their own members, and their entries in values_ stay NULL.
struct ResourceRow
{
  std::array<SqlValue, kResourceColumns.size()> values_{};
  FixedText<24> session_;
  FixedText<resource_wire::kCgroupSize> cgroup_;
  StoredSocketsText sockets_;

  [[nodiscard]] SqlValue& operator[](std::size_t p_column) noexcept
  {
    return values_[p_column];
  }
  [[nodiscard]] const SqlValue& operator[](std::size_t p_column) const noexcept
  {
    return values_[p_column];
  }
};

// Where the Monitor and the ResourceMonitor send finished rows. A sink
// writes the row at once and keeps any error for its owner; the monitors
// do not look at it. They do no I/O themselves and build rows on the stack, so
// nothing waits in a buffer that could grow.
class RowSink
{
 public:
  RowSink() = default;
  RowSink(const RowSink&) = delete;
  RowSink& operator=(const RowSink&) = delete;
  virtual ~RowSink() = default;

  virtual void Rollup(const RollupRow& p_row) = 0;
  virtual void Raw(const RawRow& p_row) = 0;
  virtual void Resource(const ResourceRow& p_row) = 0;
};

[[nodiscard]] inline std::string ResourceTableSql()
{
  std::string sql = "CREATE TABLE IF NOT EXISTS resource_sample (";
  for (const auto& column : kResourceColumns)
  {
    sql += std::format("{} {}, ", column.name_, column.type_);
  }
  sql +=
      "PRIMARY KEY(session, sequence));\n"
      "CREATE INDEX IF NOT EXISTS resource_time ON resource_sample(ts);";
  return sql;
}

[[nodiscard]] inline std::string ResourceInsertSql()
{
  std::string sql = "INSERT OR REPLACE INTO resource_sample(";
  std::string values;
  for (const auto& column : kResourceColumns)
  {
    sql += std::format("{}{}", values.empty() ? "" : ",", column.name_);
    values += values.empty() ? "?" : ",?";
  }
  return sql + ") VALUES (" + values + ")";
}

// Every SQLite helper reports failure as SQLite's error message.
using SqliteResult = std::expected<void, std::string>;

struct DatabaseCloser
{
  void operator()(sqlite3* p_database) const noexcept
  {
    ::sqlite3_close_v2(p_database);
  }
};
using Database = std::unique_ptr<sqlite3, DatabaseCloser>;

struct StatementFinalizer
{
  void operator()(sqlite3_stmt* p_statement) const noexcept
  {
    ::sqlite3_finalize(p_statement);
  }
};
using Statement = std::unique_ptr<sqlite3_stmt, StatementFinalizer>;

[[nodiscard]] inline SqliteResult Check(sqlite3* p_database, int p_result)
{
  if (p_result == SQLITE_OK || p_result == SQLITE_ROW ||
      p_result == SQLITE_DONE)
  {
    return {};
  }
  return std::unexpected(std::string{::sqlite3_errmsg(p_database)});
}

[[nodiscard]] inline std::expected<Database, std::string> OpenDatabase(
    const std::filesystem::path& p_path, bool p_read_only)
{
  sqlite3* raw = nullptr;
  const int flags = p_read_only ? SQLITE_OPEN_READONLY
                                : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
  const int result = ::sqlite3_open_v2(p_path.c_str(), &raw, flags, nullptr);
  // Owned before the check: sqlite3_open_v2 can return a handle on failure.
  Database database{raw};
  if (result != SQLITE_OK)
  {
    return std::unexpected(raw != nullptr
                               ? std::string{::sqlite3_errmsg(raw)}
                               : std::string{"cannot open database"});
  }
  return database;
}

[[nodiscard]] inline SqliteResult Execute(sqlite3* p_database,
                                          std::string_view p_sql)
{
  char* message = nullptr;
  const int result = ::sqlite3_exec(p_database, std::string{p_sql}.c_str(),
                                    nullptr, nullptr, &message);
  if (result != SQLITE_OK)
  {
    std::string text = message != nullptr ? message : "sqlite error";
    ::sqlite3_free(message);
    return std::unexpected(std::move(text));
  }
  return {};
}

[[nodiscard]] inline std::expected<Statement, std::string> Prepare(
    sqlite3* p_database, std::string_view p_sql)
{
  sqlite3_stmt* raw = nullptr;
  const int result = ::sqlite3_prepare_v2(
      p_database, p_sql.data(), static_cast<int>(p_sql.size()), &raw, nullptr);
  Statement statement{raw};
  if (auto checked = Check(p_database, result); !checked)
  {
    return std::unexpected(std::move(checked.error()));
  }
  return statement;
}

// Read column names before an update or a read of an older day file.
[[nodiscard]] inline std::expected<std::vector<std::string>, std::string>
TableColumns(sqlite3* p_database, std::string_view p_table)
{
  auto info =
      Prepare(p_database, std::format("PRAGMA table_info({})", p_table));
  if (!info)
  {
    return std::unexpected(std::move(info.error()));
  }
  std::vector<std::string> columns;
  int status = SQLITE_ROW;
  while ((status = ::sqlite3_step(info->get())) == SQLITE_ROW)
  {
    columns.emplace_back(
        reinterpret_cast<const char*>(::sqlite3_column_text(info->get(), 1)));
  }
  if (auto checked = Check(p_database, status); !checked)
  {
    return std::unexpected(std::move(checked.error()));
  }
  return columns;
}

// New measurements have no value in old rows. Add nullable columns so that
// existing data stays available when the collector opens the file again.
[[nodiscard]] inline SqliteResult UpdateResourceColumns(sqlite3* p_database)
{
  auto existing = TableColumns(p_database, "resource_sample");
  if (!existing)
  {
    return std::unexpected(std::move(existing.error()));
  }
  for (const auto& column : kResourceColumns)
  {
    if (column.type_.find("NOT NULL") != std::string_view::npos ||
        std::ranges::find(*existing, column.name_) != existing->end())
    {
      continue;
    }
    if (auto added =
            Execute(p_database,
                    std::format("ALTER TABLE resource_sample ADD COLUMN {} {}",
                                column.name_, column.type_));
        !added)
    {
      return added;
    }
  }
  return {};
}

// The memory-map tables (docs/process-memory-map-design.md, section 8).
// They exist only in day files that a collector with [memory_map] enabled =
// true wrote. vm_summary has one column per summary field.
[[nodiscard]] inline std::string MemoryTableSql()
{
  std::string sql =
      "CREATE TABLE IF NOT EXISTS vm_summary (ts REAL NOT NULL, session TEXT "
      "NOT NULL, pid INTEGER NOT NULL, generation INTEGER NOT NULL, flags "
      "INTEGER NOT NULL";
  for (const auto name : memory_wire::kSummaryFields)
  {
    sql += std::format(", {} INTEGER", name);
  }
  sql +=
      ", PRIMARY KEY(session, ts));\n"
      "CREATE INDEX IF NOT EXISTS vm_summary_time ON vm_summary(ts);\n"
      "CREATE TABLE IF NOT EXISTS vm_snapshot (ts REAL NOT NULL, session TEXT "
      "NOT NULL, pid INTEGER NOT NULL, generation INTEGER NOT NULL, vma_count "
      "INTEGER NOT NULL, truncated INTEGER NOT NULL, columns TEXT NOT NULL, "
      "vmas TEXT NOT NULL, PRIMARY KEY(session, ts));\n"
      "CREATE INDEX IF NOT EXISTS vm_snapshot_time ON vm_snapshot(ts);";
  return sql;
}

[[nodiscard]] inline std::string MemorySummaryInsertSql()
{
  std::string sql =
      "INSERT OR REPLACE INTO vm_summary(ts,session,pid,generation,flags";
  std::string values = "?,?,?,?,?";
  for (const auto name : memory_wire::kSummaryFields)
  {
    sql += std::format(",{}", name);
    values += ",?";
  }
  return sql + ") VALUES (" + values + ")";
}

// Summary fields added after the first release; older day files gain them.
[[nodiscard]] inline SqliteResult UpdateMemoryColumns(sqlite3* p_database)
{
  auto existing = TableColumns(p_database, "vm_summary");
  if (!existing)
  {
    return std::unexpected(std::move(existing.error()));
  }
  for (const auto name : memory_wire::kSummaryFields)
  {
    if (std::ranges::find(*existing, name) != existing->end())
    {
      continue;
    }
    if (auto added = Execute(
            p_database,
            std::format("ALTER TABLE vm_summary ADD COLUMN {} INTEGER", name));
        !added)
    {
      return added;
    }
  }
  return {};
}

// Binds values to parameters 1, 2, ... in order.
class Binder
{
 public:
  explicit Binder(sqlite3_stmt* p_statement) : statement_(p_statement)
  {
    ::sqlite3_reset(statement_);
    ::sqlite3_clear_bindings(statement_);
  }
  Binder& Add(double p_value)
  {
    ::sqlite3_bind_double(statement_, ++index_, p_value);
    return *this;
  }
  Binder& Add(std::int64_t p_value)
  {
    ::sqlite3_bind_int64(statement_, ++index_, p_value);
    return *this;
  }
  // The text must stay valid until the statement runs. SQLITE_STATIC makes
  // SQLite read it in place; SQLITE_TRANSIENT would copy it into memory that
  // SQLite allocates.
  Binder& Add(std::string_view p_value)
  {
    ::sqlite3_bind_text(statement_, ++index_, p_value.data(),
                        static_cast<int>(p_value.size()), SQLITE_STATIC);
    return *this;
  }
  Binder& Add(const SqlValue& p_value)
  {
    if (const auto* integer = std::get_if<std::int64_t>(&p_value))
    {
      return Add(*integer);
    }
    if (const auto* real = std::get_if<double>(&p_value))
    {
      return Add(*real);
    }
    ::sqlite3_bind_null(statement_, ++index_);
    return *this;
  }
  template <typename Value>
  Binder& Add(const std::optional<Value>& p_value)
  {
    if (p_value)
    {
      return Add(*p_value);
    }
    ::sqlite3_bind_null(statement_, ++index_);
    return *this;
  }

 private:
  sqlite3_stmt* statement_;
  int index_ = 0;
};

[[nodiscard]] inline SqliteResult Run(sqlite3* p_database,
                                      sqlite3_stmt* p_statement)
{
  // Read the error message before sqlite3_reset, which starts over.
  auto result = Check(p_database, ::sqlite3_step(p_statement));
  ::sqlite3_reset(p_statement);
  return result;
}

[[nodiscard]] inline Json ColumnJson(sqlite3_stmt* p_statement, int p_column)
{
  switch (::sqlite3_column_type(p_statement, p_column))
  {
    case SQLITE_INTEGER:
      return Json(::sqlite3_column_int64(p_statement, p_column));
    case SQLITE_FLOAT:
      return Json(::sqlite3_column_double(p_statement, p_column));
    case SQLITE_TEXT:
      return Json(std::string{reinterpret_cast<const char*>(
                                  ::sqlite3_column_text(p_statement, p_column)),
                              static_cast<std::size_t>(::sqlite3_column_bytes(
                                  p_statement, p_column))});
    default:
      return Json(nullptr);
  }
}

[[nodiscard]] inline std::string ColumnText(sqlite3_stmt* p_statement,
                                            int p_column)
{
  const auto* text = ::sqlite3_column_text(p_statement, p_column);
  return text == nullptr
             ? std::string{}
             : std::string{reinterpret_cast<const char*>(text),
                           static_cast<std::size_t>(
                               ::sqlite3_column_bytes(p_statement, p_column))};
}

using Days = std::chrono::sys_days;

[[nodiscard]] inline Days UtcDay(double p_timestamp)
{
  const auto seconds = std::chrono::sys_seconds{
      std::chrono::seconds{static_cast<std::int64_t>(std::floor(p_timestamp))}};
  return std::chrono::floor<std::chrono::days>(seconds);
}

[[nodiscard]] inline std::string DayName(Days p_day)
{
  return std::format("{:%F}", p_day);
}

// Parses a YYYY-MM-DD day file stem, or nullopt for other names.
[[nodiscard]] inline std::optional<Days> ParseDay(std::string_view p_stem)
{
  if (p_stem.size() != 10 || p_stem[4] != '-' || p_stem[7] != '-')
  {
    return std::nullopt;
  }
  int year = 0;
  unsigned month = 0;
  unsigned day = 0;
  const auto* text = p_stem.data();
  if (std::from_chars(text, text + 4, year).ptr != text + 4 ||
      std::from_chars(text + 5, text + 7, month).ptr != text + 7 ||
      std::from_chars(text + 8, text + 10, day).ptr != text + 10)
  {
    return std::nullopt;
  }
  const std::chrono::year_month_day date{std::chrono::year{year},
                                         std::chrono::month{month},
                                         std::chrono::day{day}};
  if (!date.ok())
  {
    return std::nullopt;
  }
  return Days{date};
}

// Day files (????-??-??.sqlite3) in p_directory, sorted by name. A directory
// that can't be read (or stops being readable midway) gives the files found
// so far.
[[nodiscard]] inline std::vector<std::filesystem::path> DayFiles(
    const std::filesystem::path& p_directory)
{
  std::vector<std::filesystem::path> files;
  std::error_code error;
  // increment(error) rather than a range-for: operator++ throws
  // filesystem_error when reading the next entry fails.
  for (std::filesystem::directory_iterator entry{p_directory, error}, end;
       !error && entry != end; entry.increment(error))
  {
    const auto name = entry->path().filename().string();
    if (name.size() == 18 && name.ends_with(".sqlite3") && name[4] == '-' &&
        name[7] == '-')
    {
      files.push_back(entry->path());
    }
  }
  std::ranges::sort(files);
  return files;
}

class Storage
{
 public:
  // p_memory_retention_days is set when [memory_map] is enabled: only
  // then do day files get the vm_* tables.
  [[nodiscard]] static std::expected<Storage, std::string> Create(
      std::filesystem::path p_directory, std::int64_t p_retention_days,
      std::optional<std::int64_t> p_memory_retention_days = std::nullopt)
  {
    std::error_code error;
    std::filesystem::create_directories(p_directory, error);
    if (error)
    {
      return std::unexpected(std::format(
          "cannot create {}: {}", p_directory.string(), error.message()));
    }
    return Storage{std::move(p_directory), p_retention_days,
                   p_memory_retention_days};
  }

  [[nodiscard]] SqliteResult Rollup(const RollupRow& p_row)
  {
    auto connection = Connection(p_row.ts_);
    if (!connection)
    {
      return std::unexpected(std::move(connection.error()));
    }
    DayFile& file = connection->get();
    if (auto begun = Begin(file); !begun)
    {
      return begun;
    }
    Binder{file.rollup_.get()}
        .Add(p_row.ts_)
        .Add(p_row.session_.View())
        .Add(p_row.tid_)
        .Add(p_row.name_.View())
        .Add(p_row.group_)
        .Add(p_row.cpu_pct_)
        .Add(p_row.run_delay_pct_)
        .Add(p_row.sample_counts_.View())
        .Add(p_row.timeslices_delta_)
        .Add(p_row.samples_)
        .Add(p_row.expected_samples_)
        .Add(std::int64_t{p_row.valid_ ? 1 : 0})
        .Add(p_row.generation_)
        .Add(p_row.read_bps_)
        .Add(p_row.write_bps_)
        .Add(p_row.major_faults_delta_);
    return Run(file.database_.get(), file.rollup_.get());
  }

  [[nodiscard]] SqliteResult Raw(const RawRow& p_row)
  {
    auto connection = Connection(p_row.ts_);
    if (!connection)
    {
      return std::unexpected(std::move(connection.error()));
    }
    DayFile& file = connection->get();
    if (auto begun = Begin(file); !begun)
    {
      return begun;
    }
    RecordJsonText sample;
    AppendRecordJson(sample, p_row.record_);
    Binder{file.raw_.get()}
        .Add(p_row.ts_)
        .Add(p_row.session_.View())
        .Add(std::int64_t{p_row.record_.tid_})
        .Add(sample.View());
    return Run(file.database_.get(), file.raw_.get());
  }

  // Socket snapshots are always retained independently of store_raw.
  // Only raw observations are ingested here; the separate report helper reads
  // WAL.
  [[nodiscard]] SqliteResult Socket(
      double p_received, const socket_metrics::Observation& p_observation,
      std::span<const std::byte> p_packet)
  {
    auto connection = Connection(p_received);
    if (!connection)
    {
      return std::unexpected(std::move(connection.error()));
    }
    DayFile& file = connection->get();
    if (auto begun = Begin(file); !begun)
    {
      return begun;
    }
    auto* statement = file.socket_.get();
    FixedText<24> observer;
    AppendUnsigned(observer, p_observation.observer_);
    Binder{statement}
        .Add(p_received)
        .Add(observer.View())
        .Add(std::int64_t{p_observation.pid_})
        .Add(static_cast<std::int64_t>(p_observation.sequence_))
        .Add(std::int64_t{p_observation.index_})
        .Add(std::int64_t{p_observation.count_});
    if (auto bound =
            Check(file.database_.get(),
                  ::sqlite3_bind_blob(statement, 7, p_packet.data(),
                                      static_cast<int>(p_packet.size()),
                                      SQLITE_STATIC));
        !bound)
    {
      return bound;
    }
    return Run(file.database_.get(), statement);
  }

  [[nodiscard]] SqliteResult Resource(const ResourceRow& p_row)
  {
    const auto* ts = std::get_if<double>(&p_row[kResourceTsColumn]);
    auto connection = Connection(ts != nullptr ? *ts : 0);
    if (!connection)
    {
      return std::unexpected(std::move(connection.error()));
    }
    DayFile& file = connection->get();
    if (auto begun = Begin(file); !begun)
    {
      return begun;
    }
    Binder binder{file.resource_.get()};
    for (std::size_t column = 0; column < p_row.values_.size(); ++column)
    {
      if (column == kResourceSessionColumn)
      {
        binder.Add(p_row.session_.View());
      }
      else if (column == kResourceCgroupColumn)
      {
        binder.Add(p_row.cgroup_.View());
      }
      else if (column == kResourceSocketsColumn)
      {
        binder.Add(p_row.sockets_.View());
      }
      else
      {
        binder.Add(p_row.values_[column]);
      }
    }
    return Run(file.database_.get(), file.resource_.get());
  }

  [[nodiscard]] SqliteResult MemorySummary(const MemorySummaryRow& p_row)
  {
    assert(memory_retention_days_.has_value());
    auto connection = Connection(p_row.ts_);
    if (!connection)
    {
      return std::unexpected(std::move(connection.error()));
    }
    DayFile& file = connection->get();
    if (auto begun = Begin(file); !begun)
    {
      return begun;
    }
    Binder binder{file.memory_summary_.get()};
    binder.Add(p_row.ts_)
        .Add(p_row.session_.View())
        .Add(std::int64_t{p_row.pid_})
        .Add(std::int64_t{p_row.generation_})
        .Add(std::int64_t{p_row.flags_});
    for (const auto value : p_row.values_)
    {
      // Unavailable values, and values SQLite cannot hold, are NULL.
      binder.Add(value <= static_cast<std::uint64_t>(
                              std::numeric_limits<std::int64_t>::max())
                     ? std::optional{static_cast<std::int64_t>(value)}
                     : std::nullopt);
    }
    return Run(file.database_.get(), file.memory_summary_.get());
  }

  [[nodiscard]] SqliteResult MemorySnapshot(const MemorySnapshotRow& p_row)
  {
    assert(memory_retention_days_.has_value());
    auto connection = Connection(p_row.ts_);
    if (!connection)
    {
      return std::unexpected(std::move(connection.error()));
    }
    DayFile& file = connection->get();
    if (auto begun = Begin(file); !begun)
    {
      return begun;
    }
    Binder{file.memory_snapshot_.get()}
        .Add(p_row.ts_)
        .Add(std::string_view{p_row.session_})
        .Add(std::int64_t{p_row.pid_})
        .Add(std::int64_t{p_row.generation_})
        .Add(static_cast<std::int64_t>(p_row.vma_count_))
        .Add(std::int64_t{p_row.truncated_ ? 1 : 0})
        .Add(kVmaColumns)
        .Add(std::string_view{p_row.rows_});
    return Run(file.database_.get(), file.memory_snapshot_.get());
  }

  // Commits pending rows, closes files for past days and, once a day,
  // deletes day files older than the retention period.
  [[nodiscard]] SqliteResult Flush(double p_now)
  {
    const auto today = UtcDay(p_now);
    for (auto iterator = files_.begin(); iterator != files_.end();)
    {
      if (auto committed = Commit(iterator->second); !committed)
      {
        return committed;
      }
      if (iterator->first != today)
      {
        iterator = files_.erase(iterator);
      }
      else
      {
        ++iterator;
      }
    }
    if (last_prune_ == today)
    {
      return {};
    }
    const auto cutoff =
        today - std::chrono::days{static_cast<int>(retention_days_ - 1)};
    for (const auto& path : DayFiles(directory_))
    {
      const auto day = ParseDay(path.stem().string());
      if (day && *day < cutoff)
      {
        for (const std::string_view suffix : {"", "-wal", "-shm"})
        {
          std::error_code error;
          std::filesystem::remove(path.string() + std::string{suffix}, error);
        }
      }
      else if (day && memory_retention_days_ &&
               *day < today - std::chrono::days{static_cast<int>(
                                  *memory_retention_days_ - 1)})
      {
        if (auto pruned = PruneMemory(path); !pruned)
        {
          return pruned;
        }
      }
    }
    last_prune_ = today;
    return {};
  }

  // Commits and closes every file. A failed commit doesn't stop the others;
  // the first error is returned.
  [[nodiscard]] SqliteResult Close()
  {
    SqliteResult result;
    for (auto& [day, file] : files_)
    {
      auto committed = Commit(file);
      if (!committed && result)
      {
        result = std::move(committed);
      }
    }
    files_.clear();
    return result;
  }

 private:
  struct DayFile
  {
    Database database_;
    Statement rollup_;
    Statement raw_;
    Statement socket_;
    Statement resource_;
    Statement memory_summary_;  // only with the memory map enabled
    Statement memory_snapshot_;
    bool in_transaction_ = false;
  };

  std::filesystem::path directory_;
  std::int64_t retention_days_;
  std::optional<std::int64_t> memory_retention_days_;
  std::map<Days, DayFile> files_;
  std::optional<Days> last_prune_;

  Storage(std::filesystem::path p_directory, std::int64_t p_retention_days,
          std::optional<std::int64_t> p_memory_retention_days)
      : directory_(std::move(p_directory)),
        retention_days_(p_retention_days),
        memory_retention_days_(p_memory_retention_days)
  {
  }

  // Deletes the memory-map rows of a day file that is past their retention
  // but within the file's. Files without the tables are left alone.
  [[nodiscard]] static SqliteResult PruneMemory(
      const std::filesystem::path& p_path)
  {
    auto opened = OpenDatabase(p_path, false);
    if (!opened)
    {
      return std::unexpected(std::move(opened.error()));
    }
    auto* database = opened->get();
    ::sqlite3_busy_timeout(database, 1000);
    auto tables = Prepare(database,
                          "SELECT count(*) FROM sqlite_master WHERE type = "
                          "'table' AND name = 'vm_summary'");
    if (!tables)
    {
      return std::unexpected(std::move(tables.error()));
    }
    if (::sqlite3_step(tables->get()) != SQLITE_ROW ||
        ::sqlite3_column_int(tables->get(), 0) == 0)
    {
      return {};
    }
    tables->reset();
    return Execute(database,
                   "DELETE FROM vm_summary; DELETE FROM vm_snapshot;");
  }

  // Rows are written in one transaction per flush, like Python's sqlite3
  // module, which opens a transaction before the first insert.
  [[nodiscard]] static SqliteResult Begin(DayFile& p_file)
  {
    if (p_file.in_transaction_)
    {
      return {};
    }
    auto begun = Execute(p_file.database_.get(), "BEGIN");
    p_file.in_transaction_ = begun.has_value();
    return begun;
  }

  [[nodiscard]] static SqliteResult Commit(DayFile& p_file)
  {
    if (!p_file.in_transaction_)
    {
      return {};
    }
    auto committed = Execute(p_file.database_.get(), "COMMIT");
    p_file.in_transaction_ = !committed.has_value();
    return committed;
  }

  [[nodiscard]] std::expected<std::reference_wrapper<DayFile>, std::string>
  Connection(double p_timestamp)
  {
    const auto day = UtcDay(p_timestamp);
    if (const auto found = files_.find(day); found != files_.end())
    {
      return std::ref(found->second);
    }
    // The first row of a new UTC day opens that day's file. Like startup,
    // this allocates.
    auto opened = OpenDay(directory_ / (DayName(day) + ".sqlite3"));
    if (!opened)
    {
      return std::unexpected(std::move(opened.error()));
    }
    return std::ref(files_.emplace(day, std::move(*opened)).first->second);
  }

  // Opens (or creates) a day file, brings its schema up to date and
  // prepares the insert statements.
  [[nodiscard]] std::expected<DayFile, std::string> OpenDay(
      const std::filesystem::path& p_path) const
  {
    auto opened = OpenDatabase(p_path, false);
    if (!opened)
    {
      return std::unexpected(std::move(opened.error()));
    }
    DayFile file;
    file.database_ = std::move(*opened);
    auto* database = file.database_.get();
    // A dashboard reader can discover a new file before it enters WAL mode.
    // Allow that short read to finish during initialization only. Normal
    // ingestion retains its nonblocking lock policy once WAL is established.
    ::sqlite3_busy_timeout(database, 1000);
    // Older day files gain the resource table here.
    const auto resource_table = ResourceTableSql();
    for (const std::string_view sql :
         {std::string_view{"PRAGMA journal_mode=WAL"}, kSchema,
          std::string_view{resource_table}})
    {
      if (auto executed = Execute(database, sql); !executed)
      {
        return std::unexpected(std::move(executed.error()));
      }
    }
    if (auto updated = UpdateResourceColumns(database); !updated)
    {
      return std::unexpected(std::move(updated.error()));
    }
    std::vector<std::string> existing;
    {
      auto info = Prepare(database, "PRAGMA table_info(thread_rollup)");
      if (!info)
      {
        return std::unexpected(std::move(info.error()));
      }
      while (::sqlite3_step(info->get()) == SQLITE_ROW)
      {
        existing.push_back(ColumnText(info->get(), 1));
      }
    }
    for (const auto& [column, kind] : kAddedRollupColumns)
    {
      if (std::ranges::find(existing, column) != existing.end())
      {
        continue;
      }
      if (auto added =
              Execute(database,
                      std::format("ALTER TABLE thread_rollup ADD COLUMN {} {}",
                                  column, kind));
          !added)
      {
        return std::unexpected(std::move(added.error()));
      }
    }
    auto rollup = Prepare(
        database,
        "INSERT OR REPLACE INTO thread_rollup(ts,session,tid,name,group_name,"
        "cpu_pct,run_delay_pct,sample_counts,timeslices_delta,samples,"
        "expected_samples,valid,generation,read_bps,write_bps,"
        "major_faults_delta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    if (!rollup)
    {
      return std::unexpected(std::move(rollup.error()));
    }
    file.rollup_ = std::move(*rollup);
    auto raw = Prepare(database, "INSERT INTO raw_sample VALUES (?,?,?,?)");
    if (!raw)
    {
      return std::unexpected(std::move(raw.error()));
    }
    file.raw_ = std::move(*raw);
    auto socket = Prepare(
        database,
        "INSERT OR IGNORE INTO socket_observation VALUES (?,?,?,?,?,?,?)");
    if (!socket)
    {
      return std::unexpected(std::move(socket.error()));
    }
    file.socket_ = std::move(*socket);
    auto resource = Prepare(database, ResourceInsertSql());
    if (!resource)
    {
      return std::unexpected(std::move(resource.error()));
    }
    file.resource_ = std::move(*resource);
    if (memory_retention_days_)
    {
      if (auto created = Execute(database, MemoryTableSql()); !created)
      {
        return std::unexpected(std::move(created.error()));
      }
      if (auto updated = UpdateMemoryColumns(database); !updated)
      {
        return std::unexpected(std::move(updated.error()));
      }
      auto summary = Prepare(database, MemorySummaryInsertSql());
      if (!summary)
      {
        return std::unexpected(std::move(summary.error()));
      }
      file.memory_summary_ = std::move(*summary);
      auto snapshot = Prepare(
          database,
          "INSERT OR REPLACE INTO vm_snapshot VALUES (?,?,?,?,?,?,?,?)");
      if (!snapshot)
      {
        return std::unexpected(std::move(snapshot.error()));
      }
      file.memory_snapshot_ = std::move(*snapshot);
    }
    ::sqlite3_busy_timeout(database, 0);
    return file;
  }
};

// The sink the collector uses: writes each row to Storage. After the first
// failure it writes nothing more and keeps that error in Status(), which the
// main loop checks. Rows that follow a failed write would only fail too, and
// the loop stops on the first error anyway.
class StorageSink final : public RowSink
{
 public:
  explicit StorageSink(Storage& p_storage) noexcept : storage_(p_storage)
  {
  }

  void Rollup(const RollupRow& p_row) override
  {
    if (status_)
    {
      status_ = storage_.Rollup(p_row);
    }
  }
  void Raw(const RawRow& p_row) override
  {
    if (status_)
    {
      status_ = storage_.Raw(p_row);
    }
  }
  void Resource(const ResourceRow& p_row) override
  {
    if (status_)
    {
      status_ = storage_.Resource(p_row);
    }
  }

  [[nodiscard]] const SqliteResult& Status() const noexcept
  {
    return status_;
  }

 private:
  Storage& storage_;
  SqliteResult status_;
};

// Up to p_limit rollup rows for one thread from one day file, oldest first.
[[nodiscard]] inline std::expected<JsonArray, std::string> DayHistory(
    const std::filesystem::path& p_path, std::string_view p_session,
    std::int64_t p_tid, double p_start, double p_end, std::size_t p_limit)
{
  auto database = OpenDatabase(p_path, true);
  if (!database)
  {
    return std::unexpected(std::move(database.error()));
  }
  ::sqlite3_busy_timeout(database->get(), 2000);
  auto statement =
      Prepare(database->get(),
              "SELECT * FROM thread_rollup WHERE session=? AND tid=? AND "
              "ts>=? AND ts<=? ORDER BY ts LIMIT ?");
  if (!statement)
  {
    return std::unexpected(std::move(statement.error()));
  }
  auto* query = statement->get();
  Binder{query}.Add(p_session).Add(p_tid).Add(p_start).Add(p_end).Add(
      static_cast<std::int64_t>(p_limit));
  JsonArray rows;
  const int columns = ::sqlite3_column_count(query);
  int status = SQLITE_ROW;
  while ((status = ::sqlite3_step(query)) == SQLITE_ROW)
  {
    Json row{JsonObject{}};
    for (int column = 0; column < columns; ++column)
    {
      const std::string_view name = ::sqlite3_column_name(query, column);
      auto value = ColumnJson(query, column);
      if (name == "sample_counts" && value.IsString())
      {
        value = ParseJson(value.AsString()).value_or(Json{JsonObject{}});
      }
      row.Set(name, std::move(value));
    }
    rows.push_back(std::move(row));
  }
  if (auto checked = Check(database->get(), status); !checked)
  {
    return std::unexpected(std::move(checked.error()));
  }
  return rows;
}

// Rollup rows for one thread between p_start and p_end, oldest first. Day
// files that cannot be read (locked, damaged) are skipped.
[[nodiscard]] inline JsonArray History(const std::filesystem::path& p_directory,
                                       std::string_view p_session,
                                       std::int64_t p_tid, double p_start,
                                       double p_end, std::size_t p_limit = 2000)
{
  JsonArray result;
  const auto first = DayName(UtcDay(p_start));
  const auto last = DayName(UtcDay(p_end));
  for (const auto& path : DayFiles(p_directory))
  {
    const auto stem = path.stem().string();
    if (stem < first || stem > last)
    {
      continue;
    }
    auto rows = DayHistory(path, p_session, p_tid, p_start, p_end,
                           p_limit - result.size());
    if (!rows)
    {
      continue;
    }
    std::ranges::move(*rows, std::back_inserter(result));
    if (result.size() >= p_limit)
    {
      break;
    }
  }
  return result;
}

struct ResourceHistoryResult
{
  JsonArray rows_;
  // More than p_limit samples were in range; the newest are missing.
  bool truncated_ = false;
  bool read_error_ = false;
};

// Resource samples between p_start and p_end combined into p_bucket_s
// buckets as kResourceColumns says, oldest first, with "samples" per bucket.
// At most p_limit samples are read. Day files that cannot be read, or that
// predate the resource table, are skipped.
[[nodiscard]] inline ResourceHistoryResult ResourceHistory(
    const std::filesystem::path& p_directory, double p_start, double p_end,
    double p_bucket_s, std::size_t p_limit = 200'000)
{
  std::vector<std::size_t> columns;
  for (std::size_t index = 0; index < kResourceColumns.size(); ++index)
  {
    if (kResourceColumns[index].combine_ != Combine::None)
    {
      columns.push_back(index);
    }
  }
  ResourceHistoryResult result;
  std::optional<std::int64_t> bucket;
  std::vector<std::optional<double>> combined(columns.size());
  std::int64_t samples = 0;
  std::size_t read = 0;
  const auto finish = [&]
  {
    if (!bucket)
    {
      return;
    }
    Json row{JsonObject{}};
    for (std::size_t slot = 0; slot < columns.size(); ++slot)
    {
      const auto& column = kResourceColumns[columns[slot]];
      const auto& value = combined[slot];
      row.Set(column.name_, !value ? Json{}
                            : column.type_.starts_with("INTEGER")
                                ? Json(std::llround(*value))
                                : Json(*value));
    }
    row.Set("samples", samples);
    result.rows_.push_back(std::move(row));
    std::ranges::fill(combined, std::nullopt);
    samples = 0;
  };
  const auto first = DayName(UtcDay(p_start));
  const auto last = DayName(UtcDay(p_end));
  for (const auto& path : DayFiles(p_directory))
  {
    const auto stem = path.stem().string();
    if (stem < first || stem > last || read >= p_limit)
    {
      continue;
    }
    auto database = OpenDatabase(path, true);
    if (!database)
    {
      result.read_error_ = true;
      continue;
    }
    ::sqlite3_busy_timeout(database->get(), 2000);
    auto existing = TableColumns(database->get(), "resource_sample");
    if (!existing)
    {
      result.read_error_ = true;
      continue;
    }
    // History reads old files without changing them. Missing measurements
    // are NULL, as they are in rows from before the schema update.
    std::string select;
    for (const auto index : columns)
    {
      const auto name = kResourceColumns[index].name_;
      const bool present =
          std::ranges::find(*existing, name) != existing->end();
      select += std::format(
          "{}{}", select.empty() ? "" : ",",
          present ? std::string{name} : std::format("NULL AS {}", name));
    }
    const auto sql = std::format(
        "SELECT {} FROM resource_sample WHERE ts>=? AND ts<=? ORDER BY ts "
        "LIMIT ?",
        select);
    auto statement = Prepare(database->get(), sql);
    if (!statement)
    {
      // A day file from before resource samples has no table: nothing to
      // read, not an error.
      result.read_error_ =
          result.read_error_ ||
          statement.error().find("no such table") == std::string::npos;
      continue;
    }
    auto* query = statement->get();
    Binder{query}.Add(p_start).Add(p_end).Add(
        static_cast<std::int64_t>(p_limit - read + 1));
    int status = SQLITE_ROW;
    while ((status = ::sqlite3_step(query)) == SQLITE_ROW)
    {
      if (++read > p_limit)
      {
        result.truncated_ = true;
        break;
      }
      const auto key = static_cast<std::int64_t>(
          std::floor(::sqlite3_column_double(query, 0) / p_bucket_s));
      if (bucket != key)
      {
        finish();
        bucket = key;
      }
      ++samples;
      for (std::size_t slot = 0; slot < columns.size(); ++slot)
      {
        if (::sqlite3_column_type(query, static_cast<int>(slot)) == SQLITE_NULL)
        {
          continue;
        }
        const double value =
            ::sqlite3_column_double(query, static_cast<int>(slot));
        auto& target = combined[slot];
        switch (kResourceColumns[columns[slot]].combine_)
        {
          case Combine::Max:
            target = target ? std::max(*target, value) : value;
            break;
          case Combine::Min:
            target = target ? std::min(*target, value) : value;
            break;
          case Combine::Sum:
            target = target.value_or(0) + value;
            break;
          case Combine::None:
            break;
        }
      }
    }
    if (status != SQLITE_ROW && status != SQLITE_DONE)
    {
      result.read_error_ = true;
    }
  }
  finish();
  return result;
}

}  // namespace triangulator::collector
