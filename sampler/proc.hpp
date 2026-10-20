#pragma once

#include <vector>

#include "config.hpp"
#include "protocol.hpp"

namespace triangulator
{

struct TargetIdentity
{
  int pid_{};
  std::uint64_t starttime_{};
  bool operator==(const TargetIdentity&) const = default;
};

// Value: the target, or nullopt when it is absent. Error: errno when the lookup
// itself failed for lack of file descriptors, so the caller must not treat the
// target as gone.
using TargetLookup = std::expected<std::optional<TargetIdentity>, int>;

[[nodiscard]] inline TargetLookup FindTarget(const TargetSelector& p_selector)
{
  int pid = 0;
  std::array<char, 4096> buffer{};
  if (const auto* selected = std::get_if<TargetPid>(&p_selector))
  {
    pid = selected->value_;
  }
  else
  {
    const auto& name = std::get<TargetName>(p_selector).value_;
    Directory directory{"/proc"};
    if (!directory)
    {
      if (DescriptorsExhausted(errno))
      {
        return std::unexpected(errno);
      }
      return std::nullopt;
    }
    while (const auto entry = directory.Next())
    {
      const auto candidate = ParseNumber<int>(*entry);
      if (!candidate || *candidate <= 0)
      {
        continue;
      }
      const auto descriptor =
          OpenReadonly(FixedString{"/proc/{}/comm", *candidate}.CStr());
      if (!descriptor && DescriptorsExhausted(errno))
      {
        return std::unexpected(errno);
      }
      auto comm = ReadAtStart(descriptor, buffer);
      if (!comm)
      {
        continue;
      }
      if (comm->ends_with('\n'))
      {
        comm->remove_suffix(1);
      }
      if (*comm != name)
      {
        continue;
      }
      if (pid != 0)
      {
        return std::nullopt;
      }
      pid = *candidate;
    }
  }
  if (!pid)
  {
    return std::nullopt;
  }
  const auto descriptor =
      OpenReadonly(FixedString{"/proc/{}/stat", pid}.CStr());
  if (!descriptor && DescriptorsExhausted(errno))
  {
    return std::unexpected(errno);
  }
  const auto contents = ReadAtStart(descriptor, buffer);
  const auto stat = contents.and_then(ParseStat);
  if (!stat || stat->state_ == 'Z' || stat->state_ == 'X')
  {
    return std::nullopt;
  }
  return TargetIdentity{pid, stat->starttime_};
}

// One directory scan resolves all names. Each selected PID then gets one
// stat read, including the start time used to detect PID reuse.
[[nodiscard]] inline std::array<TargetLookup, target_wire::kMaxTargets>
FindTargets(std::span<const TargetConfig> p_targets)
{
  std::array<TargetLookup, target_wire::kMaxTargets> results{};
  std::array<int, target_wire::kMaxTargets> pids{};
  std::array<bool, target_wire::kMaxTargets> ambiguous{};
  bool names = false;
  for (std::size_t index = 0; index < p_targets.size(); ++index)
  {
    if (std::holds_alternative<TargetPid>(p_targets[index].selector_))
    {
      results[index] = FindTarget(p_targets[index].selector_);
    }
    else
    {
      names = true;
    }
  }
  if (!names)
  {
    return results;
  }
  int lookup_error = 0;
  Directory directory{"/proc"};
  if (!directory && DescriptorsExhausted(errno))
  {
    lookup_error = errno;
  }
  std::array<char, 4096> buffer{};
  while (directory)
  {
    const auto entry = directory.Next();
    if (!entry)
    {
      break;
    }
    const auto pid = ParseNumber<int>(*entry);
    if (!pid || *pid <= 0)
    {
      continue;
    }
    const auto descriptor =
        OpenReadonly(FixedString{"/proc/{}/comm", *pid}.CStr());
    if (!descriptor && DescriptorsExhausted(errno))
    {
      lookup_error = errno;
      break;
    }
    auto name = ReadAtStart(descriptor, buffer);
    if (!name)
    {
      continue;
    }
    if (name->ends_with('\n'))
    {
      name->remove_suffix(1);
    }
    for (std::size_t index = 0; index < p_targets.size(); ++index)
    {
      const auto* selected =
          std::get_if<TargetName>(&p_targets[index].selector_);
      if (selected && selected->value_ == *name)
      {
        if (pids[index] != 0)
        {
          ambiguous[index] = true;
        }
        pids[index] = *pid;
      }
    }
  }
  for (std::size_t index = 0; index < p_targets.size(); ++index)
  {
    if (std::holds_alternative<TargetName>(p_targets[index].selector_))
    {
      if (lookup_error != 0)
      {
        results[index] = std::unexpected(lookup_error);
      }
      else if (!ambiguous[index] && pids[index] != 0)
      {
        results[index] = FindTarget(TargetPid{pids[index]});
      }
    }
  }
  return results;
}

struct DescriptorBudget
{
  std::size_t limit_ = 0;
  std::size_t kept_ = 0;
};

class Thread
{
 public:
  // Files read per thread each tick: stat, schedstat or status, io, wchan.
  static constexpr std::size_t kDescriptorsPerThread = 4;

