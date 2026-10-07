#pragma once

// Replay of the memory map (docs/process-memory-map-design.md, section 8): the
// stored summaries and VMA lists, in the shape of the live /api/memory-map.
// The database is not a continuous record. The sampler reads the memory map
// only while someone watches, so the view shows the newest summary and the
// newest list at or before the requested time, and says how old each is.
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <format>
#include <optional>
#include <string>
#include <vector>

#include "memory_map.hpp"
#include "storage.hpp"

namespace triangulator::collector
{
// How many day files back a replay looks for the newest summary or list.
inline constexpr int kMemoryReplayDays = 8;
// The charts of the replay show this many seconds before the summary.
inline constexpr double kMemoryReplayHistoryS = 3600;

namespace memory_replay_detail
{
[[nodiscard]] inline std::optional<std::int64_t> OptionalInt(
    sqlite3_stmt* p_statement, int p_column)
{
  if (::sqlite3_column_type(p_statement, p_column) == SQLITE_NULL)
  {
    return std::nullopt;
  }
  return ::sqlite3_column_int64(p_statement, p_column);
}

// The day files from the day of p_at back, newest first.
[[nodiscard]] inline std::vector<std::filesystem::path> Files(
    const std::filesystem::path& p_directory, double p_at)
{
  std::vector<std::filesystem::path> files;
  auto day = UtcDay(p_at);
  for (int back = 0; back < kMemoryReplayDays;
       ++back, day -= std::chrono::days{1})
  {
    auto path = p_directory / std::format("{:%F}.sqlite3", day);
    std::error_code error;
    if (std::filesystem::exists(path, error))
    {
      files.push_back(std::move(path));
    }
  }
  return files;
}

struct StoredSummary
{
  double ts_{};
  std::string session_;
  std::uint32_t pid_{};
  std::int64_t flags_{};
  std::vector<std::optional<std::uint64_t>> values_;
};

[[nodiscard]] inline std::string SummaryColumns()
{
  std::string columns = "ts,session,pid,flags";
  for (const auto name : memory_wire::kSummaryFields)
  {
    columns += std::format(",{}", name);
  }
  return columns;
}

[[nodiscard]] inline StoredSummary ReadSummaryRow(sqlite3_stmt* p_statement)
{
  StoredSummary row{.ts_ = ::sqlite3_column_double(p_statement, 0),
                    .session_ = ColumnText(p_statement, 1),
                    .pid_ = static_cast<std::uint32_t>(
                        ::sqlite3_column_int64(p_statement, 2)),
                    .flags_ = ::sqlite3_column_int64(p_statement, 3),
                    .values_ = {}};
  for (std::size_t index = 0; index < memory_wire::kSummaryFields.size();
       ++index)
  {
    const auto value = OptionalInt(p_statement, static_cast<int>(index) + 4);
    row.values_.push_back(
        value && *value >= 0 ? std::optional{static_cast<std::uint64_t>(*value)}
                             : std::nullopt);
  }
  return row;
}

inline void AppendSummary(std::string& p_out, const StoredSummary& p_row)
{
  const auto flag = [&](memory_wire::Flags p_flag)
  {
    return (p_row.flags_ & std::to_underlying(p_flag)) != 0;
  };
  std::format_to(std::back_inserter(p_out),
                 R"({{"received_at":{},"session":"{}","sequence":0,"pid":{},)"
                 R"("truncated":{},"target_absent":{},"maps_unreadable":{},)"
                 R"("status_unreadable":{},"values":{{)",
                 p_row.ts_, p_row.session_, p_row.pid_,
                 flag(memory_wire::Flags::Truncated),
                 flag(memory_wire::Flags::TargetAbsent),
                 flag(memory_wire::Flags::MapsUnreadable),
                 flag(memory_wire::Flags::StatusUnreadable));
  for (std::size_t index = 0; index < memory_wire::kSummaryFields.size();
       ++index)
  {
    const auto name = memory_wire::kSummaryFields[index];
    std::format_to(std::back_inserter(p_out), "{}\"{}\":", index ? "," : "",
                   name);
    AppendSummaryValue(p_out, name, p_row.values_[index]);
  }
  p_out += "}}";
}

// The newest summary at or before p_at, searching the day files in order.
[[nodiscard]] inline std::optional<StoredSummary> FindSummary(
    const std::vector<std::filesystem::path>& p_files, double p_at,
    bool& p_read_error)
{
  for (const auto& path : p_files)
  {
    auto database = OpenDatabase(path, true);
    if (!database)
    {
      p_read_error = true;
      continue;
    }
    ::sqlite3_busy_timeout(database->get(), 200);
    const auto columns = TableColumns(database->get(), "vm_summary");
    if (!columns)
    {
      p_read_error = true;
      continue;
    }
    if (columns->empty())
    {
      continue;  // a day file from before the memory map was enabled
    }
    auto statement = Prepare(
        database->get(),
        std::format("SELECT {} FROM vm_summary WHERE ts<=? ORDER BY ts DESC "
                    "LIMIT 1",
                    SummaryColumns()));
    if (!statement)
    {
      p_read_error = true;
      continue;
    }
    Binder{statement->get()}.Add(p_at);
    if (::sqlite3_step(statement->get()) == SQLITE_ROW)
    {
      return ReadSummaryRow(statement->get());
    }
  }
  return std::nullopt;
}

// Appends the layout object for the newest list of p_pid at or before p_at.
// Returns false when there is none.
[[nodiscard]] inline bool AppendLayout(
    std::string& p_out, const std::vector<std::filesystem::path>& p_files,
    std::optional<std::uint32_t> p_pid, double p_at, bool& p_read_error)
{
  for (const auto& path : p_files)
  {
    auto database = OpenDatabase(path, true);
    if (!database)
    {
      p_read_error = true;
      continue;
    }
    ::sqlite3_busy_timeout(database->get(), 200);
    const auto columns = TableColumns(database->get(), "vm_snapshot");
    if (!columns)
    {
      p_read_error = true;
      continue;
    }
    if (columns->empty())
    {
      continue;
    }
    auto statement = Prepare(
        database->get(),
        "SELECT ts,session,generation,pid,truncated,vma_count,columns,vmas "
        "FROM vm_snapshot WHERE ts<=? AND (?=0 OR pid=?) ORDER BY ts DESC "
        "LIMIT 1");
    if (!statement)
    {
      p_read_error = true;
      continue;
    }
    const std::int64_t pid = p_pid ? *p_pid : 0;
    Binder{statement->get()}.Add(p_at).Add(pid).Add(pid);
    if (::sqlite3_step(statement->get()) != SQLITE_ROW)
    {
      continue;
    }
    auto* query = statement->get();
    const auto stored_columns = ColumnText(query, 6);
    const auto rows = ColumnText(query, 7);
    // The text is sent as stored, like the replay of a process view: parsing
    // and re-encoding a list of 8192 VMAs would only cost time. A damaged
    // value would break the page's JSON, so check the outer shape.
    if (!stored_columns.starts_with('[') || !stored_columns.ends_with(']') ||
        !rows.starts_with('[') || !rows.ends_with(']'))
    {
      p_read_error = true;
      continue;
    }
    std::format_to(
        std::back_inserter(p_out),
        R"({{"received_at":{},"session":"{}","sequence":0,"generation":{},)"
        R"("pid":{},"truncated":{},"vma_count":{},"columns":{},"rows":{}}})",
        ::sqlite3_column_double(query, 0), ColumnText(query, 1),
        ::sqlite3_column_int64(query, 2), ::sqlite3_column_int64(query, 3),
        ::sqlite3_column_int64(query, 4) != 0, ::sqlite3_column_int64(query, 5),
        stored_columns, rows);
    return true;
  }
  return false;
}

// The values of the three charts, from the summaries before p_summary: a
// JSON array of {t, heap, stack, anon, major_faults, minor_faults}.
inline void AppendHistory(std::string& p_out,
                          const std::vector<std::filesystem::path>& p_files,
                          const StoredSummary& p_summary, bool& p_read_error)
{
  std::vector<StoredSummary> rows;
  for (const auto& path : p_files)
  {
    auto database = OpenDatabase(path, true);
    if (!database)
    {
      p_read_error = true;
      continue;
    }
    ::sqlite3_busy_timeout(database->get(), 200);
    const auto columns = TableColumns(database->get(), "vm_summary");
    if (!columns || columns->empty())
    {
      continue;
    }
    auto statement = Prepare(
        database->get(),
        std::format("SELECT {} FROM vm_summary WHERE pid=? AND session=? AND "
                    "ts>? AND ts<=? ORDER BY ts LIMIT 1000",
                    SummaryColumns()));
    if (!statement)
    {
      p_read_error = true;
      continue;
    }
    Binder{statement->get()}
        .Add(std::int64_t{p_summary.pid_})
        .Add(std::string_view{p_summary.session_})
        .Add(p_summary.ts_ - kMemoryReplayHistoryS)
        .Add(p_summary.ts_);
    while (::sqlite3_step(statement->get()) == SQLITE_ROW)
    {
      rows.push_back(ReadSummaryRow(statement->get()));
    }
    if (!rows.empty() &&
        rows.front().ts_ <= p_summary.ts_ - kMemoryReplayHistoryS)
    {
      break;
    }
  }
  std::ranges::sort(rows, {}, &StoredSummary::ts_);
  const auto field = [](const StoredSummary& p_row, std::string_view p_name)
  {
    for (std::size_t index = 0; index < memory_wire::kSummaryFields.size();
         ++index)
    {
      if (memory_wire::kSummaryFields[index] == p_name)
      {
        return p_row.values_[index];
      }
    }
    return std::optional<std::uint64_t>{};
  };
  const auto span = [&](const StoredSummary& p_row, std::string_view p_start,
                        std::string_view p_end) -> std::optional<std::uint64_t>
  {
    const auto start = field(p_row, p_start);
    const auto end = field(p_row, p_end);
    if (start && end && *end >= *start)
    {
      return *end - *start;
    }
    return std::nullopt;
  };
  const auto number =
      [](std::string& p_to, std::optional<std::uint64_t> p_value)
  {
    if (p_value)
    {
      std::format_to(std::back_inserter(p_to), "{}", *p_value);
    }
    else
    {
      p_to += "null";
    }
  };
  p_out += '[';
  for (std::size_t index = 0; index < rows.size(); ++index)
  {
    const auto& row = rows[index];
    std::format_to(std::back_inserter(p_out),
                   "{}{{\"t\":{},\"heap\":", index ? "," : "", row.ts_);
    number(p_out, span(row, "heap_start", "heap_end"));
    p_out += ",\"stack\":";
    number(p_out, span(row, "stack_start", "stack_end"));
    p_out += ",\"anon\":";
    number(p_out, field(row, "rss_anon_bytes"));
    p_out += ",\"major_faults\":";
    number(p_out, field(row, "major_faults"));
    p_out += ",\"minor_faults\":";
    number(p_out, field(row, "minor_faults"));
    p_out += '}';
  }
  p_out += ']';
}
}  // namespace memory_replay_detail

// The memory map as it was at p_at, in the shape of the live /api/memory-map
// plus "replay": when the stored summary and list are from. It is "state":
// "replay"; "summary" and "layout" are null when nothing is stored.
[[nodiscard]] inline std::string MemoryReplay(
    const std::filesystem::path& p_directory, double p_at)
{
  using namespace memory_replay_detail;
  bool read_error = false;
  const auto files = Files(p_directory, p_at);
  const auto summary = FindSummary(files, p_at, read_error);
  std::string body = ",\"summary\":";
  if (summary)
  {
    AppendSummary(body, *summary);
  }
  else
  {
    body += "null";
  }
  body += ",\"layout\":";
  const auto layout_start = body.size();
  if (!AppendLayout(body, files,
                    summary ? std::optional{summary->pid_} : std::nullopt, p_at,
                    read_error))
  {
    body.resize(layout_start);
    body += "null";
  }
  body += ",\"detail\":null,\"history\":";
  if (summary)
  {
    AppendHistory(body, files, *summary, read_error);
  }
  else
  {
    body += "[]";
  }
  return std::format(
      R"({{"enabled":true,"state":"replay","now":{},"replay":{{"at":{},)"
      R"("summary_at":{},"read_error":{}}}{}}})",
      p_at, p_at, summary ? std::format("{}", summary->ts_) : "null",
      read_error, body);
}
}  // namespace triangulator::collector
