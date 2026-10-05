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
    const Directory directory{::opendir("/proc")};
    if (!directory)
    {
      if (DescriptorsExhausted(errno))
      {
        return std::unexpected(errno);
      }
      return std::nullopt;
    }
    while (const auto* entry = ::readdir(directory.get()))
    {
      const auto candidate = ParseNumber<int>(entry->d_name);
      if (!candidate || *candidate <= 0)
      {
        continue;
      }
      const auto descriptor =
          OpenReadonly(std::format("/proc/{}/comm", *candidate).c_str());
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
      OpenReadonly(std::format("/proc/{}/stat", pid).c_str());
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
    wire::RecordBytes record_;
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
      p_logger.Warn(p_fallback ? "status counters unreadable; sample omitted"
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
        std::format("/proc/{}/task/{}/{}", p_pid, tid_, p_name).c_str());
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
    threads_.reserve(wire::kMaxThreads);
  }
  void Clear() noexcept
  {
    threads_.clear();
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
    const Directory directory{
        ::opendir(std::format("/proc/{}/task", p_pid).c_str())};
    if (!directory)
    {
      // Out of descriptors: keep the cache as it is and try again next tick.
      if (!DescriptorsExhausted(errno))
      {
        Clear();
      }
      return;
    }
    while (const auto* entry = ::readdir(directory.get()))
    {
      const auto tid = ParseNumber<int>(entry->d_name);
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
        const bool keep = kept_ < max_kept_;
        if (!keep)
        {
          p_logger.Warn(std::format(
              "descriptor limit allows keeping files open for {} threads; "
              "others reopen their /proc files every tick",
              max_kept_));
        }
        kept_ += static_cast<std::size_t>(keep);
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
                    kept_ -=
                        static_cast<std::size_t>(p_thread.KeepsDescriptors());
                    return true;
                  });
  }

 private:
  std::size_t max_kept_;
  std::size_t kept_ = 0;
  std::vector<Thread> threads_;
};

}  // namespace triangulator
