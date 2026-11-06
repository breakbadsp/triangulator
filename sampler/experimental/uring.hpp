#pragma once

#include <fcntl.h>
#include <liburing.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cassert>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <expected>
#include <memory>
#include <optional>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

#include "../proc.hpp"

namespace triangulator::experimental
{

constexpr std::size_t kChunkThreads = 32;
constexpr std::size_t kRequests = 2 * kChunkThreads;
constexpr std::size_t kBufferBytes = 8192;
constexpr std::size_t kDescriptorsPerThread = 5;
constexpr std::size_t kReservedDescriptors = 32;

struct TickCounts
{
  std::size_t published_{};
  std::size_t reused_{};
  std::size_t required_errors_{};
  std::size_t optional_errors_{};
  std::size_t pending_completion_{};
  std::size_t blocked_by_pending_chunk_{};
  std::size_t deadline_before_chunk_{};
  std::size_t reads_{};
};

// A queued request still owns its buffer even before the kernel accepts it.
class Completions final
{
 public:
  void Prepare(std::size_t p_count)
  {
    assert(remaining_ == 0);
    assert(p_count <= kRequests);
    active_.fill(false);
    std::fill_n(active_.begin(), p_count, true);
    remaining_ = p_count;
  }
  [[nodiscard]] bool Complete(std::uint64_t p_tag) noexcept
  {
    if (p_tag >= active_.size() || !active_[p_tag])
    {
      return false;
    }
    active_[p_tag] = false;
    --remaining_;
    return true;
  }
  [[nodiscard]] std::size_t Remaining() const noexcept
  {
    return remaining_;
  }

 private:
  std::array<bool, kRequests> active_{};
  std::size_t remaining_{};
};

class Sampler final
{
  struct ConstructionKey
  {
  };

 public:
  explicit Sampler(ConstructionKey)
  {
  }
  [[nodiscard]] static std::expected<std::unique_ptr<Sampler>, int> Create()
  {
    auto sampler = std::make_unique<Sampler>(ConstructionKey{});
    const auto result = ::io_uring_queue_init(kRequests, &sampler->ring_, 0);
    if (result < 0)
    {
      return std::unexpected(-result);
    }
    sampler->initialized_ = true;
    if (!(sampler->ring_.features & IORING_FEAT_EXT_ARG))
    {
      return std::unexpected(EOPNOTSUPP);
    }
    return sampler;
  }
  ~Sampler()
  {
    if (initialized_)
    {
      // Cleanup is outside the tick. Never free a buffer with outstanding I/O.
      for (int attempt = 0; attempt < 10 && completions_.Remaining(); ++attempt)
      {
        const auto drained =
            Drain(ClockNow(CLOCK_MONOTONIC) + std::chrono::milliseconds{100});
        if (!drained)
        {
          break;
        }
      }
      if (completions_.Remaining())
      {
        // Process exit lets the kernel cancel requests before memory release.
        std::fputs("experimental sampler: pending I/O cleanup failed\n",
                   stderr);
        std::_Exit(1);
      }
      ::io_uring_queue_exit(&ring_);
    }
  }
  Sampler(const Sampler&) = delete;
  Sampler& operator=(const Sampler&) = delete;
  Sampler(Sampler&&) = delete;
  Sampler& operator=(Sampler&&) = delete;

