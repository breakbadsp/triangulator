#pragma once

#include <sqlite3.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <format>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <utility>
#include <vector>

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

class SqliteError : public std::runtime_error
{
 public:
  using std::runtime_error::runtime_error;
};

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

inline void Check(sqlite3* p_database, int p_result)
{
  if (p_result != SQLITE_OK && p_result != SQLITE_ROW &&
      p_result != SQLITE_DONE)
  {
    throw SqliteError(::sqlite3_errmsg(p_database));
  }
}

[[nodiscard]] inline Database OpenDatabase(const std::filesystem::path& p_path,
                                           bool p_read_only)
{
  sqlite3* raw = nullptr;
  const int flags = p_read_only ? SQLITE_OPEN_READONLY
                                : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE;
  const int result = ::sqlite3_open_v2(p_path.c_str(), &raw, flags, nullptr);
  Database database{raw};
  if (result != SQLITE_OK)
  {
    throw SqliteError(raw != nullptr ? ::sqlite3_errmsg(raw)
                                     : "cannot open database");
  }
  return database;
}

inline void Execute(sqlite3* p_database, std::string_view p_sql)
{
  char* message = nullptr;
  const int result = ::sqlite3_exec(p_database, std::string{p_sql}.c_str(),
                                    nullptr, nullptr, &message);
  if (result != SQLITE_OK)
  {
    std::string text = message != nullptr ? message : "sqlite error";
    ::sqlite3_free(message);
    throw SqliteError(text);
  }
}

