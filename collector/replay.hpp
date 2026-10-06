#pragma once

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <expected>
#include <filesystem>
#include <format>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <thread>

#include "json.hpp"
#include "log.hpp"
#include "storage.hpp"

namespace triangulator::collector
{

// Recorded dashboard views live in their own day files under
// data_dir/replay. The recorder thread writes them, so it never contends
// with the main loop's transactions on the rollup day files.
[[nodiscard]] inline std::filesystem::path ReplayDirectory(
    const std::filesystem::path& p_data_dir)
{
  return p_data_dir / "replay";
}

inline constexpr std::string_view kReplaySchema = R"(
CREATE TABLE IF NOT EXISTS process_snapshot (
 ts REAL PRIMARY KEY NOT NULL, snapshot TEXT NOT NULL
);
)";

// Writes recorded views to replay day files, one autocommitted row each,
// and deletes files older than the retention period. Used by one thread.
class ReplayWriter
{
 public:
  [[nodiscard]] static std::expected<ReplayWriter, std::string> Create(
      std::filesystem::path p_directory, std::int64_t p_retention_days)
  {
    std::error_code error;
    std::filesystem::create_directories(p_directory, error);
    if (error)
    {
      return std::unexpected(std::format(
          "cannot create {}: {}", p_directory.string(), error.message()));
    }
    return ReplayWriter{std::move(p_directory), p_retention_days};
  }

  [[nodiscard]] SqliteResult Write(double p_timestamp,
                                   std::string_view p_snapshot)
  {
    const auto day = UtcDay(p_timestamp);
    if (day_ != day || !database_)
    {
      if (auto opened = Open(day); !opened)
      {
        return opened;
      }
    }
    Binder{insert_.get()}.Add(p_timestamp).Add(p_snapshot);
    auto written = Run(database_.get(), insert_.get());
    if (!written)
    {
      // Reopen on the next write, so a cleared fault (a full disk that
      // gained space) recovers without a restart.
      insert_.reset();
      database_.reset();
    }
    return written;
  }

 private:
  std::filesystem::path directory_;
  std::int64_t retention_days_;
  std::optional<Days> day_;
  Database database_;
  Statement insert_;

  ReplayWriter(std::filesystem::path p_directory, std::int64_t p_retention_days)
      : directory_(std::move(p_directory)), retention_days_(p_retention_days)
  {
  }

  [[nodiscard]] SqliteResult Open(Days p_day)
  {
    insert_.reset();
    database_.reset();
    if (day_ != p_day)
    {
      Prune(p_day);
    }
    day_ = p_day;
    auto opened =
        OpenDatabase(directory_ / (DayName(p_day) + ".sqlite3"), false);
    if (!opened)
    {
      return std::unexpected(std::move(opened.error()));
    }
    ::sqlite3_busy_timeout(opened->get(), 1000);
    // WAL lets the dashboard read while this thread writes. NORMAL skips
    // the fsync per row; a crash loses at most the last few recordings.
    for (const std::string_view sql :
         {std::string_view{"PRAGMA journal_mode=WAL"},
          std::string_view{"PRAGMA synchronous=NORMAL"}, kReplaySchema})
    {
      if (auto executed = Execute(opened->get(), sql); !executed)
      {
        return executed;
      }
    }
    auto insert = Prepare(
        opened->get(), "INSERT OR REPLACE INTO process_snapshot VALUES (?,?)");
    if (!insert)
    {
      return std::unexpected(std::move(insert.error()));
    }
    database_ = std::move(*opened);
    insert_ = std::move(*insert);
    return {};
  }

  void Prune(Days p_today) const
  {
    const auto cutoff =
        p_today - std::chrono::days{static_cast<int>(retention_days_ - 1)};
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
  }
};