  // Admission is startup-only. A new cohort requires a new sampler instance.
  [[nodiscard]] std::expected<void, int> Admit(int p_pid,
                                               std::span<const int> p_tids,
                                               const char* p_root = "/proc")
  {
    assert(threads_.empty());
    const auto limit = RaiseDescriptorLimit();
    if (p_tids.empty() || p_tids.size() > wire::kMaxThreads)
    {
      return std::unexpected(EINVAL);
    }
    if (limit < kReservedDescriptors ||
        p_tids.size() > (limit - kReservedDescriptors) / kDescriptorsPerThread)
    {
      return std::unexpected(EMFILE);
    }
    threads_.reserve(p_tids.size());
    output_.resize(p_tids.size());
    const FileDescriptor process_directory{
        ::open(FixedString{"{}/{}", p_root, p_pid}.CStr(),
               O_RDONLY | O_DIRECTORY | O_CLOEXEC)};
    const FileDescriptor task_directory{::openat(
        process_directory.Get(), "task", O_RDONLY | O_DIRECTORY | O_CLOEXEC)};
    if (!task_directory)
    {
      return std::unexpected(errno);
    }
    for (const auto tid : p_tids)
    {
      State state;
      state.tid_ = tid;
      state.anchor_ = FileDescriptor{
          ::openat(task_directory.Get(), FixedString{"{}", tid}.CStr(),
                   O_RDONLY | O_DIRECTORY | O_CLOEXEC)};
      if (!state.anchor_)
      {
        return std::unexpected(errno);
      }
      constexpr std::array names{"schedstat", "wchan", "stat", "io"};
      for (std::size_t index = 0; index < names.size(); ++index)
      {
        state.files_[index] = FileDescriptor{
            ::openat(state.anchor_.Get(), names[index], O_RDONLY | O_CLOEXEC)};
      }
      std::array<char, kBufferBytes> buffer{};
      const auto stat =
          ReadAtStart(state.files_[2], buffer).and_then(ParseStat);
      if (!stat || !state.files_[0])
      {
        return std::unexpected(ENODATA);
      }
      state.starttime_ = stat->starttime_;
      threads_.push_back(std::move(state));
    }
    return {};
  }

  [[nodiscard]] std::span<const std::optional<Thread::Sample>> Output() const
  {
    return output_;
  }
  [[nodiscard]] std::size_t ReadErrors() const noexcept
  {
    return read_errors_;
  }
  [[nodiscard]] std::size_t Pending() const noexcept
  {
    return completions_.Remaining();
  }

  [[nodiscard]] std::expected<TickCounts, int> Tick(Nanoseconds p_deadline)
  {
    assert(!threads_.empty());
    TickCounts counts;
    std::fill(output_.begin(), output_.end(), std::nullopt);
    if (completions_.Remaining())
    {
      const auto drained = Drain(ClockNow(CLOCK_MONOTONIC));
      if (!drained)
      {
        return std::unexpected(drained.error());
      }
      if (!*drained)
      {
        counts.pending_completion_ = chunk_count_;
        counts.blocked_by_pending_chunk_ = threads_.size() - chunk_count_;
        return counts;
      }
      ReleaseExpired();
    }
    const auto begin = cursor_;
    for (std::size_t visited = 0; visited < threads_.size();)
    {
      chunk_count_ = std::min(kChunkThreads, threads_.size() - visited);
      for (std::size_t slot = 0; slot < chunk_count_; ++slot)
      {
        slots_[slot].thread_ = (begin + visited + slot) % threads_.size();
        slots_[slot].counters_.reset();
        slots_[slot].sample_.reset();
      }
      const auto sampled = SampleChunk(p_deadline, counts);
      if (!sampled)
      {
        return std::unexpected(sampled.error());
      }
      if (!*sampled)
      {
        counts.pending_completion_ = chunk_count_;
        counts.deadline_before_chunk_ =
            threads_.size() - visited - chunk_count_;
        cursor_ = (begin + visited + chunk_count_) % threads_.size();
        if (!completions_.Remaining())
        {
          ReleaseExpired();
        }
        return counts;
      }
      for (std::size_t slot = 0; slot < chunk_count_; ++slot)
      {
        auto& entry = slots_[slot];
        output_[entry.thread_] = entry.sample_;
        if (entry.sample_)
        {
          ++counts.published_;
          counts.reused_ += entry.sample_->reused_;
        }
        else
        {
          ++counts.required_errors_;
        }
      }
      visited += chunk_count_;
    }
    return counts;
  }

