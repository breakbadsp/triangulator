#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <deque>
#include <format>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "config.hpp"
#include "json.hpp"
#include "protocol.hpp"
#include "storage.hpp"

namespace triangulator::collector
{

// p_now - p_before for cumulative counters, as a signed integer. Counters
// that went backwards give a negative value, as in Python.
[[nodiscard]] inline std::int64_t Delta(std::uint64_t p_now,
                                        std::uint64_t p_before) noexcept
{
  return static_cast<std::int64_t>(p_now - p_before);
}

[[nodiscard]] inline std::uint64_t CpuTicks(const Record& p_record) noexcept
{
  return p_record.utime_ + p_record.stime_;
}

// True when a cumulative counter went backwards: the tid now belongs to a
// new thread.
[[nodiscard]] inline bool CountersRegressed(const Record& p_current,
                                            const Record& p_previous) noexcept
{
  const auto now = p_current.Counters();
  const auto before = p_previous.Counters();
  for (std::size_t index = 0; index < now.size(); ++index)
  {
    if (now[index] < before[index])
    {
      return true;
    }
  }
  return p_current.HasIo() && p_previous.HasIo() &&
         (p_current.read_bytes_ < p_previous.read_bytes_ ||
          p_current.write_bytes_ < p_previous.write_bytes_);
}

// Bytes per second between two samples, or nullopt if either lacks I/O data.
// p_write selects written bytes instead of read bytes.
[[nodiscard]] inline std::optional<double> IoRate(const Record& p_current,
                                                  const Record& p_previous,
                                                  bool p_write,
                                                  double p_elapsed)
{
  if (p_elapsed <= 0 || !p_current.HasIo() || !p_previous.HasIo())
  {
    return std::nullopt;
  }
  const auto delta =
      p_write ? Delta(p_current.write_bytes_, p_previous.write_bytes_)
              : Delta(p_current.read_bytes_, p_previous.read_bytes_);
  return static_cast<double>(delta) / p_elapsed;
}

struct Sample
{
  double monotonic_{};
  double wall_{};
  double interval_{};
  bool fallback_{};
  // Shared by the raw history, the open window and the latest sample.
  std::shared_ptr<const Record> record_;
  std::string_view state_;

  [[nodiscard]] const Record& Get() const noexcept
  {
    return *record_;
  }
};

struct ThreadState
{
  std::string group_;
  std::int64_t generation_{};
  Sample latest_;
  std::deque<Sample> raw_;
  std::vector<Sample> window_;
  std::optional<Sample> baseline_;
  std::optional<std::int64_t> bucket_;
};

// State counts in order of first appearance, like Python's Counter.
using StateCounts = std::vector<std::pair<std::string_view, std::int64_t>>;

inline void CountState(StateCounts& p_counts, std::string_view p_state)
{
  for (auto& [state, count] : p_counts)
  {
    if (state == p_state)
    {
      ++count;
      return;
    }
  }
  p_counts.emplace_back(p_state, 1);
}

[[nodiscard]] inline Json CountsJson(const StateCounts& p_counts)
{
  Json result{JsonObject{}};
  for (const auto& [state, count] : p_counts)
  {
    result.AsObject().emplace_back(std::string{state}, count);
  }
  return result;
}

// The text Python's json.dumps writes for a dict, so stored rows match.
[[nodiscard]] inline std::string PythonCountsText(const StateCounts& p_counts)
{
  std::string text = "{";
  for (const auto& [state, count] : p_counts)
  {
    if (text.size() > 1)
    {
      text += ", ";
    }
    DumpString(state, text);
    text += std::format(": {}", count);
  }
  text += '}';
  return text;
}

// Turns sampler datagrams into per-thread state, rollup rows and the live
// dashboard snapshot. Alerting is not done here: it is a separate program
// that reads the rollups (SQLite) or the HTTP API.
class Monitor
{
 public:
  Monitor(const Config& p_config, Storage& p_storage, double p_now)
      : config_(p_config), storage_(p_storage), started_(p_now)
  {
  }

  std::int64_t bad_packets_ = 0;

