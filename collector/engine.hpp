#pragma once

#include <algorithm>
#include <array>
#include <bitset>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "bounded.hpp"
#include "config.hpp"
#include "json.hpp"
#include "protocol.hpp"
#include "storage.hpp"
#include "text.hpp"

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
  Record record_;
  std::string_view state_;

  [[nodiscard]] const Record& Get() const noexcept
  {
    return record_;
  }
};

// State counts in order of first appearance, like Python's Counter. The
// states are the names Classify returns, kMaxStates at most, so the table is
// a fixed array.
class StateCounts
{
 public:
  using Item = std::pair<std::string_view, std::int64_t>;

  void Count(std::string_view p_state) noexcept
  {
    for (std::size_t index = 0; index < size_; ++index)
    {
      if (items_[index].first == p_state)
      {
        ++items_[index].second;
        return;
      }
    }
    // A state beyond kMaxStates cannot occur (see Classify).
    if (size_ < kMaxStates)
    {
      items_[size_++] = {p_state, 1};
    }
  }

  void Clear() noexcept
  {
    size_ = 0;
  }
  [[nodiscard]] const Item* begin() const noexcept
  {
    return items_.data();
  }
  [[nodiscard]] const Item* end() const noexcept
  {
    return items_.data() + size_;
  }

 private:
  std::array<Item, kMaxStates> items_{};
  std::size_t size_ = 0;
};