 private:
  struct State
  {
    int tid_{};
    FileDescriptor anchor_;
    std::array<FileDescriptor, 4> files_;
    std::uint64_t starttime_{};
    std::size_t inflight_{};
    bool retired_{};
    std::optional<Thread::Sample> kept_;
    SchedulerCounters counters_{};
  };
  struct Slot
  {
    std::size_t thread_{};
    std::array<std::array<char, kBufferBytes>, 2> buffers_{};
    std::array<int, 2> lengths_{};
    std::optional<SchedulerCounters> counters_;
    WaitChannel wchan_{};
    std::optional<Thread::Sample> sample_;
  };

  [[nodiscard]] std::optional<std::string_view> Text(std::size_t p_slot,
                                                     std::size_t p_buffer) const
  {
    const auto& slot = slots_[p_slot];
    const auto length = slot.lengths_[p_buffer];
    if (length <= 0 || std::cmp_greater_equal(length, kBufferBytes))
    {
      return std::nullopt;
    }
    return std::string_view{slot.buffers_[p_buffer].data(),
                            static_cast<std::size_t>(length)};
  }

  // Tags are local to a stage; no next stage starts before this one drains.
  void Queue(std::size_t p_slot, std::size_t p_file, std::size_t p_buffer)
  {
    auto& slot = slots_[p_slot];
    auto& state = threads_[slot.thread_];
    auto* const entry = ::io_uring_get_sqe(&ring_);
    assert(entry != nullptr);
    ::io_uring_prep_read(entry, state.files_[p_file].Get(),
                         slot.buffers_[p_buffer].data(), kBufferBytes, 0);
    entry->user_data = prepared_;
    request_slots_[prepared_] = p_slot;
    request_buffers_[prepared_] = p_buffer;
    ++prepared_;
    ++state.inflight_;
  }

