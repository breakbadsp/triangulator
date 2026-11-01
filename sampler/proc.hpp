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

// Value: the target, or nullopt when it is confirmed gone. Error: errno when
// the read could not decide, such as a permission error, a short or
// unparseable stat, or no file descriptors left. The caller must then treat
// the target as neither gone nor present: skip the tick, keep the session.
using TargetLookup = std::expected<std::optional<TargetIdentity>, int>;

// One stat read. Value: the parsed stat, or nullopt when the process is
// confirmed gone: no /proc entry (ENOENT, or ESRCH from a process that exited
// after the open), or a zombie or dead state. Error: see TargetLookup. p_root
// is /proc, or a test directory in the same layout.
[[nodiscard]] inline std::expected<std::optional<ThreadStat>, int>
ReadProcessStat(int p_pid, const char* p_root = "/proc")
{
  if (p_pid <= 0)
  {
    return std::nullopt;
  }
  const auto descriptor =
      OpenReadonly(FixedString{"{}/{}/stat", p_root, p_pid}.CStr());
  if (!descriptor)
  {
    if (errno == ENOENT || errno == ESRCH)
    {
      return std::nullopt;
    }
    return std::unexpected(errno);
  }
  std::array<char, 4096> buffer{};
  errno = 0;
  const auto contents = ReadAtStart(descriptor, buffer);
  if (!contents)
  {
    if (errno == ESRCH)
    {
      return std::nullopt;
    }
    // Empty or longer than the buffer: a stat line is far shorter.
    return std::unexpected(errno != 0 ? errno : EIO);
  }
  const auto stat = ParseStat(*contents);
  if (!stat)
  {
    return std::unexpected(EBADMSG);
  }
  if (stat->state_ == 'Z' || stat->state_ == 'X')
  {
    return std::nullopt;
  }
  return stat;
}

[[nodiscard]] inline TargetLookup FindTarget(const TargetPid& p_selector,
                                             const char* p_root = "/proc")
{
  return ReadProcessStat(p_selector.value_, p_root)
      .transform(
          [&p_selector](const std::optional<ThreadStat>& p_stat)
          {
            return p_stat.transform(
                [&p_selector](const ThreadStat& p_found)
                {
                  return TargetIdentity{p_selector.value_, p_found.starttime_};
                });
          });
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
      // The process is gone. Any other failure, such as running out of
      // descriptors, keeps the cache, and the next tick tries again.
      if (errno == ENOENT || errno == ESRCH)
      {
        Clear();
      }
      return;
    }
    for (;;)
    {
      const auto entry = directory.Next();
      if (!entry)
      {
        // An incomplete scan does not show which threads ended.
        if (entry.error() == ENOENT || entry.error() == ESRCH)
        {
          Clear();
        }
        return;
      }
      if (!*entry)
      {
        break;
      }
      const auto tid = ParseNumber<int>(**entry);
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
