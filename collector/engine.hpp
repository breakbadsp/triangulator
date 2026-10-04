#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <deque>
#include <format>
#include <functional>
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

class AlertEngine
{
 public:
  using Deliver = std::function<void(const AlertEvent&)>;

  struct OpenAlert
  {
    std::uint64_t order_;
    AlertEvent event_;
  };

  AlertEngine(const AlertSettings& p_settings, Storage& p_storage,
              Deliver p_deliver, double p_now)
      : settings_(p_settings),
        storage_(p_storage),
        deliver_(std::move(p_deliver))
  {
    auto [recent, open] = storage_.RecoverAlerts();
    for (auto& event : recent)
    {
      Remember(std::move(event));
    }
    for (auto& [key, event] : open)
    {
      const auto rule = RuleIndex(key.rule_);
      if (rule && settings_.enabled_[*rule])
      {
        open_.emplace(key, OpenAlert{next_order_++, std::move(event)});
        continue;
      }
      // Alerts from removed or disabled rules are closed quietly, without
      // notification.
      AlertEvent closed = std::move(event);
      closed.status_ = "resolved";
      closed.ts_ = p_now;
      closed.detail_ = rule ? "Alert rule disabled" : "Alert rule removed";
      storage_.Event(closed);
      Remember(std::move(closed));
    }
  }

  [[nodiscard]] const std::map<AlertKey, OpenAlert>& Open() const noexcept
  {
    return open_;
  }
  [[nodiscard]] const std::deque<AlertEvent>& Recent() const noexcept
  {
    return recent_;
  }

  void CloseDisabled(double p_now)
  {
    for (auto iterator = open_.begin(); iterator != open_.end();)
    {
      if (settings_.Enabled(iterator->first.rule_))
      {
        ++iterator;
        continue;
      }
      const auto event = iterator->second.event_;
      iterator = open_.erase(iterator);
      Emit(event.Key(), event.name_, event.session_, "resolved", p_now,
           "Alert rule disabled", event.severity_);
    }
    std::erase_if(streaks_,
                  [&](const auto& p_item)
                  {
                    return !settings_.Enabled(p_item.first.rule_);
                  });
  }

  // Tracks a rule's condition for one thread. nullopt means "no evidence"
  // and clears the streak. An alert opens after sustain_windows matching
  // results in a row and resolves after resolve_windows, or at once when
  // p_immediate is set.
  void Evaluate(std::string_view p_rule, std::string_view p_group,
                std::int64_t p_tid, std::optional<bool> p_condition,
                double p_now, std::string_view p_name,
                std::string_view p_session, std::string_view p_detail,
                std::string_view p_severity = "warning",
                bool p_immediate = false)
  {
    if (!settings_.Enabled(p_rule))
    {
      return;
    }
    AlertKey key{std::string{p_rule}, std::string{p_group}, p_tid};
    if (!p_condition)
    {
      streaks_.erase(key);
      return;
    }
    auto& streak = streaks_[key];
    streak.count_ = streak.count_ > 0 && streak.condition_ == *p_condition
                        ? streak.count_ + 1
                        : 1;
    streak.condition_ = *p_condition;
    const auto found = open_.find(key);
    if (*p_condition && found == open_.end() &&
        (p_immediate ||
         static_cast<double>(streak.count_) >= settings_.sustain_windows_))
    {
      auto event =
          Emit(key, p_name, p_session, "opened", p_now, p_detail, p_severity);
      open_.emplace(std::move(key), OpenAlert{next_order_++, std::move(event)});
    }
    else if (!*p_condition && found != open_.end() &&
             (p_immediate ||
              static_cast<double>(streak.count_) >= settings_.resolve_windows_))
    {
      const auto severity = found->second.event_.severity_;
      open_.erase(found);
      Emit(key, p_name, p_session, "resolved", p_now, p_detail, severity);
    }
  }

  // Resolves every open alert of thread p_tid and forgets its streaks.
  void Retire(std::int64_t p_tid, double p_now, std::string_view p_detail)
  {
    if (p_tid == 0)
    {
      return;
    }
    for (auto iterator = open_.begin(); iterator != open_.end();)
    {
      if (iterator->first.tid_ != p_tid)
      {
        ++iterator;
        continue;
      }
      const auto event = iterator->second.event_;
      iterator = open_.erase(iterator);
      Emit(event.Key(), event.name_, event.session_, "resolved", p_now,
           p_detail, event.severity_);
    }
    std::erase_if(streaks_,
                  [&](const auto& p_item)
                  {
                    return p_item.first.tid_ == p_tid;
                  });
  }