// Records the dashboard view on its own thread. The main loop only hands
// over the view it already serialized for /api/live; it never waits for
// SQLite. If the writer falls behind, a newer view replaces the waiting
// one. A failed write is logged and the next view is tried again: an
// optional recording must not stop the collector.
class SnapshotRecorder
{
 public:
  SnapshotRecorder(std::filesystem::path p_data_dir,
                   std::int64_t p_retention_days, double p_interval_s)
      : directory_(ReplayDirectory(p_data_dir)),
        retention_days_(p_retention_days),
        interval_(
            std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                std::chrono::duration<double>{p_interval_s}))
  {
  }
  ~SnapshotRecorder()
  {
    Stop();
  }
  SnapshotRecorder(const SnapshotRecorder&) = delete;
  SnapshotRecorder& operator=(const SnapshotRecorder&) = delete;

  // Starts the writer thread, unless recording is disabled. std::jthread
  // reports failure by throwing; it is caught here and returned.
  [[nodiscard]] std::expected<void, std::string> Start()
  {
    if (interval_ <= std::chrono::steady_clock::duration::zero())
    {
      return {};
    }
    try
    {
      worker_ = std::jthread(
          [this](std::stop_token p_stop)
          {
            Work(p_stop);
          });
    }
    catch (const std::system_error& error)
    {
      return std::unexpected(
          std::format("cannot start the recording thread: {}", error.what()));
    }
    return {};
  }

  // Writes the waiting view, if any, then ends the thread.
  void Stop()
  {
    if (!worker_.joinable())
    {
      return;
    }
    {
      const std::scoped_lock lock{mutex_};
      worker_.request_stop();
    }
    ready_.notify_all();
    worker_.join();
  }

  // Called by the main loop on every refresh; keeps one view per interval.
  void Offer(double p_timestamp, std::shared_ptr<const std::string> p_view)
  {
    if (!worker_.joinable())
    {
      return;
    }
    const auto now = std::chrono::steady_clock::now();
    if (now < next_offer_)
    {
      return;
    }
    next_offer_ = now + interval_;
    {
      const std::scoped_lock lock{mutex_};
      pending_ = Pending{p_timestamp, std::move(p_view)};
    }
    ready_.notify_one();
  }

 private:
  struct Pending
  {
    double timestamp_{};
    std::shared_ptr<const std::string> view_;
  };
  std::filesystem::path directory_;
  std::int64_t retention_days_;
  std::chrono::steady_clock::duration interval_;
  // Read and written by the main loop only.
  std::chrono::steady_clock::time_point next_offer_{};
  std::mutex mutex_;
  std::condition_variable ready_;
  std::optional<Pending> pending_;
  std::jthread worker_;

  void Work(std::stop_token p_stop)
  {
    std::optional<ReplayWriter> writer;
    bool failing = false;
    while (true)
    {
      Pending pending;
      {
        std::unique_lock lock{mutex_};
        ready_.wait(lock,
                    [&]
                    {
                      return p_stop.stop_requested() || pending_.has_value();
                    });
        if (!pending_)
        {
          return;
        }
        pending = std::move(*pending_);
        pending_.reset();
      }
      SqliteResult written;
      try
      {
        if (!writer)
        {
          auto created = ReplayWriter::Create(directory_, retention_days_);
          if (created)
          {
            writer = std::move(*created);
          }
          else
          {
            written = std::unexpected(std::move(created.error()));
          }
        }
        if (writer)
        {
          written = writer->Write(pending.timestamp_, *pending.view_);
        }
      }
      catch (const std::exception& error)
      {
        // Last resort for this unit of work (a bug or an exception from the
        // standard library): skip this recording.
        written = std::unexpected(std::string{error.what()});
      }
      // Log changes of state only, not one line per second while failing.
      if (!written && !failing)
      {
        Log(LogLevel::Warning,
            std::format("Dashboard recording failed, will keep trying: {}",
                        written.error()));
      }
      else if (written && failing)
      {
        Log(LogLevel::Info, "Dashboard recording resumed");
      }
      failing = !written;
    }
  }
};

