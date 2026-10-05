#pragma once

#include <algorithm>
#include <expected>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>

#include "json.hpp"
#include "storage.hpp"

namespace triangulator::collector
{

struct ReplayQuery
{
  std::optional<double> at_;
  std::string_view direction_ = "at";
};

// Older day files have only rollups. They cannot reconstruct wait channels
// or the membership of a process, so they are not presented as snapshots.
[[nodiscard]] inline std::expected<bool, std::string> HasSnapshots(
    sqlite3* p_database)
{
  auto statement = Prepare(p_database,
                           "SELECT 1 FROM sqlite_master WHERE type='table' "
                           "AND name='process_snapshot'");
  if (!statement)
  {
    return std::unexpected(std::move(statement.error()));
  }
  const int status = ::sqlite3_step(statement->get());
  if (auto checked = Check(p_database, status); !checked)
  {
    return std::unexpected(std::move(checked.error()));
  }
  return status == SQLITE_ROW;
}

[[nodiscard]] inline std::expected<Json, std::string> ReadReplayDay(
    sqlite3* p_database, const ReplayQuery& p_query)
{
  const auto sql = p_query.direction_ == "next"
                       ? "SELECT snapshot FROM process_snapshot WHERE ts>? "
                         "ORDER BY ts LIMIT 1"
                   : p_query.direction_ == "previous"
                       ? "SELECT snapshot FROM process_snapshot WHERE "
                         "ts<? ORDER BY ts DESC LIMIT 1"
                       : "SELECT snapshot FROM process_snapshot WHERE "
                         "ts<=? ORDER BY ts DESC LIMIT 1";
  auto statement = Prepare(p_database, sql);
  if (!statement)
  {
    return std::unexpected(std::move(statement.error()));
  }
  Binder{statement->get()}.Add(*p_query.at_);
  const int status = ::sqlite3_step(statement->get());
  if (auto checked = Check(p_database, status); !checked)
  {
    return std::unexpected(std::move(checked.error()));
  }
  if (status == SQLITE_DONE)
  {
    return Json(nullptr);
  }
  auto snapshot = ParseJson(ColumnText(statement->get(), 0));
  if (!snapshot || !snapshot->IsObject() ||
      snapshot->Find("recorded_at") == nullptr ||
      !snapshot->Find("recorded_at")->IsNumber() ||
      snapshot->Find("health") == nullptr ||
      !snapshot->Find("health")->IsObject() ||
      snapshot->Find("threads") == nullptr ||
      !snapshot->Find("threads")->IsArray())
  {
    return std::unexpected("invalid stored process snapshot");
  }
  return std::move(*snapshot);
}

struct ReplayBounds
{
  std::optional<double> first_;
  std::optional<double> last_;
};

[[nodiscard]] inline std::expected<ReplayBounds, std::string> ReplayDayBounds(
    sqlite3* p_database)
{
  auto statement =
      Prepare(p_database,
              "SELECT (SELECT ts FROM process_snapshot ORDER BY ts LIMIT 1),"
              "(SELECT ts FROM process_snapshot ORDER BY ts DESC LIMIT 1)");
  if (!statement)
  {
    return std::unexpected(std::move(statement.error()));
  }
  const int status = ::sqlite3_step(statement->get());
  if (auto checked = Check(p_database, status); !checked)
  {
    return std::unexpected(std::move(checked.error()));
  }
  ReplayBounds bounds;
  if (status == SQLITE_ROW)
  {
    const auto first = ColumnJson(statement->get(), 0);
    const auto last = ColumnJson(statement->get(), 1);
    if (first.IsNumber() && last.IsNumber())
    {
      bounds.first_ = first.AsNumber();
      bounds.last_ = last.AsNumber();
    }
  }
  return bounds;
}

// Reads WAL on the HTTP thread. Indexed lookups fetch at most one full
// process view; no historical data is loaded by the receive loop.
[[nodiscard]] inline std::expected<Json, std::string> Replay(
    const std::filesystem::path& p_directory, const ReplayQuery& p_query)
{
  constexpr std::size_t kMaxReplayDayFiles = 3660;
  auto files = DayFiles(p_directory);
  if (files.size() > kMaxReplayDayFiles)
  {
    return std::unexpected("too many day files for replay");
  }
  if (p_query.direction_ != "next")
  {
    std::ranges::reverse(files);
  }
  Json snapshot;
  std::optional<double> first;
  std::optional<double> last;
  for (const auto& path : files)
  {
    auto database = OpenDatabase(path, true);
    if (!database)
    {
      return std::unexpected(std::move(database.error()));
    }
    ::sqlite3_busy_timeout(database->get(), 2000);
    // Bounds and the chosen frame must come from the same WAL read view.
    if (auto begun = Execute(database->get(), "BEGIN"); !begun)
    {
      return std::unexpected(std::move(begun.error()));
    }
    auto available = HasSnapshots(database->get());
    if (!available)
    {
      return std::unexpected(std::move(available.error()));
    }
    if (!*available)
    {
      continue;
    }
    auto bounds = ReplayDayBounds(database->get());
    if (!bounds)
    {
      return std::unexpected(std::move(bounds.error()));
    }
    if (!bounds->first_ || !bounds->last_)
    {
      continue;
    }
    first = std::min(first.value_or(*bounds->first_), *bounds->first_);
    last = std::max(last.value_or(*bounds->last_), *bounds->last_);
    if (!p_query.at_ || !snapshot.IsNull())
    {
      continue;
    }
    auto candidate = ReadReplayDay(database->get(), p_query);
    if (!candidate)
    {
      return std::unexpected(std::move(candidate.error()));
    }
    snapshot = std::move(*candidate);
  }
  return JsonObject{{"first", Json(first)},
                    {"last", Json(last)},
                    {"snapshot", std::move(snapshot)}};
}

}  // namespace triangulator::collector