  void Reminders(double p_now)
  {
    for (auto& [key, alert] : open_)
    {
      if (p_now - alert.event_.ts_ >= settings_.reminder_secs_)
      {
        const auto previous = alert.event_;
        alert.event_ = Emit(key, previous.name_, previous.session_, "reminder",
                            p_now, previous.detail_, previous.severity_);
      }
    }
  }

  void ForgetStreak(const AlertKey& p_key)
  {
    streaks_.erase(p_key);
  }

 private:
  struct Streak
  {
    bool condition_ = false;
    int count_ = 0;
  };

  const AlertSettings& settings_;
  Storage& storage_;
  Deliver deliver_;
  std::map<AlertKey, OpenAlert> open_;
  std::map<AlertKey, Streak> streaks_;
  std::deque<AlertEvent> recent_;
  std::uint64_t next_order_ = 0;

  void Remember(AlertEvent p_event)
  {
    recent_.push_back(std::move(p_event));
    if (recent_.size() > 500)
    {
      recent_.pop_front();
    }
  }

  AlertEvent Emit(const AlertKey& p_key, std::string_view p_name,
                  std::string_view p_session, std::string_view p_status,
                  double p_now, std::string_view p_detail,
                  std::string_view p_severity)
  {
    AlertEvent event{std::string{p_name},
                     std::string{p_session},
                     p_key.rule_,
                     p_key.group_,
                     p_key.tid_,
                     std::string{p_status},
                     p_now,
                     std::string{p_detail},
                     std::string{p_severity}};
    storage_.Event(event);
    Remember(event);
    deliver_(event);
    return event;
  }
};

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

struct CpuRun
{
  bool above_;
  double since_;
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
  std::optional<double> kernel_since_;
  // Indexed like kCpuRules: warning, then critical.
  std::array<std::optional<CpuRun>, 2> cpu_runs_;
  double contiguous_since_{};
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

class Monitor
{
 public:
  Monitor(Config& p_config, Storage& p_storage, AlertEngine::Deliver p_deliver,
          double p_now)
      : config_(p_config),
        storage_(p_storage),
        alerts_(p_config.alerts_, p_storage, std::move(p_deliver), p_now),
        started_(p_now)
  {
  }

  std::int64_t bad_packets_ = 0;

