// Compares the quiet-thread skip with full reads on a live target, using the
// production Thread code. One cache keeps descriptors, so it can send kept
// records. A second cache keeps none, so each of its samples is a full read.
// Each tick samples a thread in the first cache, then in the second.
//
// A mismatch on a sent kept record is a race when the full read, or a second
// full read right after it, shows a newer schedstat or wchan: the thread ran
// or woke after the first read, and the sampler sends what it saw. A woken
// thread shows wchan 0 until it runs, and a run changes schedstat, so the
// second read catches a wake during the first full read too. Any other
// mismatch is a miss.
//
// Usage: skip-differential PID RATE_HZ SECONDS. Exit status 1 on a miss.

#include <array>
#include <charconv>
#include <cstdio>
#include <exception>
#include <string_view>

#include "../sampler/proc.hpp"

namespace triangulator
{
namespace
{

constexpr std::int64_t kNanosecondsPerSecond = 1'000'000'000;

struct Totals
{
  std::uint64_t ticks_ = 0;
  std::uint64_t thread_ticks_ = 0;
  std::uint64_t reused_ = 0;
  std::uint64_t races_ = 0;
  std::uint64_t misses_ = 0;
};

[[nodiscard]] std::optional<int> ParseArgument(std::string_view p_text)
{
  int value = 0;
  const auto parsed =
      std::from_chars(p_text.data(), p_text.data() + p_text.size(), value);
  if (parsed.ec != std::errc{} || parsed.ptr != p_text.data() + p_text.size() ||
      value < 1)
  {
    return std::nullopt;
  }
  return value;
}

// The fields a full read sets from stat, io and wchan.
[[nodiscard]] bool SameReadFields(const wire::Record& p_left,
                                  const wire::Record& p_right)
{
  return p_left.state_ == p_right.state_ && p_left.comm_ == p_right.comm_ &&
         p_left.utime_ == p_right.utime_ && p_left.stime_ == p_right.stime_ &&
         p_left.major_faults_ == p_right.major_faults_ &&
         p_left.processor_ == p_right.processor_ &&
         p_left.read_bytes_ == p_right.read_bytes_ &&
         p_left.write_bytes_ == p_right.write_bytes_ &&
         p_left.flags_ == p_right.flags_ && p_left.wchan_ == p_right.wchan_;
}

[[nodiscard]] bool ChangedAfter(const wire::Record& p_sent,
                                const wire::Record& p_full)
{
  return p_full.wchan_ != p_sent.wchan_ ||
         p_full.run_delay_ != p_sent.run_delay_ ||
         p_full.timeslices_ != p_sent.timeslices_;
}

// The names are NUL-padded and can fill their field, so print them by size.
void PrintMiss(const wire::Record& p_sent, const wire::Record& p_full)
{
  const auto print = [](const char* p_label, const wire::Record& p_record)
  {
    std::printf(
        " %s state %c utime %llu stime %llu wchan %.*s comm %.*s;", p_label,
        p_record.state_, static_cast<unsigned long long>(p_record.utime_),
        static_cast<unsigned long long>(p_record.stime_),
        static_cast<int>(p_record.wchan_.size()), p_record.wchan_.data(),
        static_cast<int>(p_record.comm_.size()), p_record.comm_.data());
  };
  std::printf("miss tid %u:", p_sent.tid_);
  print("sent", p_sent);
  print("full", p_full);
  std::printf("\n");
}

void Tick(int p_pid, ThreadCache& p_kept, ThreadCache& p_full,
          RateLimitedLogger& p_logger, Totals& p_totals)
{
  p_kept.Rescan(p_pid, p_logger);
  p_full.Rescan(p_pid, p_logger);
  ++p_totals.ticks_;
  for (auto& thread : p_kept.Threads())
  {
    const auto sent = thread.TakeSample(p_pid, false, p_logger);
    if (!sent)
    {
      continue;
    }
    for (auto& truth : p_full.Threads())
    {
      if (truth.Tid() != thread.Tid())
      {
        continue;
      }
      const auto full = truth.TakeSample(p_pid, false, p_logger);
      if (!full)
      {
        break;
      }
      ++p_totals.thread_ticks_;
      if (!sent->reused_)
      {
        break;
      }
      ++p_totals.reused_;
      if (SameReadFields(sent->record_, full->record_))
      {
        break;
      }
      const auto later = truth.TakeSample(p_pid, false, p_logger);
      if (ChangedAfter(sent->record_, full->record_) ||
          (later && ChangedAfter(sent->record_, later->record_)))
      {
        ++p_totals.races_;
        break;
      }
      ++p_totals.misses_;
      PrintMiss(sent->record_, full->record_);
      break;
    }
  }
}

}  // namespace
}  // namespace triangulator

int main(int p_argc, char** p_argv)
{
  using namespace triangulator;
  if (p_argc != 4)
  {
    std::fputs("usage: skip-differential PID RATE_HZ SECONDS\n", stderr);
    return 2;
  }
  const auto pid = ParseArgument(p_argv[1]);
  const auto rate = ParseArgument(p_argv[2]);
  const auto seconds = ParseArgument(p_argv[3]);
  if (!pid || !rate || !seconds)
  {
    std::fputs("skip-differential: invalid arguments\n", stderr);
    return 2;
  }
  try
  {
    ThreadCache kept{RaiseDescriptorLimit()};
    ThreadCache full{ThreadCache::kReservedDescriptors};
    RateLimitedLogger logger;
    Totals totals;
    const Nanoseconds period{kNanosecondsPerSecond / *rate};
    auto deadline = ClockNow(CLOCK_MONOTONIC);
    const auto end = deadline + Nanoseconds{kNanosecondsPerSecond * *seconds};
    while (deadline < end)
    {
      deadline += period;
      const timespec wake{
          .tv_sec =
              static_cast<time_t>(deadline.count() / kNanosecondsPerSecond),
          .tv_nsec =
              static_cast<long>(deadline.count() % kNanosecondsPerSecond)};
      ::clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &wake, nullptr);
      Tick(*pid, kept, full, logger, totals);
    }
    const auto share = totals.thread_ticks_
                           ? 100.0 * static_cast<double>(totals.reused_) /
                                 static_cast<double>(totals.thread_ticks_)
                           : 0.0;
    std::printf(
        "ticks %llu thread_ticks %llu reused %llu (%.1f%%) races %llu "
        "misses %llu\n",
        static_cast<unsigned long long>(totals.ticks_),
        static_cast<unsigned long long>(totals.thread_ticks_),
        static_cast<unsigned long long>(totals.reused_), share,
        static_cast<unsigned long long>(totals.races_),
        static_cast<unsigned long long>(totals.misses_));
    return totals.misses_ == 0 ? 0 : 1;
  }
  catch (const std::exception& p_error)
  {
    std::fprintf(stderr, "skip-differential: %s\n", p_error.what());
    return 1;
  }
}
