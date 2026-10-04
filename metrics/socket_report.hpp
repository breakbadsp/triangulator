#pragma once

// Reporting runs in its own executable against read-only WAL day files.
// No derived socket metrics run in or are stored by the core collector.
#include <set>

#include "../collector/storage.hpp"

namespace triangulator::socket_metrics
{
using collector::Json;
using collector::JsonArray;
using collector::JsonObject;
using Values = std::array<U64, 5>;
inline constexpr std::array<std::string_view, 7> kKinds{
    "Heartbeat",     "TCP IPv4",       "TCP IPv6",          "Unix stream",
    "Unix datagram", "Unix seqpacket", "Application marker"};
inline constexpr std::array<std::string_view, 5> kMetrics{
    "input", "output", "receives", "sends", "messages"};

struct Snapshot
{
  Observation header_{};
  double received_{};
  bool consistent_ = true;
  std::map<U32, Observation> records_;

  void Add(const Observation& p_value, double p_received)
  {
    if (records_.empty())
    {
      header_ = p_value;
    }
    consistent_ = consistent_ && header_.observer_ == p_value.observer_ &&
                  header_.pid_ == p_value.pid_ &&
                  header_.process_start_ == p_value.process_start_ &&
                  header_.started_ns_ == p_value.started_ns_ &&
                  header_.monotonic_ns_ == p_value.monotonic_ns_ &&
                  header_.wall_ns_ == p_value.wall_ns_ &&
                  header_.count_ == p_value.count_ &&
                  header_.flags_ == p_value.flags_ &&
                  header_.losses_ == p_value.losses_;
    received_ = std::max(received_, p_received);
    records_.try_emplace(p_value.index_, p_value);
  }
  bool Complete() const
  {
    if (!consistent_ || records_.size() != header_.count_ ||
        !records_.contains(0))
    {
      return false;
    }
    std::set<std::tuple<U32, U64, U64, U32>> identities;
    for (const auto& [index, record] : records_)
    {
      if (index && !identities
                        .emplace(record.key_.tid_, record.key_.thread_start_,
                                 record.key_.socket_id_, record.key_.kind_)
                        .second)
      {
        return false;
      }
    }
    return true;
  }
};

using Group = std::tuple<U32, U64, U32>;  // tid, thread birth, socket kind
using Groups = std::map<Group, Values>;
inline void Add(Values& p_destination, const Values& p_source)
{
  for (std::size_t index = 0; index < p_destination.size(); ++index)
  {
    if (p_source[index] >
        std::numeric_limits<U64>::max() - p_destination[index])
    {
      throw std::overflow_error("socket counter sum exceeds uint64");
    }
    p_destination[index] += p_source[index];
  }
}
inline Groups Aggregate(const Snapshot& p_snapshot)
{
  Groups groups;
  groups[Group{}] = {};
  for (const auto& [index, record] : p_snapshot.records_)
  {
    if (!index)
    {
      continue;
    }
    const auto& counters = record.counters_;
    const Values values{counters.input_, counters.output_, counters.receives_,
                        counters.sends_, counters.messages_};
    Add(groups[Group{}], values);
    Add(groups[{record.key_.tid_, record.key_.thread_start_,
                record.key_.kind_}],
        values);
  }
  return groups;
}

struct Rates
{
  std::array<double, 5> minimum_{};
  std::array<double, 5> maximum_{};
  std::array<double, 5> latest_{};
  std::size_t windows_{};
  void Observe(const Values& p_before, const Values& p_after, double p_seconds)
  {
    for (std::size_t index = 0; index < p_before.size(); ++index)
    {
      const auto rate =
          static_cast<double>(p_after[index] - p_before[index]) / p_seconds;
      latest_[index] = rate;
      minimum_[index] = windows_ ? std::min(minimum_[index], rate) : rate;
      maximum_[index] = windows_ ? std::max(maximum_[index], rate) : rate;
    }
    ++windows_;
  }
};

inline Json Report(const std::map<U64, Snapshot>& p_snapshots, double p_now,
                   bool p_truncated)
{
  const Snapshot* latest = nullptr;
  for (auto iterator = p_snapshots.rbegin(); iterator != p_snapshots.rend();
       ++iterator)
  {
    if (iterator->second.Complete())
    {
      latest = &iterator->second;
      break;
    }
  }
  if (!latest)
  {
    return JsonObject{
        {"available", false},
        {"reason", p_snapshots.empty()
                       ? "Socket observer not connected"
                       : "Waiting for a complete socket snapshot"}};
  }
  const auto& header = latest->header_;
  const bool messages = (header.flags_ & kMessageEnabled) != 0;
  const bool stopped = (header.flags_ & kStopped) != 0;
  const bool stale = p_now - latest->received_ > 3;
  const double duration =
      static_cast<double>(header.monotonic_ns_ - header.started_ns_) / 1e9;
  const auto groups = Aggregate(*latest);
  std::map<Group, Rates> rates;
  JsonArray history;
  const Snapshot* previous = nullptr;
  Groups before;
  std::size_t gaps = 0;
  bool latest_rate_valid = false;
  for (const auto& [sequence, snapshot] : p_snapshots)
  {
    if (sequence > header.sequence_)
    {
      break;
    }
    if (!snapshot.Complete())
    {
      ++gaps;
      previous = nullptr;
      continue;
    }
    const auto after = Aggregate(snapshot);
    const auto& current = snapshot.header_;
    bool valid = previous &&
                 current.sequence_ == previous->header_.sequence_ + 1 &&
                 current.monotonic_ns_ > previous->header_.monotonic_ns_ &&
                 current.losses_ == previous->header_.losses_ &&
                 current.started_ns_ == previous->header_.started_ns_ &&
                 current.process_start_ == previous->header_.process_start_;
    const double seconds =
        previous && current.monotonic_ns_ > previous->header_.monotonic_ns_
            ? static_cast<double>(current.monotonic_ns_ -
                                  previous->header_.monotonic_ns_) /
                  1e9
            : 0;
    // Nominal one-second windows; delayed scans are unknown, not zero.
    valid = valid && seconds >= 0.8 && seconds <= 1.2;
    for (const auto& [group, values] : before)
    {
      const auto found = after.find(group);
      if (found == after.end())
      {
        valid = false;
        continue;
      }
      for (std::size_t index = 0; index < values.size(); ++index)
      {
        valid = valid && found->second[index] >= values[index];
      }
    }
    if (valid)
    {
      for (const auto& [group, ignored] : groups)
      {
        const auto old = before.find(group);
        const auto next = after.find(group);
        rates[group].Observe(old == before.end() ? Values{} : old->second,
                             next == after.end() ? Values{} : next->second,
                             seconds);
      }
    }
    else if (previous)
    {
      ++gaps;
    }
    Json point = JsonObject{{"ts", static_cast<double>(current.wall_ns_) / 1e9},
                            {"valid", valid}};
    for (std::size_t index = 0; index < kMetrics.size(); ++index)
    {
      point.Set(kMetrics[index], valid && (index != 4 || messages)
                                     ? Json(rates[Group{}].latest_[index])
                                     : Json{});
    }
    history.push_back(std::move(point));
    latest_rate_valid = valid;
    previous = &snapshot;
    before = after;
  }
  const auto metric_json = [&](const Group& p_group, const Values& p_values)
  {
    Json result{JsonObject{}};
    const auto& rate = rates[p_group];
    for (std::size_t index = 0; index < kMetrics.size(); ++index)
    {
      const bool available = index != 4 || messages;
      result.Set(
          kMetrics[index],
          JsonObject{
              {"total",
               available ? Json(std::to_string(p_values[index])) : Json{}},
              {"average",
               available && duration > 0 && !header.losses_
                   ? Json(static_cast<double>(p_values[index]) / duration)
                   : Json{}},
              {"current", available && latest_rate_valid && !stale && !stopped
                              ? Json(rate.latest_[index])
                              : Json{}},
              {"minimum", available && rate.windows_
                              ? Json(rate.minimum_[index])
                              : Json{}},
              {"maximum", available && rate.windows_
                              ? Json(rate.maximum_[index])
                              : Json{}}});
    }
    return result;
  };
  JsonArray rows;
  std::map<Group, std::string> names;
  for (const auto& [index, record] : latest->records_)
  {
    if (index)
    {
      std::array<char, sizeof(record.counters_.name_)> name{};
      std::memcpy(name.data(), record.counters_.name_, name.size());
      names[{record.key_.tid_, record.key_.thread_start_, record.key_.kind_}] =
          collector::ReadName(name);
    }
  }
  for (const auto& [group, values] : groups)
  {
    const auto& [tid, start, kind] = group;
    if (!tid)
    {
      continue;
    }
    rows.push_back(JsonObject{{"tid", tid},
                              {"name", names[group]},
                              {"thread_start", std::to_string(start)},
                              {"kind", kKinds[kind]},
                              {"kind_id", kind},
                              {"metrics", metric_json(group, values)}});
  }
  return JsonObject{
      {"available", true},
      {"observer", std::to_string(header.observer_)},
      {"pid", header.pid_},
      {"process_start", std::to_string(header.process_start_)},
      {"messages_enabled", messages},
      {"stale", stale},
      {"stopped", stopped},
      {"losses", std::to_string(header.losses_)},
      {"lower_bound", header.losses_ != 0},
      {"duration", duration},
      {"updated", latest->received_},
      {"gaps", gaps},
      {"truncated", p_truncated},
      {"window_seconds", 1},
      {"rate_windows", rates[Group{}].windows_},
      {"source", "eBPF socket length tracepoints"},
      {"coverage",
       "Observed socket paths only. UDP, receive splice, bypass paths and "
       "async submitter attribution are not covered. Byte counts follow kernel "
       "operation results; receive truncation can discard additional bytes. "
       "Operations are not application messages."},
      {"totals", metric_json(Group{}, groups.at(Group{}))},
      {"rows", std::move(rows)},
      {"history", std::move(history)}};
}

// Older collector day files legitimately have no socket observations.
[[nodiscard]] inline std::expected<bool, std::string> HasSocketObservations(
    sqlite3* p_database)
{
  auto statement =
      collector::Prepare(p_database,
                         "SELECT 1 FROM sqlite_master WHERE type='table' AND "
                         "name='socket_observation'");
  if (!statement)
  {
    return std::unexpected(std::move(statement.error()));
  }
  const int status = ::sqlite3_step(statement->get());
  if (auto checked = collector::Check(p_database, status); !checked)
  {
    return std::unexpected(std::move(checked.error()));
  }
  return status == SQLITE_ROW;
}

struct LatestObservation
{
  std::string observer_;
  double received_{};
};

// The observer of the newest heartbeat in one day file, or nullopt when the
// file has none.
[[nodiscard]] inline std::expected<std::optional<LatestObservation>,
                                   std::string>
FindLatestObserver(const std::filesystem::path& p_path, U32 p_pid)
{
  using namespace collector;
  auto database = OpenDatabase(p_path, true);
  if (!database)
  {
    return std::unexpected(std::move(database.error()));
  }
  const auto has_table = HasSocketObservations(database->get());
  if (!has_table)
  {
    return std::unexpected(has_table.error());
  }
  if (!*has_table)
  {
    return std::nullopt;
  }
  auto statement =
      Prepare(database->get(),
              p_pid ? "SELECT observer,received FROM socket_observation WHERE "
                      "part=0 AND pid=? ORDER BY received DESC LIMIT 1"
                    : "SELECT observer,received FROM socket_observation WHERE "
                      "part=0 ORDER BY received DESC LIMIT 1");
  if (!statement)
  {
    return std::unexpected(std::move(statement.error()));
  }
  if (p_pid)
  {
    Binder{statement->get()}.Add(std::int64_t{p_pid});
  }
  const int status = ::sqlite3_step(statement->get());
  if (status == SQLITE_ROW)
  {
    return LatestObservation{ColumnText(statement->get(), 0),
                             ::sqlite3_column_double(statement->get(), 1)};
  }
  if (auto checked = Check(database->get(), status); !checked)
  {
    return std::unexpected(std::move(checked.error()));
  }
  return std::nullopt;
}

// Adds one day file's packets for p_observer to p_snapshots, newest
// sequence first, until 61 sequences or p_remaining datagrams are read.
// Packets that don't decode set p_read_error.
[[nodiscard]] inline collector::SqliteResult ReadSnapshots(
    const std::filesystem::path& p_path, std::string_view p_observer, U32 p_pid,
    std::map<U64, Snapshot>& p_snapshots, U64& p_newest,
    std::size_t& p_remaining, bool& p_read_error)
{
  using namespace collector;
  auto database = OpenDatabase(p_path, true);
  if (!database)
  {
    return std::unexpected(std::move(database.error()));
  }
  const auto has_table = HasSocketObservations(database->get());
  if (!has_table)
  {
    return std::unexpected(has_table.error());
  }
  if (!*has_table)
  {
    return {};
  }
  ::sqlite3_busy_timeout(database->get(), 100);
  auto statement = Prepare(
      database->get(),
      "SELECT packet,received FROM socket_observation WHERE observer=? AND "
      "(?=0 OR pid=?) AND sequence>=? ORDER BY sequence DESC,part LIMIT ?");
  if (!statement)
  {
    return std::unexpected(std::move(statement.error()));
  }
  auto* query = statement->get();
  Binder{query}
      .Add(p_observer)
      .Add(std::int64_t{p_pid})
      .Add(std::int64_t{p_pid})
      .Add(static_cast<std::int64_t>(p_newest > 60 ? p_newest - 60 : 0))
      .Add(static_cast<std::int64_t>(p_remaining));
  int status = SQLITE_DONE;
  while ((status = ::sqlite3_step(query)) == SQLITE_ROW)
  {
    --p_remaining;
    const auto* data =
        static_cast<const std::byte*>(::sqlite3_column_blob(query, 0));
    const auto size =
        static_cast<std::size_t>(::sqlite3_column_bytes(query, 0));
    const auto value = Decode(std::span{data, size});
    if (!value)
    {
      p_read_error = true;
      continue;
    }
    p_newest = std::max(p_newest, value->sequence_);
    if (p_newest - value->sequence_ > 60)
    {
      break;
    }
    p_snapshots[value->sequence_].Add(*value,
                                      ::sqlite3_column_double(query, 1));
  }
  if (status != SQLITE_ROW)
  {
    return Check(database->get(), status);
  }
  return {};
}

// True when every snapshot in the requested window is complete.
[[nodiscard]] inline bool Covered(const std::map<U64, Snapshot>& p_snapshots,
                                  U64 p_newest)
{
  for (U64 sequence = p_newest > 60 ? p_newest - 60 : 0; sequence <= p_newest;
       ++sequence)
  {
    const auto found = p_snapshots.find(sequence);
    if (found == p_snapshots.end() || !found->second.Complete())
    {
      return false;
    }
  }
  return true;
}

// Bound query work: latest 61 sequences, at most 250,000 raw datagrams. Totals
// are lifetime cumulative; rate extrema concern only this recent window.
// Day files that cannot be read set "read_error" and are skipped.
inline Json SocketReport(const std::filesystem::path& p_directory, U32 p_pid,
                         std::string_view p_observer, double p_now)
{
  using namespace collector;
  std::string observer{p_observer};
  const auto files = DayFiles(p_directory);
  bool read_error = false;
  if (observer.empty())
  {
    for (auto iterator = files.rbegin(); iterator != files.rend(); ++iterator)
    {
      const auto latest = FindLatestObserver(*iterator, p_pid);
      if (!latest)
      {
        read_error = true;
        continue;
      }
      if (*latest)
      {
        observer = (*latest)->observer_;
        break;  // Day files are organized by collector receipt time.
      }
    }
  }
  if (observer.empty())
  {
    return JsonObject{{"available", false},
                      {"reason",
                       "Socket observer not connected. Start the optional "
                       "socket sampler to measure I/O."},
                      {"read_error", read_error}};
  }
  std::map<U64, Snapshot> snapshots;
  std::size_t remaining = 250000;
  U64 newest = 0;
  for (auto iterator = files.rbegin(); iterator != files.rend() && remaining;
       ++iterator)
  {
    if (!ReadSnapshots(*iterator, observer, p_pid, snapshots, newest, remaining,
                       read_error))
    {
      read_error = true;
      continue;
    }
    // Keep looking across midnight until every requested snapshot is
    // complete.
    if (Covered(snapshots, newest))
    {
      break;
    }
  }
  auto result = Report(snapshots, p_now, remaining == 0);
  result.Set("read_error", read_error);
  return result;
}
}  // namespace triangulator::socket_metrics