  void Accept(Packet p_packet, double p_received)
  {
    if (!session_ || p_packet.session_ != *session_)
    {
      if (std::ranges::find(retired_sessions_, p_packet.session_) !=
          retired_sessions_.end())
      {
        ++late_packets_;
        return;
      }
      if (session_)
      {
        retired_sessions_.push_back(*session_);
        if (retired_sessions_.size() > 128)
        {
          retired_sessions_.pop_front();
        }
        Drain(p_received, true);
        for (auto& [tid, thread] : threads_)
        {
          FinishWindow(tid, thread);
        }
      }
      session_ = p_packet.session_;
      session_text_ = std::to_string(*session_);
      threads_.clear();
      generations_.clear();
      raw_count_ = 0;
      pending_.clear();
      last_monotonic_.reset();
      last_sequence_.reset();
      loss_.clear();
    }
    if (last_monotonic_ && p_packet.monotonic_ns_ <= *last_monotonic_)
    {
      ++late_packets_;
      return;
    }
    const auto key = p_packet.sequence_;
    auto found = pending_.find(key);
    if (found == pending_.end())
    {
      if (pending_.size() >= 128)
      {
        Drain(p_received, true);
        if (last_monotonic_ && p_packet.monotonic_ns_ <= *last_monotonic_)
        {
          ++late_packets_;
          return;
        }
      }
      Tick tick;
      tick.header_ = p_packet;
      tick.header_.records_.clear();
      tick.received_ = p_received;
      tick.order_ = next_tick_order_++;
      found = pending_.emplace(key, std::move(tick)).first;
    }
    auto& tick = found->second;
    if (!p_packet.SameTick(tick.header_))
    {
      ++bad_packets_;
      return;
    }
    if (tick.chunks_.contains(p_packet.chunk_))
    {
      ++duplicates_;
      return;
    }
    for (const auto& [chunk, records] : tick.chunks_)
    {
      for (const auto& existing : records)
      {
        for (const auto& record : p_packet.records_)
        {
          if (record.tid_ == existing.tid_)
          {
            ++bad_packets_;
            return;
          }
        }
      }
    }
    tick.chunks_.emplace(p_packet.chunk_, std::move(p_packet.records_));
    last_seen_ = p_received;
  }

  // Processes buffered ticks, oldest first, once their chunks have had time
  // to arrive (or immediately when p_force is set).
  void Drain(double p_now, bool p_force = false)
  {
    std::vector<std::uint32_t> ordered;
    ordered.reserve(pending_.size());
    for (const auto& [key, tick] : pending_)
    {
      ordered.push_back(key);
    }
    std::ranges::sort(
        ordered,
        [&](std::uint32_t p_left, std::uint32_t p_right)
        {
          const auto& left = pending_.at(p_left);
          const auto& right = pending_.at(p_right);
          return std::pair{left.header_.monotonic_ns_, left.order_} <
                 std::pair{right.header_.monotonic_ns_, right.order_};
        });
    for (const auto key : ordered)
    {
      auto found = pending_.find(key);
      const auto& header = found->second.header_;
      const double grace =
          std::max(0.25, std::min(2.0, 2.0 * header.interval_ms_ / 1000.0));
      if (!p_force && p_now - found->second.received_ < grace)
      {
        break;
      }
      Tick tick = std::move(found->second);
      pending_.erase(found);
      if (last_monotonic_ && tick.header_.monotonic_ns_ <= *last_monotonic_)
      {
        continue;
      }
      std::int64_t missing_ticks = 0;
      if (last_sequence_)
      {
        const std::uint32_t distance = tick.header_.sequence_ - *last_sequence_;
        if (distance == 0 || distance > 0x7FFFFFFFu)
        {
          ++late_packets_;
          continue;
        }
        missing_ticks = distance - 1;
      }
      const std::int64_t expected = tick.header_.chunks_ * (missing_ticks + 1);
      loss_.push_back(
          {tick.received_, expected,
           expected - static_cast<std::int64_t>(tick.chunks_.size())});
      last_sequence_ = tick.header_.sequence_;
      last_monotonic_ = tick.header_.monotonic_ns_;
      std::vector<Record> records;
      for (auto& [chunk, chunk_records] : tick.chunks_)
      {
        std::ranges::move(chunk_records, std::back_inserter(records));
      }
      Process(tick.header_, std::move(records), tick.received_,
              tick.chunks_.size() == tick.header_.chunks_);
    }
  }