[[nodiscard]] inline Statement Prepare(sqlite3* p_database,
                                       std::string_view p_sql)
{
  sqlite3_stmt* raw = nullptr;
  Check(p_database,
        ::sqlite3_prepare_v2(p_database, p_sql.data(),
                             static_cast<int>(p_sql.size()), &raw, nullptr));
  return Statement{raw};
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

inline void Run(sqlite3* p_database, sqlite3_stmt* p_statement)
{
  Check(p_database, ::sqlite3_step(p_statement));
  ::sqlite3_reset(p_statement);
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

// Day files (????-??-??.sqlite3) in p_directory, sorted by name.
[[nodiscard]] inline std::vector<std::filesystem::path> DayFiles(
    const std::filesystem::path& p_directory)
{
  std::vector<std::filesystem::path> files;
  std::error_code error;
  for (const auto& entry :
       std::filesystem::directory_iterator{p_directory, error})
  {
    const auto name = entry.path().filename().string();
    if (name.size() == 18 && name.ends_with(".sqlite3") && name[4] == '-' &&
        name[7] == '-')
    {
      files.push_back(entry.path());
    }
  }
  std::ranges::sort(files);
  return files;
}

class Storage
{
 public:
  Storage(std::filesystem::path p_directory, std::int64_t p_retention_days,
          bool p_store_raw)
      : directory_(std::move(p_directory)),
        retention_days_(p_retention_days),
        store_raw_(p_store_raw)
  {
    std::filesystem::create_directories(directory_);
  }

  void Rollup(const RollupRow& p_row)
  {
    auto& file = Connection(p_row.ts_);
    Begin(file);
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
    Run(file.database_.get(), file.rollup_.get());
  }

  void Raw(double p_timestamp, std::string_view p_session,
           const Record& p_record)
  {
    if (!store_raw_)
    {
      return;
    }
    auto& file = Connection(p_timestamp);
    Begin(file);
    Binder{file.raw_.get()}
        .Add(p_timestamp)
        .Add(p_session)
        .Add(std::int64_t{p_record.tid_})
        .Add(std::string_view{DumpJson(RecordJson(p_record))});
    Run(file.database_.get(), file.raw_.get());
  }

  // Commits pending rows, closes files for past days and, once a day,
  // deletes day files older than the retention period.
  void Flush(double p_now)
  {
    const auto today = UtcDay(p_now);
    const auto today_name = DayName(today);
    for (auto iterator = files_.begin(); iterator != files_.end();)
    {
      Commit(iterator->second);
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
      return;
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
  }

  void Close()
  {
    for (auto& [day, file] : files_)
    {
      Commit(file);
    }
    files_.clear();
  }

 private:
  struct DayFile
  {
    Database database_;
    Statement rollup_;
    Statement raw_;
    bool in_transaction_ = false;
  };

  std::filesystem::path directory_;
  std::int64_t retention_days_;
  bool store_raw_;
  std::map<std::string, DayFile> files_;
  std::optional<Days> last_prune_;

  // Rows are written in one transaction per flush, like Python's sqlite3
  // module, which opens a transaction before the first insert.
  static void Begin(DayFile& p_file)
  {
    if (!p_file.in_transaction_)
    {
      Execute(p_file.database_.get(), "BEGIN");
      p_file.in_transaction_ = true;
    }
  }

  static void Commit(DayFile& p_file)
  {
    if (p_file.in_transaction_)
    {
      Execute(p_file.database_.get(), "COMMIT");
      p_file.in_transaction_ = false;
    }
  }

  DayFile& Connection(double p_timestamp)
  {
    const auto day = DayName(UtcDay(p_timestamp));
    if (const auto found = files_.find(day); found != files_.end())
    {
      return found->second;
    }
    DayFile file;
    file.database_ = OpenDatabase(directory_ / (day + ".sqlite3"), false);
    auto* database = file.database_.get();
    Execute(database, "PRAGMA journal_mode=WAL");
    Execute(database, kSchema);
    std::vector<std::string> existing;
    {
      auto info = Prepare(database, "PRAGMA table_info(thread_rollup)");
      while (::sqlite3_step(info.get()) == SQLITE_ROW)
      {
        existing.push_back(ColumnText(info.get(), 1));
      }
    }
    for (const auto& [column, kind] : kAddedRollupColumns)
    {
      if (std::ranges::find(existing, column) == existing.end())
      {
        Execute(database,
                std::format("ALTER TABLE thread_rollup ADD COLUMN {} {}",
                            column, kind));
      }
    }
    file.rollup_ = Prepare(
        database,
        "INSERT OR REPLACE INTO thread_rollup(ts,session,tid,name,group_name,"
        "cpu_pct,run_delay_pct,sample_counts,timeslices_delta,samples,"
        "expected_samples,valid,generation,read_bps,write_bps,"
        "major_faults_delta) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    file.raw_ = Prepare(database, "INSERT INTO raw_sample VALUES (?,?,?,?)");
    return files_.emplace(day, std::move(file)).first->second;
  }
};

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
    try
    {
      auto database = OpenDatabase(path, true);
      ::sqlite3_busy_timeout(database.get(), 2000);
      auto statement =
          Prepare(database.get(),
                  "SELECT * FROM thread_rollup WHERE session=? AND tid=? AND "
                  "ts>=? AND ts<=? ORDER BY ts LIMIT ?");
      Binder{statement.get()}
          .Add(p_session)
          .Add(p_tid)
          .Add(p_start)
          .Add(p_end)
          .Add(static_cast<std::int64_t>(p_limit - result.size()));
      const int columns = ::sqlite3_column_count(statement.get());
      int status = SQLITE_ROW;
      while ((status = ::sqlite3_step(statement.get())) == SQLITE_ROW)
      {
        Json row{JsonObject{}};
        for (int column = 0; column < columns; ++column)
        {
          const std::string_view name =
              ::sqlite3_column_name(statement.get(), column);
          auto value = ColumnJson(statement.get(), column);
          if (name == "sample_counts" && value.IsString())
          {
            value = ParseJson(value.AsString()).value_or(Json{JsonObject{}});
          }
          row.Set(name, std::move(value));
        }
        result.push_back(std::move(row));
      }
      Check(database.get(), status);
    }
    catch (const SqliteError&)
    {
      continue;
    }
    if (result.size() >= p_limit)
    {
      break;
    }
  }
  return result;
}

}  // namespace triangulator::collector