struct ReplayResult
{
  std::optional<double> first_;
  std::optional<double> last_;
  // The stored view, as the collector serialized it, or nullopt.
  std::optional<std::string> snapshot_;
};

struct ReplayQuery
{
  std::optional<double> at_;
  std::string_view direction_ = "at";
};

// Opens a replay day file read-only for one query.
[[nodiscard]] inline std::expected<Database, std::string> OpenReplayDay(
    const std::filesystem::path& p_path)
{
  auto database = OpenDatabase(p_path, true);
  if (database)
  {
    ::sqlite3_busy_timeout(database->get(), 200);
  }
  return database;
}

// Runs a one-row query and returns its first column. nullopt when there is
// no row, the value is NULL or the file can't be read.
[[nodiscard]] inline std::optional<Json> ReadOne(
    const std::filesystem::path& p_path, std::string_view p_sql,
    std::optional<double> p_at = std::nullopt)
{
  auto database = OpenReplayDay(p_path);
  if (!database)
  {
    return std::nullopt;
  }
  auto statement = Prepare(database->get(), p_sql);
  if (!statement)
  {
    return std::nullopt;
  }
  if (p_at)
  {
    Binder{statement->get()}.Add(*p_at);
  }
  if (::sqlite3_step(statement->get()) != SQLITE_ROW)
  {
    return std::nullopt;
  }
  auto value = ColumnJson(statement->get(), 0);
  if (value.IsNull())
  {
    return std::nullopt;
  }
  return value;
}

// Reads on the HTTP thread. Day files are named by UTC day, so the search
// starts at the requested day and stops at the first match; the bounds
// need only the oldest and newest readable files. A file that can't be
// read (deleted by retention mid-request, damaged, still being created) is
// skipped, like History() does.
[[nodiscard]] inline ReplayResult Replay(
    const std::filesystem::path& p_data_dir, const ReplayQuery& p_query)
{
  auto files = DayFiles(ReplayDirectory(p_data_dir));
  ReplayResult result;
  if (p_query.at_)
  {
    const bool next = p_query.direction_ == "next";
    const auto sql = next ? "SELECT snapshot FROM process_snapshot WHERE ts>? "
                            "ORDER BY ts LIMIT 1"
                     : p_query.direction_ == "previous"
                         ? "SELECT snapshot FROM process_snapshot WHERE ts<? "
                           "ORDER BY ts DESC LIMIT 1"
                         : "SELECT snapshot FROM process_snapshot WHERE ts<=? "
                           "ORDER BY ts DESC LIMIT 1";
    const auto day = DayName(UtcDay(*p_query.at_));
    const auto search = [&](auto p_begin, auto p_end)
    {
      for (auto iterator = p_begin; iterator != p_end; ++iterator)
      {
        const auto stem = iterator->stem().string();
        if (next ? stem < day : stem > day)
        {
          continue;
        }
        auto found = ReadOne(*iterator, sql, p_query.at_);
        // The collector wrote the text with DumpJson; a row that isn't a
        // JSON object is damage, and that file is skipped.
        if (found && found->IsString() && found->AsString().starts_with('{'))
        {
          result.snapshot_ = found->AsString();
          return;
        }
      }
    };
    if (next)
    {
      search(files.begin(), files.end());
    }
    else
    {
      search(files.rbegin(), files.rend());
    }
  }
  // After the snapshot, so the bounds include it even while recording.
  for (const auto& path : files)
  {
    if (auto first = ReadOne(path, "SELECT min(ts) FROM process_snapshot");
        first && first->IsNumber())
    {
      result.first_ = first->AsNumber();
      break;
    }
  }
  for (auto iterator = files.rbegin(); iterator != files.rend(); ++iterator)
  {
    if (auto last = ReadOne(*iterator, "SELECT max(ts) FROM process_snapshot");
        last && last->IsNumber())
    {
      result.last_ = last->AsNumber();
      break;
    }
  }
  return result;
}

}  // namespace triangulator::collector