  // Monitor health for the dashboard: sampler silence, estimated packet
  // loss over the last minute and packet counters.
  [[nodiscard]] Json Health(double p_now)
  {
    Drain(p_now);
    while (!loss_.empty() && loss_.front().received_ < p_now - 60)
    {
      loss_.pop_front();
    }
    std::int64_t expected = 0;
    std::int64_t lost = 0;
    for (const auto& item : loss_)
    {
      expected += item.expected_;
      lost += item.lost_;
    }
    const Json loss_pct = expected != 0
                              ? Json(static_cast<double>(lost) /
                                     static_cast<double>(expected) * 100)
                              : Json(0);
    // The sampler_silent alert rule's default threshold, used only for the
    // dashboard's "Silent" card; the collector has no alert rules.
    constexpr double kSilentSecs = 10;
    const bool silent = p_now - last_seen_.value_or(started_) >= kSilentSecs;
    return JsonObject{
        {"last_seen", Json(last_seen_)},
        {"sampler_silent", silent},
        {"target_absent", Json(target_absent_)},
        {"packet_loss_pct", loss_pct},
        {"session", session_ ? Json(session_text_) : Json(nullptr)},
        {"pid", pid_},
        {"bad_packets", bad_packets_},
        {"duplicates", duplicates_},
        {"late_packets", late_packets_},
        {"raw_samples", raw_count_},
        {"sample_interval_ms",
         static_cast<std::int64_t>(std::nearbyint(interval_ * 1000))}};
  }

  // Current threads and group counts. There are no "alerts" fields; the
  // dashboard hides its alert sections when they are missing.
  [[nodiscard]] Json Snapshot(double p_now) const
  {
    JsonArray threads;
    StateCounts groups;
    for (const auto& [tid, thread] : threads_)
    {
      const auto& sample = thread.latest_;
      // Raw samples are in time order, so the last ten seconds are a suffix.
      const auto begin = std::ranges::partition_point(
          thread.raw_,
          [&](const Sample& p_item)
          {
            return p_item.monotonic_ < sample.monotonic_ - 10;
          });
      StateCounts counts;
      for (auto iterator = begin; iterator != thread.raw_.end(); ++iterator)
      {
        CountState(counts, iterator->state_);
      }
      const auto& first = begin != thread.raw_.end() ? *begin : sample;
      const double elapsed = sample.monotonic_ - first.monotonic_;
      const auto& current = sample.Get();
      const auto& previous = first.Get();
      const auto rate = [&](std::uint64_t p_now_value,
                            std::uint64_t p_previous_value,
                            double p_scale) -> std::optional<double>
      {
        if (elapsed <= 0)
        {
          return std::nullopt;
        }
        return static_cast<double>(Delta(p_now_value, p_previous_value)) /
               p_scale / elapsed;
      };
      std::optional<double> cpu_pct;
      if (elapsed > 0)
      {
        cpu_pct =
            static_cast<double>(Delta(CpuTicks(current), CpuTicks(previous))) /
            static_cast<double>(config_.clock_ticks_) / elapsed * 100;
      }
      std::optional<double> run_delay;
      if (!sample.fallback_ && elapsed > 0)
      {
        run_delay = *rate(current.run_delay_, previous.run_delay_, 1e9) * 100;
      }
      CountState(groups, thread.group_);
      threads.emplace_back(JsonObject{
          {"tid", tid},
          {"name", current.comm_},
          {"group", thread.group_},
          {"state", sample.state_},
          {"wchan", current.wchan_},
          {"cpu", current.processor_},
          {"cpu_pct", Json(cpu_pct)},
          {"state_mix", CountsJson(counts)},
          {"run_delay_pct", Json(run_delay)},
          {"switches_per_s",
           Json(rate(current.timeslices_, previous.timeslices_, 1.0))},
          {"major_faults_per_s",
           Json(rate(current.major_faults_, previous.major_faults_, 1.0))},
          {"read_bps", Json(IoRate(current, previous, false, elapsed))},
          {"write_bps", Json(IoRate(current, previous, true, elapsed))},
          {"last_sample", sample.wall_},
          {"stale", p_now - sample.wall_ > std::max(10.0, interval_ * 3)},
          {"generation", thread.generation_}});
    }
    return JsonObject{{"threads", std::move(threads)},
                      {"groups", CountsJson(groups)}};
  }