  // keep_descriptors: hold the /proc files open between ticks (cheap pread
  // per tick). Otherwise every read opens and closes the file, so this thread
  // costs no descriptors between ticks.
  Thread(int p_tid, bool p_keep_descriptors)
      : tid_(p_tid), keep_descriptors_(p_keep_descriptors)
  {
  }
  [[nodiscard]] int Tid() const noexcept
  {
    return tid_;
  }
  [[nodiscard]] bool KeepsDescriptors() const noexcept
  {
    return keep_descriptors_;
  }
  bool seen_ = false;

  struct Sample
  {
    wire::Record record_;
    bool wchan_hidden_;
  };

  [[nodiscard]] std::optional<Sample> TakeSample(int p_pid, bool p_fallback,
                                                 RateLimitedLogger& p_logger)
  {
    std::array<char, 8192> buffer{};
    auto contents = ReadFile(stat_, p_pid, "stat", buffer);
    if (!contents)
    {
      stat_.Reset();
      ResetCounterDescriptors();
      contents = ReadFile(stat_, p_pid, "stat", buffer);
    }
    const auto stat = contents.and_then(ParseStat);
    if (!stat)
    {
      return std::nullopt;
    }
    if (starttime_ && *starttime_ != stat->starttime_)
    {
      ResetCounterDescriptors();
    }
    starttime_ = stat->starttime_;
    const auto counters =
        p_fallback
            ? ReadFile(status_, p_pid, "status", buffer).and_then(ParseStatus)
            : ReadFile(schedstat_, p_pid, "schedstat", buffer)
                  .and_then(ParseSchedstat);
    if (!counters)
    {
      p_logger.Warn("{}", p_fallback
                              ? "status counters unreadable; sample omitted"
                              : "schedstat unreadable; validate host support "
                                "or configure status_fallback = true");
      return std::nullopt;
    }
    const auto io = ReadFile(io_, p_pid, "io", buffer).and_then(ParseIo);
    const auto wchan = ReadFile(wchan_, p_pid, "wchan", buffer)
                           .transform(ParseWchan)
                           .value_or(WaitChannel{});
    const bool sleeping = stat->state_ == 'S' || stat->state_ == 'D';
    return Sample{wire::EncodeSample(tid_, *stat, *counters, io, wchan),
                  sleeping && wchan.front() == '\0'};
  }

 private:
  void ResetCounterDescriptors() noexcept
  {
    schedstat_.Reset();
    status_.Reset();
    io_.Reset();
    wchan_.Reset();
  }

  [[nodiscard]] std::optional<std::string_view> ReadFile(
      FileDescriptor& p_descriptor, int p_pid, std::string_view p_name,
      std::span<char> p_buffer) const
  {
    if (p_descriptor)
    {
      return ReadAtStart(p_descriptor, p_buffer);
    }
    auto opened = OpenReadonly(
        FixedString{"/proc/{}/task/{}/{}", p_pid, tid_, p_name}.CStr());
    const auto contents = ReadAtStart(opened, p_buffer);
    if (keep_descriptors_)
    {
      p_descriptor = std::move(opened);
    }
    return contents;
  }

