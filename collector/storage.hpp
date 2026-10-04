#pragma once

#include <sqlite3.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <expected>
#include <filesystem>
#include <format>
#include <functional>
#include <iterator>
#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

#include "../socket_sampler/protocol.hpp"
#include "json.hpp"
#include "protocol.hpp"

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

struct RollupRow
{
  double ts_{};
  std::string session_;
  std::int64_t tid_{};
  std::string name_;
  std::string group_;
  std::optional<double> cpu_pct_;
  std::optional<double> run_delay_pct_;
  std::string sample_counts_;
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
  std::string session_;
  std::shared_ptr<const Record> record_;
};

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
  Binder& Add(std::string_view p_value)
  {
    ::sqlite3_bind_text(statement_, ++index_, p_value.data(),
                        static_cast<int>(p_value.size()), SQLITE_TRANSIENT);
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
  [[nodiscard]] static std::expected<Storage, std::string> Create(
      std::filesystem::path p_directory, std::int64_t p_retention_days)
  {
    std::error_code error;
    std::filesystem::create_directories(p_directory, error);
    if (error)
    {
      return std::unexpected(std::format(
          "cannot create {}: {}", p_directory.string(), error.message()));
    }
    return Storage{std::move(p_directory), p_retention_days};
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
        .Add(std::string_view{p_row.session_})
        .Add(p_row.tid_)
        .Add(std::string_view{p_row.name_})
        .Add(std::string_view{p_row.group_})
        .Add(p_row.cpu_pct_)
        .Add(p_row.run_delay_pct_)
        .Add(std::string_view{p_row.sample_counts_})
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
    Binder{file.raw_.get()}
        .Add(p_row.ts_)
        .Add(std::string_view{p_row.session_})
        .Add(std::int64_t{p_row.record_->tid_})
        .Add(std::string_view{DumpJson(RecordJson(*p_row.record_))});
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
    Binder{statement}
        .Add(p_received)
        .Add(std::string_view{std::to_string(p_observation.observer_)})
        .Add(std::int64_t{p_observation.pid_})
        .Add(static_cast<std::int64_t>(p_observation.sequence_))
        .Add(std::int64_t{p_observation.index_})
        .Add(std::int64_t{p_observation.count_});
    if (auto bound =
            Check(file.database_.get(),
                  ::sqlite3_bind_blob(statement, 7, p_packet.data(),
                                      static_cast<int>(p_packet.size()),
                                      SQLITE_TRANSIENT));
        !bound)
    {
      return bound;
    }
    return Run(file.database_.get(), statement);
  }

  // Commits pending rows, closes files for past days and, once a day,
  // deletes day files older than the retention period.
  [[nodiscard]] SqliteResult Flush(double p_now)
  {
    const auto today = UtcDay(p_now);
    const auto today_name = DayName(today);
    for (auto iterator = files_.begin(); iterator != files_.end();)
    {
      if (auto committed = Commit(iterator->second); !committed)
      {
        return committed;
      }
      if (iterator->first != today_name)
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
    bool in_transaction_ = false;
  };

  std::filesystem::path directory_;
  std::int64_t retention_days_;
  std::map<std::string, DayFile> files_;
  std::optional<Days> last_prune_;

  Storage(std::filesystem::path p_directory, std::int64_t p_retention_days)
      : directory_(std::move(p_directory)), retention_days_(p_retention_days)
  {
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
    const auto day = DayName(UtcDay(p_timestamp));
    if (const auto found = files_.find(day); found != files_.end())
    {
      return std::ref(found->second);
    }
    auto opened = OpenDay(directory_ / (day + ".sqlite3"));
    if (!opened)
    {
      return std::unexpected(std::move(opened.error()));
    }
    return std::ref(files_.emplace(day, std::move(*opened)).first->second);
  }

  // Opens (or creates) a day file, brings its schema up to date and
  // prepares the insert statements.
  [[nodiscard]] static std::expected<DayFile, std::string> OpenDay(
      const std::filesystem::path& p_path)
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
    for (const std::string_view sql :
         {std::string_view{"PRAGMA journal_mode=WAL"}, kSchema})
    {
      if (auto executed = Execute(database, sql); !executed)
      {
        return std::unexpected(std::move(executed.error()));
      }
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
    ::sqlite3_busy_timeout(database, 0);
    return file;
  }
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

}  // namespace triangulator::collector