  void Close()
  {
    Drain(last_seen_.value_or(started_), true);
    for (auto& [tid, thread] : threads_)
    {
      FinishWindow(tid, thread);
    }
  }

 private:
  struct Tick
  {
    Packet header_;
    double received_{};
    std::uint64_t order_{};
    std::map<std::uint8_t, std::vector<Record>> chunks_;
  };

  struct LossEntry
  {
    double received_;
    std::int64_t expected_;
    std::int64_t lost_;
  };

  const Config& config_;
  Storage& storage_;
  double started_;
  std::optional<double> last_seen_;
  std::optional<std::uint64_t> session_;
  std::string session_text_;
  std::deque<std::uint64_t> retired_sessions_;
  std::map<std::int64_t, ThreadState> threads_;
  std::map<std::uint32_t, Tick> pending_;
  std::uint64_t next_tick_order_ = 0;
  std::optional<std::uint64_t> last_monotonic_;
  std::optional<std::uint32_t> last_sequence_;
  std::deque<LossEntry> loss_;
  std::optional<bool> target_absent_;
  std::uint32_t pid_ = 0;
  double interval_ = 1.0;
  std::int64_t duplicates_ = 0;
  std::int64_t late_packets_ = 0;
  std::int64_t raw_count_ = 0;
  std::map<std::int64_t, std::int64_t> generations_;

  [[nodiscard]] const std::string& GroupFor(std::string_view p_name) const
  {
    static const std::string kUngrouped = "ungrouped";
    for (const auto& group : config_.groups_)
    {
      if (p_name.starts_with(group.prefix_))
      {
        return group.name_;
      }
    }
    return kUngrouped;
  }

  void Process(const Packet& p_header, std::vector<Record> p_records,
               double p_received, bool p_complete)
  {
    interval_ = p_header.interval_ms_ / 1000.0;
    pid_ = p_header.pid_;
    target_absent_ = (p_header.flags_ & kTargetAbsent) != 0;
    const double monotonic = static_cast<double>(p_header.monotonic_ns_) / 1e9;
    double wall = static_cast<double>(p_header.wall_ns_) / 1e9;
    if (std::fabs(wall - p_received) > 86400)
    {
      wall = p_received;
    }
    const bool fallback = (p_header.flags_ & kStatusFallback) != 0;
    std::set<std::int64_t> seen;
    for (auto& record_value : p_records)
    {
      const std::int64_t tid = record_value.tid_;
      seen.insert(tid);
      auto record = std::make_shared<const Record>(std::move(record_value));
      Sample sample{monotonic, wall,   interval_,
                    fallback,  record, Classify(*record)};
      const auto& group = GroupFor(record->comm_);
      auto found = threads_.find(tid);
      if (found != threads_.end())
      {
        auto& existing = found->second;
        const bool reset = CountersRegressed(*record, existing.latest_.Get()) ||
                           existing.latest_.fallback_ != sample.fallback_ ||
                           existing.group_ != group;
        if (reset)
        {
          FinishWindow(tid, existing);
          raw_count_ -= static_cast<std::int64_t>(existing.raw_.size());
          threads_.erase(found);
          found = threads_.end();
        }
      }
      if (found == threads_.end())
      {
        auto generation = generations_.find(tid);
        const std::int64_t next =
            generation == generations_.end() ? 0 : generation->second + 1;
        generations_[tid] = next;
        ThreadState state;
        state.group_ = group;
        state.generation_ = next;
        state.latest_ = sample;
        found = threads_.emplace(tid, std::move(state)).first;
      }
      auto& thread = found->second;
      const auto bucket =
          static_cast<std::int64_t>(std::floor(monotonic / config_.window_s_));
      if (thread.bucket_ && bucket != *thread.bucket_)
      {
        FinishWindow(tid, thread);
        if (bucket != *thread.bucket_ + 1)
        {
          thread.baseline_.reset();
        }
      }
      thread.bucket_ = bucket;
      thread.latest_ = sample;
      thread.raw_.push_back(sample);
      ++raw_count_;
      thread.window_.push_back(sample);
      storage_.Raw(wall, session_text_, *record);
    }
    if (p_complete)
    {
      std::vector<std::int64_t> gone;
      for (const auto& [tid, thread] : threads_)
      {
        if (!seen.contains(tid))
        {
          gone.push_back(tid);
        }
      }
      for (const auto tid : gone)
      {
        RemoveThread(tid);
      }
    }
    std::vector<std::int64_t> unobserved;
    for (const auto& [tid, thread] : threads_)
    {
      if (monotonic - thread.latest_.monotonic_ > std::max(10.0, 3 * interval_))
      {
        unobserved.push_back(tid);
      }
    }
    for (const auto tid : unobserved)
    {
      RemoveThread(tid);
    }
    PruneRaw(monotonic);
  }