  int tid_;
  bool keep_descriptors_;
  FileDescriptor stat_;
  FileDescriptor schedstat_;
  FileDescriptor status_;
  FileDescriptor io_;
  FileDescriptor wchan_;
  std::optional<std::uint64_t> starttime_;
};

class ThreadCache
{
 public:
  // Descriptors left for everything else: stdio, the UDP socket, the /proc
  // and task/ directory scans, the target lookup and per-tick reopens.
  static constexpr std::size_t kReservedDescriptors = 32;

  explicit ThreadCache(std::size_t p_descriptor_limit)
      : max_kept_(p_descriptor_limit > kReservedDescriptors
                      ? (p_descriptor_limit - kReservedDescriptors) /
                            Thread::kDescriptorsPerThread
                      : 0)
  {
    threads_.reserve(wire::kMaxThreads);  // the only allocation; at startup
  }
  explicit ThreadCache(DescriptorBudget& p_budget)
      : ThreadCache(p_budget.limit_)
  {
    shared_budget_ = &p_budget;
  }
  ~ThreadCache()
  {
    Clear();
  }
  ThreadCache(const ThreadCache&) = delete;
  ThreadCache& operator=(const ThreadCache&) = delete;
  ThreadCache(ThreadCache&&) = delete;
  ThreadCache& operator=(ThreadCache&&) = delete;

  void Clear() noexcept
  {
    threads_.clear();
    if (shared_budget_)
    {
      shared_budget_->kept_ -= kept_;
    }
    kept_ = 0;
  }
  [[nodiscard]] std::size_t MaxKept() const noexcept
  {
    return max_kept_;
  }
  [[nodiscard]] std::span<Thread> Threads() noexcept
  {
    return threads_;
  }

  void Rescan(int p_pid, RateLimitedLogger& p_logger)
  {
    std::array<std::size_t, 8192> lookup{};
    const auto slot_for = [&lookup, this](int p_tid)
    {
      auto slot = static_cast<std::size_t>(
          (static_cast<std::uint32_t>(p_tid) * 2654435761U) & 8191U);
      while (lookup[slot] && threads_[lookup[slot] - 1].Tid() != p_tid)
      {
        slot = (slot + 1) & 8191U;
      }
      return slot;
    };
    for (std::size_t index = 0; index < threads_.size(); ++index)
    {
      threads_[index].seen_ = false;
      lookup[slot_for(threads_[index].Tid())] = index + 1;
    }
    Directory directory{FixedString{"/proc/{}/task", p_pid}.CStr()};
    if (!directory)
    {
      // Out of descriptors: keep the cache as it is and try again next tick.
      if (!DescriptorsExhausted(errno))
      {
        Clear();
      }
      return;
    }
    while (const auto entry = directory.Next())
    {
      const auto tid = ParseNumber<int>(*entry);
      if (!tid || *tid <= 0)
      {
        continue;
      }
      const auto slot = slot_for(*tid);
      if (!lookup[slot])
      {
        if (threads_.size() == wire::kMaxThreads)
        {
          p_logger.Warn("thread limit (2550) exceeded; excess threads omitted");
          continue;
        }
        const bool keep =
            (shared_budget_ ? shared_budget_->kept_ : kept_) < max_kept_;
        if (!keep)
        {
          p_logger.Warn(
              "descriptor limit allows keeping files open for {} threads; "
              "others reopen their /proc files every tick",
              max_kept_);
        }
        kept_ += static_cast<std::size_t>(keep);
        if (shared_budget_)
        {
          shared_budget_->kept_ += static_cast<std::size_t>(keep);
        }
        threads_.emplace_back(*tid, keep);
        lookup[slot] = threads_.size();
      }
      threads_[lookup[slot] - 1].seen_ = true;
    }
    std::erase_if(threads_,
                  [this](const Thread& p_thread)
                  {
                    if (p_thread.seen_)
                    {
                      return false;
                    }
                    const auto released =
                        static_cast<std::size_t>(p_thread.KeepsDescriptors());
                    kept_ -= released;
                    if (shared_budget_)
                    {
                      shared_budget_->kept_ -= released;
                    }
                    return true;
                  });
  }

 private:
  DescriptorBudget* shared_budget_ = nullptr;
  std::size_t max_kept_;
  std::size_t kept_ = 0;
  std::vector<Thread> threads_;
};

}  // namespace triangulator