inline void CountState(StateCounts& p_counts, std::string_view p_state)
{
  p_counts.Count(p_state);
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
// Returns false if the text did not fit.
inline bool PythonCountsText(const StateCounts& p_counts,
                             SampleCountsText& p_out)
{
  p_out.Clear();
  bool fitted = p_out.Append("{");
  for (const auto& [state, count] : p_counts)
  {
    if (p_out.View().size() > 1)
    {
      fitted &= p_out.Append(", ");
    }
    fitted &= AppendJsonString(p_out, state);
    fitted &= p_out.Append(": ");
    fitted &= AppendInteger(p_out, count);
  }
  fitted &= p_out.Append("}");
  return fitted;
}

// Limits of the Monitor's fixed storage.
//
// Ticks that wait for their chunks or for older ticks.
inline constexpr std::size_t kMaxPendingTicks = 128;
// Sessions remembered, to reject late datagrams from them.
inline constexpr std::size_t kMaxRetiredSessions = 128;
// Loss entries, one per tick. Health keeps the last minute, which is 600
// ticks at the shortest interval (100 ms); the rest is room for a sampler
// that sends faster than it says.
inline constexpr std::size_t kMaxLossEntries = 4096;
// Threads tracked at once. This is the most a tick can describe.
inline constexpr std::size_t kMaxTrackedThreads = wire::kMaxThreads;

// Turns sampler datagrams into per-thread state, rollup rows and the live
// dashboard snapshot. Alerting is not done here: it is a separate program
// that reads the rollups (SQLite) or the HTTP API.
//
// Memory: the constructor allocates all storage the datagram path uses, from
// the limits above and Config::max_live_samples_. Accept(), Drain() and
// Close() allocate nothing afterwards (tests/collector_allocation_test.cpp
// checks this). Health() and Snapshot() build JSON for the dashboard and do
// allocate; they are not part of the datagram path.
//
// Monitor does no I/O. It gives each finished row to the RowSink at once.
class Monitor
{
 public:
  Monitor(const Config& p_config, double p_now, RowSink& p_sink)
      : config_(p_config),
        sink_(p_sink),
        started_(p_now),
        ticks_(kMaxPendingTicks),
        threads_(kMaxTrackedThreads),
        index_(kMaxTrackedThreads),
        free_threads_(kMaxTrackedThreads),
        samples_(ArenaSize(p_config.max_live_samples_)),
        generations_(std::size_t{kMaxTid} + 1)
  {
    for (auto& tick : ticks_)
    {
      tick.records_ = BoundedVector<TickRecord>(kMaxTrackedThreads);
    }
  }

  std::int64_t bad_packets_ = 0;

  void Accept(const Packet& p_packet, double p_received)
  {
    if (!session_ || p_packet.session_ != *session_)
    {
      if (IsRetired(p_packet.session_))
      {
        ++late_packets_;
        return;
      }
      if (session_)
      {
        retired_sessions_.PushBack(*session_);
        Drain(p_received, true);
        for (const auto& [tid, slot] : index_)
        {
          FinishWindow(tid, threads_[slot]);
        }
      }
      session_ = p_packet.session_;
      session_text_.Clear();
      AppendUnsigned(session_text_, *session_);
      ClearThreads();
      ++epoch_;
      for (auto& tick : ticks_)
      {
        tick.Release();
      }
      last_monotonic_.reset();
      last_sequence_.reset();
      loss_.Clear();
    }
    if (last_monotonic_ && p_packet.monotonic_ns_ <= *last_monotonic_)
    {
      ++late_packets_;
      return;
    }
    Tick* tick = FindTick(p_packet.sequence_);
    if (tick == nullptr)
    {
      if (ActiveTicks() >= kMaxPendingTicks)
      {
        Drain(p_received, true);
        if (last_monotonic_ && p_packet.monotonic_ns_ <= *last_monotonic_)
        {
          ++late_packets_;
          return;
        }
      }
      tick = FindFreeTick();
      assert(tick != nullptr);
      tick->Start(p_packet, p_received, next_tick_order_++);
    }
    if (!p_packet.SameTick(tick->header_))
    {
      ++bad_packets_;
      return;
    }
    if (tick->chunks_seen_.test(p_packet.chunk_))
    {
      ++duplicates_;
      return;
    }
    for (const auto& existing : tick->records_)
    {
      for (const auto& record : p_packet.Records())
      {
        if (record.tid_ == existing.record_.tid_)
        {
          ++bad_packets_;
          return;
        }
      }
    }
    for (const auto& record : p_packet.Records())
    {
      // At most 255 chunks of kRecordsPerPacket records, and each chunk is
      // accepted once, so the tick always has room.
      const bool added = tick->records_.PushBack(
          {p_packet.chunk_, static_cast<std::uint16_t>(tick->records_.Size()),
           record});
      assert(added);
      static_cast<void>(added);
    }
    tick->chunks_seen_.set(p_packet.chunk_);
    last_seen_ = p_received;
  }

  // Processes buffered ticks, oldest first, once their chunks have had time
  // to arrive (or immediately when p_force is set).
  void Drain(double p_now, bool p_force = false)
  {
    while (Tick* tick = OldestTick())
    {
      const auto& header = tick->header_;
      const double grace =
          std::max(0.25, std::min(2.0, 2.0 * header.interval_ms_ / 1000.0));
      if (!p_force && p_now - tick->received_ < grace)
      {
        break;
      }
      if (last_monotonic_ && header.monotonic_ns_ <= *last_monotonic_)
      {
        tick->Release();
        continue;
      }
      std::int64_t missing_ticks = 0;
      if (last_sequence_)
      {
        const std::uint32_t distance = header.sequence_ - *last_sequence_;
        if (distance == 0 || distance > 0x7FFFFFFFu)
        {
          ++late_packets_;
          tick->Release();
          continue;
        }
        missing_ticks = distance - 1;
      }
      const auto chunks = static_cast<std::int64_t>(tick->chunks_seen_.count());
      const std::int64_t expected = header.chunks_ * (missing_ticks + 1);
      loss_.PushBack({tick->received_, expected, expected - chunks});
      last_sequence_ = header.sequence_;
      last_monotonic_ = header.monotonic_ns_;
      Process(*tick);
      tick->Release();
    }
  }

  // Monitor health for the dashboard: sampler silence, estimated packet
  // loss over the last minute and packet counters.
  [[nodiscard]] Json Health(double p_now)
  {
    Drain(p_now);
    while (!loss_.Empty() && loss_.Front().received_ < p_now - 60)
    {
      loss_.PopFront();
    }
    std::int64_t expected = 0;
    std::int64_t lost = 0;
    for (std::size_t index = 0; index < loss_.Size(); ++index)
    {
      expected += loss_[index].expected_;
      lost += loss_[index].lost_;
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
        {"session", session_ ? Json(session_text_.View()) : Json(nullptr)},
        {"pid", pid_},
        {"bad_packets", bad_packets_},
        {"duplicates", duplicates_},
        {"late_packets", late_packets_},
        {"dropped_samples", dropped_samples_},
        {"raw_samples", raw_count_},
        {"sample_interval_ms",
         static_cast<std::int64_t>(std::nearbyint(interval_ * 1000))}};
  }

  // Current threads and group counts. There are no "alerts" fields; the
  // dashboard hides its alert sections when they are missing.
  [[nodiscard]] Json Snapshot(double p_now) const
  {
    JsonArray threads;
    // Groups come from the config and have no limit, so they are counted in
    // JSON. Snapshot is not on the datagram path and can allocate.
    Json groups{JsonObject{}};
    for (const auto& [tid, slot] : index_)
    {
      const auto& thread = threads_[slot];
      const auto& sample = thread.latest_;
      // Raw samples are in time order, so the last ten seconds are a suffix.
      // Walk back from the newest sample to where that suffix starts.
      std::uint32_t begin = kNoNode;
      for (auto node = thread.raw_last_;
           node != kNoNode &&
           !(samples_[node].sample_.monotonic_ < sample.monotonic_ - 10);
           node = samples_[node].previous_)
      {
        begin = node;
      }
      StateCounts counts;
      for (auto node = begin; node != kNoNode; node = samples_[node].next_)
      {
        CountState(counts, samples_[node].sample_.state_);
      }
      const auto& first = begin != kNoNode ? samples_[begin].sample_ : sample;
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
      auto& group_counts = groups.AsObject();
      const auto group = std::ranges::find(group_counts, thread.group_,
                                           &JsonObject::value_type::first);
      if (group == group_counts.end())
      {
        group_counts.emplace_back(std::string{thread.group_}, 1);
      }
      else
      {
        group->second = Json(group->second.AsInt() + 1);
      }
      threads.emplace_back(JsonObject{
          {"tid", tid},
          {"name", current.comm_.View()},
          {"group", thread.group_},
          {"state", sample.state_},
          {"wchan", current.wchan_.View()},
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
                      {"groups", std::move(groups)}};
  }

  void Close()
  {
    Drain(last_seen_.value_or(started_), true);
    for (const auto& [tid, slot] : index_)
    {
      FinishWindow(tid, threads_[slot]);
    }
  }

 private:
  static constexpr std::uint32_t kNoNode = 0xFFFFFFFFu;

  // One decoded record of a pending tick, with the chunk it came in and its
  // place in the tick's arrival order. Process() uses them to restore chunk
  // order.
  struct TickRecord
  {
    std::uint8_t chunk_{};
    std::uint16_t arrival_{};
    Record record_;
  };

  // A tick that is waiting for chunks or for its turn. The header's own
  // records are not used; they live in records_.
  struct Tick
  {
    bool active_ = false;
    Packet header_;
    double received_{};
    std::uint64_t order_{};
    std::bitset<256> chunks_seen_;
    BoundedVector<TickRecord> records_;

    void Start(const Packet& p_packet, double p_received, std::uint64_t p_order)
    {
      active_ = true;
      header_.CopyHeaderFrom(p_packet);
      received_ = p_received;
      order_ = p_order;
    }

    void Release() noexcept
    {
      active_ = false;
      chunks_seen_.reset();
      records_.Clear();
    }
  };

  struct LossEntry
  {
    double received_{};
    std::int64_t expected_{};
    std::int64_t lost_{};
  };

  // The state of one thread.
  struct ThreadState
  {
    std::string_view group_;
    std::int64_t generation_{};
    Sample latest_;
    // The raw history: a list, oldest first, in the Monitor's sample arena.
    std::uint32_t raw_first_ = kNoNode;
    std::uint32_t raw_last_ = kNoNode;
    std::size_t raw_size_ = 0;
    // The open rollup window, summed as samples arrive. Its newest sample
    // is latest_.
    std::size_t window_count_ = 0;
    Sample window_first_;
    double window_expected_ = 0;
    StateCounts window_states_;
    std::optional<Sample> baseline_;
    std::optional<std::int64_t> bucket_;
    // The Process() call that last saw this thread.
    std::uint64_t seen_ = 0;
  };

  // Thread ids in order, each with the slot that holds its state.
  struct ThreadRef
  {
    std::int64_t tid_{};
    std::uint32_t slot_{};
  };

  struct SampleNode
  {
    Sample sample_;
    std::uint32_t previous_ = kNoNode;
    std::uint32_t next_ = kNoNode;
  };

  // A thread id's generation in the current session. It is valid only when
  // epoch_ is the Monitor's epoch_, so a new session resets every thread
  // without a pass over the table.
  struct Generation
  {
    std::uint32_t epoch_;
    std::uint32_t value_;
  };

  const Config& config_;
  RowSink& sink_;
  double started_;
  std::optional<double> last_seen_;
  std::optional<std::uint64_t> session_;
  FixedText<24> session_text_;
  Ring<std::uint64_t, kMaxRetiredSessions> retired_sessions_;
  std::vector<Tick> ticks_;
  std::uint64_t next_tick_order_ = 0;
  // Thread slots are constructed on first use, up to the capacity, and then
  // reused through free_threads_. index_ is sorted by thread id.
  BoundedVector<ThreadState> threads_;
  BoundedVector<ThreadRef> index_;
  BoundedVector<std::uint32_t> free_threads_;
  BoundedVector<SampleNode> samples_;
  std::uint32_t free_node_ = kNoNode;
  ZeroedArray<Generation> generations_;
  std::uint32_t epoch_ = 1;
  std::uint64_t process_count_ = 0;
  std::optional<std::uint64_t> last_monotonic_;
  std::optional<std::uint32_t> last_sequence_;
  Ring<LossEntry, kMaxLossEntries> loss_;
  std::optional<bool> target_absent_;
  std::uint32_t pid_ = 0;
  double interval_ = 1.0;
  std::int64_t duplicates_ = 0;
  std::int64_t late_packets_ = 0;
  // Samples of threads that did not fit in the thread table.
  std::int64_t dropped_samples_ = 0;
  std::int64_t raw_count_ = 0;

  [[nodiscard]] bool IsRetired(std::uint64_t p_session) const noexcept
  {
    for (std::size_t index = 0; index < retired_sessions_.Size(); ++index)
    {
      if (retired_sessions_[index] == p_session)
      {
        return true;
      }
    }
    return false;
  }

  [[nodiscard]] Tick* FindTick(std::uint32_t p_sequence) noexcept
  {
    for (auto& tick : ticks_)
    {
      if (tick.active_ && tick.header_.sequence_ == p_sequence)
      {
        return &tick;
      }
    }
    return nullptr;
  }

  [[nodiscard]] Tick* FindFreeTick() noexcept
  {
    for (auto& tick : ticks_)
    {
      if (!tick.active_)
      {
        return &tick;
      }
    }
    return nullptr;
  }

  [[nodiscard]] std::size_t ActiveTicks() const noexcept
  {
    return static_cast<std::size_t>(
        std::ranges::count_if(ticks_,
                              [](const Tick& p_tick)
                              {
                                return p_tick.active_;
                              }));
  }

  // The pending tick with the smallest sampler clock, then arrival order.
  [[nodiscard]] Tick* OldestTick() noexcept
  {
    Tick* oldest = nullptr;
    for (auto& tick : ticks_)
    {
      if (tick.active_ &&
          (oldest == nullptr ||
           std::pair{tick.header_.monotonic_ns_, tick.order_} <
               std::pair{oldest->header_.monotonic_ns_, oldest->order_}))
      {
        oldest = &tick;
      }
    }
    return oldest;
  }

  [[nodiscard]] std::string_view GroupFor(std::string_view p_name) const
  {
    static constexpr std::string_view kUngrouped = "ungrouped";
    for (const auto& group : config_.groups_)
    {
      if (p_name.starts_with(group.prefix_))
      {
        return group.name_;
      }
    }
    return kUngrouped;
  }

  // The position in index_ of the first thread id that is not below p_tid.
  [[nodiscard]] std::size_t LowerBound(std::int64_t p_tid) const noexcept
  {
    const auto found =
        std::ranges::lower_bound(index_, p_tid, {}, &ThreadRef::tid_);
    return static_cast<std::size_t>(found - index_.begin());
  }

  // The raw history. Nodes come from samples_ and return to free_node_.
  [[nodiscard]] std::uint32_t AllocateNode()
  {
    if (free_node_ != kNoNode)
    {
      const auto node = free_node_;
      free_node_ = samples_[node].next_;
      return node;
    }
    if (!samples_.PushBack({}))
    {
      return kNoNode;
    }
    return static_cast<std::uint32_t>(samples_.Size() - 1);
  }

  // Nodes in the sample arena. PruneRaw ends each tick with at most
  // max(max_live_samples, threads) samples, and a tick adds at most one
  // sample per thread, kMaxTrackedThreads in total. So the arena is never
  // full. (A test that makes max_live_samples_ larger after construction
  // breaks this; the tests only make it smaller.)
  [[nodiscard]] static std::size_t ArenaSize(std::int64_t p_max_live_samples)
  {
    const auto live =
        static_cast<std::size_t>(std::max<std::int64_t>(p_max_live_samples, 0));
    return std::max(live, kMaxTrackedThreads) + kMaxTrackedThreads;
  }

  void PushRaw(ThreadState& p_thread, const Sample& p_sample)
  {
    const auto node = AllocateNode();
    assert(node != kNoNode);  // See ArenaSize.
    samples_[node] = {p_sample, p_thread.raw_last_, kNoNode};
    if (p_thread.raw_last_ != kNoNode)
    {
      samples_[p_thread.raw_last_].next_ = node;
    }
    else
    {
      p_thread.raw_first_ = node;
    }
    p_thread.raw_last_ = node;
    ++p_thread.raw_size_;
    ++raw_count_;
  }

  void PopRawFront(ThreadState& p_thread) noexcept
  {
    const auto node = p_thread.raw_first_;
    p_thread.raw_first_ = samples_[node].next_;
    if (p_thread.raw_first_ != kNoNode)
    {
      samples_[p_thread.raw_first_].previous_ = kNoNode;
    }
    else
    {
      p_thread.raw_last_ = kNoNode;
    }
    samples_[node].next_ = free_node_;
    free_node_ = node;
    --p_thread.raw_size_;
    --raw_count_;
  }

  void ReleaseRaw(ThreadState& p_thread) noexcept
  {
    while (p_thread.raw_size_ > 0)
    {
      PopRawFront(p_thread);
    }
  }

  // Removes every thread, without writing rollups.
  void ClearThreads() noexcept
  {
    for (const auto& [tid, slot] : index_)
    {
      ReleaseRaw(threads_[slot]);
      static_cast<void>(free_threads_.PushBack(slot));
    }
    index_.Clear();
  }

  // Finishes and removes the threads for which p_predicate is true, in
  // thread id order.
  template <typename TPredicate>
  void RemoveThreadsIf(TPredicate p_predicate)
  {
    std::size_t kept = 0;
    for (std::size_t position = 0; position < index_.Size(); ++position)
    {
      const ThreadRef ref = index_[position];
      auto& thread = threads_[ref.slot_];
      if (p_predicate(thread))
      {
        FinishWindow(ref.tid_, thread);
        ReleaseRaw(thread);
        static_cast<void>(free_threads_.PushBack(ref.slot_));
      }
      else
      {
        index_[kept++] = ref;
      }
    }
    index_.Truncate(kept);
  }

  // A slot for a new thread. The caller has checked that index_ is not full,
  // and index_ and the slots have the same capacity.
  [[nodiscard]] std::uint32_t AcquireSlot()
  {
    if (!free_threads_.Empty())
    {
      const auto slot = free_threads_.Back();
      free_threads_.PopBack();
      threads_[slot] = ThreadState{};
      return slot;
    }
    const bool added = threads_.PushBack({});
    assert(added);
    static_cast<void>(added);
    return static_cast<std::uint32_t>(threads_.Size() - 1);
  }

  void Process(Tick& p_tick)
  {
    const Packet& header = p_tick.header_;
    const bool complete = p_tick.chunks_seen_.count() == header.chunks_;
    interval_ = header.interval_ms_ / 1000.0;
    pid_ = header.pid_;
    target_absent_ = (header.flags_ & kTargetAbsent) != 0;
    const double monotonic = static_cast<double>(header.monotonic_ns_) / 1e9;
    double wall = static_cast<double>(header.wall_ns_) / 1e9;
    if (std::fabs(wall - p_tick.received_) > 86400)
    {
      wall = p_tick.received_;
    }
    const bool fallback = (header.flags_ & kStatusFallback) != 0;
    // Records go in chunk order. Datagrams that arrived in order are
    // already sorted.
    const auto in_order =
        [](const TickRecord& p_left, const TickRecord& p_right)
    {
      return std::pair{p_left.chunk_, p_left.arrival_} <
             std::pair{p_right.chunk_, p_right.arrival_};
    };
    if (!std::ranges::is_sorted(p_tick.records_, in_order))
    {
      std::ranges::sort(p_tick.records_, in_order);
    }
    const auto stamp = ++process_count_;
    for (const auto& item : p_tick.records_)
    {
      const Record& record = item.record_;
      const std::int64_t tid = record.tid_;
      const Sample sample{monotonic, wall,   interval_,
                          fallback,  record, Classify(record)};
      const auto group = GroupFor(record.comm_.View());
      const auto position = LowerBound(tid);
      bool present = position < index_.Size() && index_[position].tid_ == tid;
      if (present)
      {
        auto& existing = threads_[index_[position].slot_];
        const bool reset = CountersRegressed(record, existing.latest_.Get()) ||
                           existing.latest_.fallback_ != sample.fallback_ ||
                           existing.group_ != group;
        if (reset)
        {
          FinishWindow(tid, existing);
          ReleaseRaw(existing);
          static_cast<void>(free_threads_.PushBack(index_[position].slot_));
          index_.Erase(position);
          present = false;
        }
      }
      if (!present)
      {
        if (index_.Full())
        {
          ++dropped_samples_;
          continue;
        }
        auto& history = generations_[static_cast<std::size_t>(tid)];
        const std::uint32_t next =
            history.epoch_ == epoch_ ? history.value_ + 1 : 0;
        history = {epoch_, next};
        const auto slot = AcquireSlot();
        auto& state = threads_[slot];
        state.group_ = group;
        state.generation_ = next;
        state.latest_ = sample;
        static_cast<void>(index_.Insert(position, {tid, slot}));
      }
      auto& thread = threads_[index_[position].slot_];
      thread.seen_ = stamp;
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
      PushRaw(thread, sample);
      if (thread.window_count_ == 0)
      {
        thread.window_first_ = sample;
      }
      ++thread.window_count_;
      thread.window_expected_ += config_.window_s_ / sample.interval_;
      thread.window_states_.Count(sample.state_);
      if (config_.store_raw_)
      {
        RawRow raw;
        raw.ts_ = wall;
        raw.session_ = session_text_;
        raw.record_ = record;
        sink_.Raw(raw);
      }
    }
    if (complete)
    {
      RemoveThreadsIf(
          [&](const ThreadState& p_thread)
          {
            return p_thread.seen_ != stamp;
          });
    }
    RemoveThreadsIf(
        [&](const ThreadState& p_thread)
        {
          return monotonic - p_thread.latest_.monotonic_ >
                 std::max(10.0, 3 * interval_);
        });
    PruneRaw(monotonic);
  }

  void PruneRaw(double p_monotonic)
  {
    for (const auto& [tid, slot] : index_)
    {
      auto& thread = threads_[slot];
      while (thread.raw_size_ > 0 &&
             samples_[thread.raw_first_].sample_.monotonic_ < p_monotonic - 600)
      {
        PopRawFront(thread);
      }
    }
    if (raw_count_ > config_.max_live_samples_)
    {
      const auto quota = static_cast<std::size_t>(std::max<std::int64_t>(
          1, config_.max_live_samples_ /
                 std::max<std::int64_t>(
                     1, static_cast<std::int64_t>(index_.Size()))));
      for (const auto& [tid, slot] : index_)
      {
        auto& thread = threads_[slot];
        while (thread.raw_size_ > quota)
        {
          PopRawFront(thread);
        }
      }
    }
  }

  // Sends the rollup row for the thread's current window to the sink.
  void FinishWindow(std::int64_t p_tid, ThreadState& p_thread)
  {
    if (p_thread.window_count_ == 0)
    {
      return;
    }
    const Sample& last = p_thread.latest_;
    const Sample& first =
        p_thread.baseline_ ? *p_thread.baseline_ : p_thread.window_first_;
    const double window_s = config_.window_s_;
    const auto count = static_cast<double>(p_thread.window_count_);
    const double expected = p_thread.window_expected_ / count;
    const double elapsed = last.monotonic_ - first.monotonic_;
    const bool valid =
        count >= std::ceil(expected / 2) && elapsed > 0 &&
        elapsed <= window_s + std::max(first.interval_, last.interval_) * 1.5;
    const auto& last_record = last.Get();
    const auto& first_record = first.Get();
    RollupRow row;
    row.ts_ = last.wall_ - std::fmod(last.monotonic_, window_s);
    row.session_ = session_text_;
    row.tid_ = p_tid;
    row.name_ = last_record.comm_;
    row.group_ = p_thread.group_;
    const bool fitted =
        PythonCountsText(p_thread.window_states_, row.sample_counts_);
    assert(fitted);
    static_cast<void>(fitted);
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
    row.samples_ = static_cast<std::int64_t>(p_thread.window_count_);
    row.expected_samples_ = expected;
    row.valid_ = valid;
    row.generation_ = p_thread.generation_;
    sink_.Rollup(row);
    p_thread.baseline_ = last;
    p_thread.window_count_ = 0;
    p_thread.window_expected_ = 0;
    p_thread.window_states_.Clear();
  }
};

}  // namespace triangulator::collector