  void RemoveThread(std::int64_t p_tid)
  {
    auto found = threads_.find(p_tid);
    FinishWindow(p_tid, found->second);
    raw_count_ -= static_cast<std::int64_t>(found->second.raw_.size());
    threads_.erase(found);
  }

  void PruneRaw(double p_monotonic)
  {
    for (auto& [tid, thread] : threads_)
    {
      while (!thread.raw_.empty() &&
             thread.raw_.front().monotonic_ < p_monotonic - 600)
      {
        thread.raw_.pop_front();
        --raw_count_;
      }
    }
    if (raw_count_ > config_.max_live_samples_)
    {
      const auto quota = static_cast<std::size_t>(std::max<std::int64_t>(
          1, config_.max_live_samples_ /
                 std::max<std::int64_t>(
                     1, static_cast<std::int64_t>(threads_.size()))));
      for (auto& [tid, thread] : threads_)
      {
        while (thread.raw_.size() > quota)
        {
          thread.raw_.pop_front();
          --raw_count_;
        }
      }
    }
  }

  // Writes the rollup row for the thread's current window.
  void FinishWindow(std::int64_t p_tid, ThreadState& p_thread)
  {
    if (p_thread.window_.empty())
    {
      return;
    }
    const auto samples = std::move(p_thread.window_);
    p_thread.window_.clear();
    const Sample first =
        p_thread.baseline_ ? *p_thread.baseline_ : samples.front();
    const Sample& last = samples.back();
    const double window_s = config_.window_s_;
    double expected = 0;
    for (const auto& sample : samples)
    {
      expected += window_s / sample.interval_;
    }
    expected /= static_cast<double>(samples.size());
    const double elapsed = last.monotonic_ - first.monotonic_;
    const bool valid =
        static_cast<double>(samples.size()) >= std::ceil(expected / 2) &&
        elapsed > 0 &&
        elapsed <= window_s + std::max(first.interval_, last.interval_) * 1.5;
    const auto& last_record = last.Get();
    const auto& first_record = first.Get();
    StateCounts counts;
    for (const auto& sample : samples)
    {
      CountState(counts, sample.state_);
    }
    RollupRow row;
    row.ts_ = last.wall_ - std::fmod(last.monotonic_, window_s);
    row.session_ = session_text_;
    row.tid_ = p_tid;
    row.name_ = last_record.comm_;
    row.group_ = p_thread.group_;
    row.sample_counts_ = PythonCountsText(counts);
    if (valid)
    {
      row.cpu_pct_ = static_cast<double>(
                         Delta(CpuTicks(last_record), CpuTicks(first_record))) /
                     static_cast<double>(config_.clock_ticks_) / elapsed * 100;
      if (!last.fallback_)
      {
        row.run_delay_pct_ =
            static_cast<double>(
                Delta(last_record.run_delay_, first_record.run_delay_)) /
            1e9 / elapsed * 100;
      }
      row.timeslices_delta_ =
          Delta(last_record.timeslices_, first_record.timeslices_);
      row.read_bps_ = IoRate(last_record, first_record, false, elapsed);
      row.write_bps_ = IoRate(last_record, first_record, true, elapsed);
      row.major_faults_delta_ =
          Delta(last_record.major_faults_, first_record.major_faults_);
    }
    row.samples_ = static_cast<std::int64_t>(samples.size());
    row.expected_samples_ = expected;
    row.valid_ = valid;
    row.generation_ = p_thread.generation_;
    storage_.Rollup(row);
    p_thread.baseline_ = last;
  }
};

}  // namespace triangulator::collector