  [[nodiscard]] const AlertEngine& Alerts() const noexcept
  {
    return alerts_;
  }

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
          alerts_.Retire(tid, p_received, "Sampler session or target changed");
        }
      }
      session_ = p_packet.session_;
      session_text_ = std::to_string(*session_);
      std::vector<AlertEvent> stale;
      for (const auto& [key, alert] : alerts_.Open())
      {
        stale.push_back(alert.event_);
      }
      for (const auto& event : stale)
      {
        if (event.tid_ != 0 && event.session_ != session_text_)
        {
          alerts_.Retire(event.tid_, p_received,
                         "Sampler session or target changed");
        }
      }
      threads_.clear();
      generations_.clear();
      raw_count_ = 0;
      pending_.clear();
      last_monotonic_.reset();
      last_sequence_.reset();
      loss_.clear();
      absent_since_.reset();
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
      last_tick_seen_ = tick.received_;
      std::vector<Record> records;
      for (auto& [chunk, chunk_records] : tick.chunks_)
      {
        std::ranges::move(chunk_records, std::back_inserter(records));
      }
      Process(tick.header_, std::move(records), tick.received_,
              tick.chunks_.size() == tick.header_.chunks_);
    }
  }

  void ApplyAlertSettings(const AlertSettings& p_alerts, double p_now)
  {
    // A run proves "above/below the old threshold", which says nothing about
    // a new threshold, so a changed threshold must collect fresh evidence.
    const bool warn_changed =
        config_.alerts_.cpu_warn_pct_ != p_alerts.cpu_warn_pct_;
    const bool critical_changed =
        config_.alerts_.cpu_crit_pct_ != p_alerts.cpu_crit_pct_;
    for (auto& [tid, thread] : threads_)
    {
      if (warn_changed)
      {
        thread.cpu_runs_[0].reset();
      }
      if (critical_changed)
      {
        thread.cpu_runs_[1].reset();
      }
    }
    config_.alerts_ = p_alerts;
    alerts_.CloseDisabled(p_now);
  }

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
    const Json loss_json = expected != 0
                               ? Json(static_cast<double>(lost) /
                                      static_cast<double>(expected) * 100)
                               : Json(0);
    const double loss_pct = loss_json.AsNumber();
    const auto& thresholds = config_.alerts_;
    const bool silent = p_now - last_seen_.value_or(started_) >=
                        thresholds.sampler_silent_secs_;
    const std::string session = session_ ? session_text_ : "0";
    std::int64_t no_access = 0;
    for (const auto& [tid, thread] : threads_)
    {
      no_access += thread.latest_.state_ == "no_access" ? 1 : 0;
    }
    const std::array<std::tuple<std::string_view, bool, std::string>, 4>
        conditions{{
            {"sampler_silent", silent, "No fresh sampler datagrams"},
            {"target_absent",
             !silent && absent_since_ &&
                 p_now - *absent_since_ >= thresholds.target_absent_secs_,
             "Sampler reports target absent"},
            {"packet_loss", loss_pct > thresholds.packet_loss_pct_,
             std::format("Estimated packet loss {:.1f}% over 60s", loss_pct)},
            {"access_lost",
             !silent && !threads_.empty() &&
                 static_cast<double>(no_access) >
                     static_cast<double>(threads_.size()) / 2,
             "Most threads have a hidden wait channel"},
        }};
    for (const auto& [rule, condition, detail] : conditions)
    {
      alerts_.Evaluate(rule, "monitor", 0, condition, p_now, "monitor", session,
                       detail, "warning", true);
    }
    if (silent)
    {
      for (auto& [tid, thread] : threads_)
      {
        Invalidate(tid, thread);
      }
    }
    alerts_.Reminders(p_now);
    return JsonObject{
        {"last_seen", Json(last_seen_)},
        {"sampler_silent", silent},
        {"target_absent", Json(target_absent_)},
        {"packet_loss_pct", loss_json},
        {"session", session_ ? Json(session_text_) : Json(nullptr)},
        {"pid", pid_},
        {"bad_packets", bad_packets_},
        {"duplicates", duplicates_},
        {"late_packets", late_packets_},
        {"raw_samples", raw_count_},
        {"sample_interval_ms",
         static_cast<std::int64_t>(std::nearbyint(interval_ * 1000))}};
  }

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
    std::vector<const AlertEngine::OpenAlert*> open;
    for (const auto& [key, alert] : alerts_.Open())
    {
      open.push_back(&alert);
    }
    std::ranges::sort(open, {}, &AlertEngine::OpenAlert::order_);
    JsonArray open_json;
    for (const auto* alert : open)
    {
      open_json.push_back(EventJson(alert->event_));
    }
    JsonArray recent;
    for (auto iterator = alerts_.Recent().rbegin();
         iterator != alerts_.Recent().rend(); ++iterator)
    {
      recent.push_back(EventJson(*iterator));
    }
    return JsonObject{{"threads", std::move(threads)},
                      {"groups", CountsJson(groups)},
                      {"alerts", std::move(open_json)},
                      {"recent_alerts", std::move(recent)}};
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

  static constexpr std::array<std::pair<std::string_view, std::string_view>, 2>
      kCpuRules{{{"cpu_warn", "warning"}, {"cpu_critical", "critical"}}};

  Config& config_;
  Storage& storage_;
  AlertEngine alerts_;
  double started_;
  std::optional<double> last_seen_;
  std::optional<double> last_tick_seen_;
  std::optional<std::uint64_t> session_;
  std::string session_text_;
  std::deque<std::uint64_t> retired_sessions_;
  std::map<std::int64_t, ThreadState> threads_;
  std::map<std::uint32_t, Tick> pending_;
  std::uint64_t next_tick_order_ = 0;
  std::optional<std::uint64_t> last_monotonic_;
  std::optional<std::uint32_t> last_sequence_;
  std::deque<LossEntry> loss_;
  std::optional<double> absent_since_;
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
    if (*target_absent_)
    {
      if (!absent_since_)
      {
        absent_since_ = p_received;
      }
    }
    else
    {
      absent_since_.reset();
    }
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
          alerts_.Retire(tid, p_received,
                         "Thread counters, group or counter mode changed");
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
        state.contiguous_since_ = sample.monotonic_;
        found = threads_.emplace(tid, std::move(state)).first;
      }
      auto& thread = found->second;
      const auto bucket = static_cast<std::int64_t>(
          std::floor(monotonic / config_.alerts_.window_s_));
      if (thread.bucket_ && bucket != *thread.bucket_)
      {
        FinishWindow(tid, thread);
        if (bucket != *thread.bucket_ + 1)
        {
          Invalidate(tid, thread);
          thread.baseline_.reset();
        }
      }
      if (!thread.raw_.empty() &&
          monotonic - thread.latest_.monotonic_ > interval_ * 1.5)
      {
        thread.kernel_since_.reset();
        thread.cpu_runs_ = {};
        thread.contiguous_since_ = monotonic;
      }
      thread.bucket_ = bucket;
      thread.latest_ = sample;
      thread.raw_.push_back(sample);
      CheckCpu(tid, thread, sample);
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
        RemoveThread(tid, p_received, "Thread exited or target absent");
      }
      std::vector<std::int64_t> open_tids;
      for (const auto& [key, alert] : alerts_.Open())
      {
        open_tids.push_back(alert.event_.tid_);
      }
      for (const auto tid : open_tids)
      {
        if (tid != 0 && !seen.contains(tid))
        {
          alerts_.Retire(tid, p_received, "Thread exited or target absent");
        }
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
      RemoveThread(tid, p_received,
                   "Thread no longer observed (possibly packet loss)");
    }
    PruneRaw(monotonic);
  }

  void RemoveThread(std::int64_t p_tid, double p_now, std::string_view p_detail)
  {
    auto found = threads_.find(p_tid);
    FinishWindow(p_tid, found->second);
    raw_count_ -= static_cast<std::int64_t>(found->second.raw_.size());
    threads_.erase(found);
    alerts_.Retire(p_tid, p_now, p_detail);
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

  // Opens a CPU alert once a thread stays above the threshold for
  // cpu_sustain_secs.
  //
  // CPU is measured against the newest sample at least one second older, so
  // clock-tick resolution stays near 1% at any sampling rate. A run of
  // above- or below-threshold readings starts at the first sample that
  // measured it, not at that measurement's reference: a reading over one
  // second can cross the threshold although only part of that second was
  // busy, and crediting the whole second would let a burst shorter than
  // cpu_sustain_secs open an alert. A sampling gap clears the runs and the
  // usable history (see Process).
  void CheckCpu(std::int64_t p_tid, ThreadState& p_thread,
                const Sample& p_sample)
  {
    const Sample* reference = nullptr;
    for (auto iterator = p_thread.raw_.rbegin();
         iterator != p_thread.raw_.rend(); ++iterator)
    {
      if (iterator->monotonic_ <= p_sample.monotonic_ - 1.0)
      {
        reference = &*iterator;
        break;
      }
    }
    if (reference == nullptr ||
        reference->monotonic_ < p_thread.contiguous_since_)
    {
      return;
    }
    const double elapsed = p_sample.monotonic_ - reference->monotonic_;
    const auto ticks =
        Delta(CpuTicks(p_sample.Get()), CpuTicks(reference->Get()));
    const double cpu = static_cast<double>(ticks) /
                       static_cast<double>(config_.clock_ticks_) / elapsed *
                       100;
    const auto& thresholds = config_.alerts_;
    const double sustain = thresholds.cpu_sustain_secs_;
    const std::array limits{thresholds.cpu_warn_pct_, thresholds.cpu_crit_pct_};
    for (std::size_t index = 0; index < kCpuRules.size(); ++index)
    {
      const auto [rule, severity] = kCpuRules[index];
      const double threshold = limits[index];
      const bool above = cpu > threshold;
      auto& run = p_thread.cpu_runs_[index];
      if (!run || run->above_ != above)
      {
        run = CpuRun{above, p_sample.monotonic_};
      }
      const double duration = p_sample.monotonic_ - run->since_;
      if (duration < sustain)
      {
        continue;
      }
      const auto detail =
          above ? std::format("CPU {:.1f}% for {:.0f}s (over {:g}%)", cpu,
                              duration, threshold)
                : std::format("CPU {:.1f}%, below {:g}% for {:.0f}s", cpu,
                              threshold, duration);
      alerts_.Evaluate(rule, p_thread.group_, p_tid, above, p_sample.wall_,
                       p_sample.Get().comm_, session_text_, detail, severity,
                       true);
    }
  }

  void Invalidate(std::int64_t p_tid, ThreadState& p_thread)
  {
    p_thread.kernel_since_.reset();
    for (const std::string_view rule : {"starved", "kernel_wait"})
    {
      alerts_.ForgetStreak(AlertKey{std::string{rule}, p_thread.group_, p_tid});
    }
  }

  // Writes the rollup row for the thread's current window and evaluates the
  // window-based rules (starvation, stuck in kernel).
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
    const double window_s = config_.alerts_.window_s_;
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
    const auto cpu_delta = Delta(CpuTicks(last_record), CpuTicks(first_record));
    const auto delay_delta =
        Delta(last_record.run_delay_, first_record.run_delay_);
    const auto slices_delta =
        Delta(last_record.timeslices_, first_record.timeslices_);
    std::optional<double> cpu;
    std::optional<double> delay;
    if (valid)
    {
      cpu = static_cast<double>(cpu_delta) /
            static_cast<double>(config_.clock_ticks_) / elapsed * 100;
      if (!last.fallback_)
      {
        delay = static_cast<double>(delay_delta) / 1e9 / elapsed * 100;
      }
    }
    const auto faults_delta =
        Delta(last_record.major_faults_, first_record.major_faults_);
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
    row.cpu_pct_ = cpu;
    row.run_delay_pct_ = delay;
    row.sample_counts_ = PythonCountsText(counts);
    if (valid)
    {
      row.timeslices_delta_ = slices_delta;
      row.read_bps_ = IoRate(last_record, first_record, false, elapsed);
      row.write_bps_ = IoRate(last_record, first_record, true, elapsed);
      row.major_faults_delta_ = faults_delta;
    }
    row.samples_ = static_cast<std::int64_t>(samples.size());
    row.expected_samples_ = expected;
    row.valid_ = valid;
    row.generation_ = p_thread.generation_;
    storage_.Rollup(row);
    p_thread.baseline_ = last;
    if (!valid)
    {
      Invalidate(p_tid, p_thread);
      return;
    }
    const auto& thresholds = config_.alerts_;
    const auto& name = last_record.comm_;
    if (last.fallback_)
    {
      const auto running =
          std::ranges::count_if(samples,
                                [](const Sample& p_sample)
                                {
                                  return p_sample.Get().state_ == 'R';
                                });
      const bool starved = static_cast<double>(running) >
                               static_cast<double>(samples.size()) / 2 &&
                           *cpu < 10 && delay_delta > 0;
      alerts_.Evaluate("starved", p_thread.group_, p_tid, starved, last.wall_,
                       name, session_text_, "Runnable with little CPU");
    }
    else
    {
      alerts_.Evaluate("starved", p_thread.group_, p_tid,
                       *delay > thresholds.starve_run_delay_pct_, last.wall_,
                       name, session_text_,
                       std::format("Run delay {:.1f}%", *delay));
    }
    bool contiguous = true;
    const Sample* left = &first;
    for (const auto& right : samples)
    {
      if (right.monotonic_ - left->monotonic_ >
          std::max(left->interval_, right.interval_) * 1.5)
      {
        contiguous = false;
        break;
      }
      left = &right;
    }
    const bool all_kernel =
        std::ranges::all_of(samples,
                            [](const Sample& p_sample)
                            {
                              return p_sample.state_ == "kernel";
                            });
    const double duration = thresholds.kernel_wait_secs_;
    std::optional<bool> condition;
    if (all_kernel && contiguous)
    {
      if (!p_thread.kernel_since_)
      {
        p_thread.kernel_since_ = samples.front().monotonic_;
      }
      condition = last.monotonic_ - *p_thread.kernel_since_ > duration;
      if (!*condition)
      {
        return;
      }
    }
    else
    {
      p_thread.kernel_since_.reset();
      if (!all_kernel)
      {
        condition = false;
      }
    }
    const bool firing = condition.value_or(false);
    alerts_.Evaluate(
        "kernel_wait", p_thread.group_, p_tid, condition, last.wall_, name,
        session_text_,
        firing ? std::format("kernel_wait: sustained over {:g}s", duration)
               : std::string{"kernel_wait: condition cleared"},
        "warning", firing);
  }
};

}  // namespace triangulator::collector