  [[nodiscard]] std::expected<bool, int> Drain(Nanoseconds p_deadline)
  {
    // Each call can consume at most the fixed queue size plus one timeout.
    for (std::size_t attempt = 0; attempt <= kRequests; ++attempt)
    {
      if (::io_uring_sq_ready(&ring_))
      {
        const auto submitted = ::io_uring_submit(&ring_);
        if (submitted < 0 && submitted != -EINTR && submitted != -EAGAIN &&
            submitted != -EBUSY)
        {
          return std::unexpected(-submitted);
        }
      }
      if (!completions_.Remaining())
      {
        return true;
      }
      io_uring_cqe* completion = nullptr;
      auto result = ::io_uring_peek_cqe(&ring_, &completion);
      if (result == -EAGAIN)
      {
        const auto remaining = p_deadline - ClockNow(CLOCK_MONOTONIC);
        if (remaining <= Nanoseconds{0})
        {
          return false;
        }
        __kernel_timespec timeout{remaining.count() / 1'000'000'000,
                                  remaining.count() % 1'000'000'000};
        result = ::io_uring_wait_cqe_timeout(&ring_, &completion, &timeout);
      }
      if (result == -ETIME || result == -EINTR || result == -EAGAIN)
      {
        return false;
      }
      if (result < 0)
      {
        return std::unexpected(-result);
      }
      const auto tag = completion->user_data;
      if (!completions_.Complete(tag))
      {
        return std::unexpected(EPROTO);
      }
      auto& slot = slots_[request_slots_[tag]];
      slot.lengths_[request_buffers_[tag]] = completion->res;
      read_errors_ += completion->res <= 0 ||
                      std::cmp_greater_equal(completion->res, kBufferBytes);
      auto& state = threads_[slot.thread_];
      assert(state.inflight_ > 0);
      --state.inflight_;
      ::io_uring_cqe_seen(&ring_, completion);
    }
    return completions_.Remaining() == 0;
  }

  [[nodiscard]] std::expected<bool, int> Stage(std::size_t p_file,
                                               Nanoseconds p_deadline,
                                               TickCounts& p_counts)
  {
    assert(completions_.Remaining() == 0);
    prepared_ = 0;
    for (std::size_t slot = 0; slot < chunk_count_; ++slot)
    {
      slots_[slot].lengths_.fill(0);
      const auto& state = threads_[slots_[slot].thread_];
      if (state.retired_ ||
          (p_file == 2 && (!slots_[slot].counters_ || slots_[slot].sample_)))
      {
        continue;
      }
      Queue(slot, p_file, 0);
      if (p_file == 2)
      {
        Queue(slot, 3, 1);
      }
    }
    completions_.Prepare(prepared_);
    p_counts.reads_ += prepared_;
    const auto drained = Drain(p_deadline);
    if (!drained || !*drained)
    {
      return drained;
    }
    return ClockNow(CLOCK_MONOTONIC) <= p_deadline;
  }

  [[nodiscard]] std::expected<bool, int> SampleChunk(Nanoseconds p_deadline,
                                                     TickCounts& p_counts)
  {
    const auto counters = Stage(0, p_deadline, p_counts);
    if (!counters || !*counters)
    {
      return counters;
    }
    for (std::size_t slot = 0; slot < chunk_count_; ++slot)
    {
      slots_[slot].counters_ = Text(slot, 0).and_then(ParseSchedstat);
    }
    const auto channels = Stage(1, p_deadline, p_counts);
    if (!channels || !*channels)
    {
      return channels;
    }
    Reuse(p_counts);
    const auto full = Stage(2, p_deadline, p_counts);
    if (!full || !*full)
    {
      return full;
    }
    Encode(p_counts);
    return true;
  }

  void Reuse(TickCounts& p_counts)
  {
    for (std::size_t slot = 0; slot < chunk_count_; ++slot)
    {
      auto& entry = slots_[slot];
      auto& state = threads_[entry.thread_];
      if (!entry.counters_ || state.retired_)
      {
        state.kept_.reset();
        continue;
      }
      const auto text = Text(slot, 0);
      entry.wchan_ = text.transform(ParseWchan).value_or(WaitChannel{});
      p_counts.optional_errors_ += !text.has_value();
      if (state.kept_ && entry.counters_ &&
          state.kept_->record_.state_ == 'S' &&
          *entry.counters_ == state.counters_ &&
          *entry.counters_ != SchedulerCounters{} &&
          entry.wchan_.front() != '\0' &&
          entry.wchan_ == state.kept_->record_.wchan_)
      {
        entry.sample_ = state.kept_;
        entry.sample_->reused_ = true;
      }
      else
      {
        state.kept_.reset();
      }
    }
  }

  void Encode(TickCounts& p_counts)
  {
    for (std::size_t slot = 0; slot < chunk_count_; ++slot)
    {
      auto& entry = slots_[slot];
      auto& state = threads_[entry.thread_];
      if (entry.sample_ || !entry.counters_ || state.retired_)
      {
        continue;
      }
      const auto stat = Text(slot, 0).and_then(ParseStat);
      if (!stat || stat->starttime_ != state.starttime_ ||
          stat->state_ == 'Z' || stat->state_ == 'X')
      {
        state.retired_ = true;
        continue;
      }
      const auto io = Text(slot, 1).and_then(ParseIo);
      p_counts.optional_errors_ += !io.has_value();
      entry.sample_ =
          Thread::Sample{wire::EncodeSample(state.tid_, *stat, *entry.counters_,
                                            io, entry.wchan_),
                         (stat->state_ == 'S' || stat->state_ == 'D') &&
                             entry.wchan_.front() == '\0'};
      state.kept_ = entry.sample_;
      state.counters_ = *entry.counters_;
    }
  }

  void ReleaseExpired()
  {
    for (std::size_t slot = 0; slot < chunk_count_; ++slot)
    {
      auto& state = threads_[slots_[slot].thread_];
      assert(state.inflight_ == 0);
      state.kept_.reset();
    }
  }

  std::vector<State> threads_;
  std::vector<std::optional<Thread::Sample>> output_;
  std::array<Slot, kChunkThreads> slots_{};
  std::array<std::size_t, kRequests> request_slots_{};
  std::array<std::size_t, kRequests> request_buffers_{};
  Completions completions_;
  std::size_t read_errors_{};
  std::size_t prepared_{};
  std::size_t chunk_count_{};
  std::size_t cursor_{};
  io_uring ring_{};
  bool initialized_{};
};

}  // namespace triangulator::experimental
