#include <sys/resource.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <exception>
#include <expected>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "uring.hpp"

namespace triangulator::experimental
{
namespace
{
constexpr std::int64_t kSecondNs = 1'000'000'000;

struct Cpu
{
  std::int64_t process_ns_{};
  std::int64_t usage_ns_{};
  std::int64_t reader_ns_{};
  std::uint64_t worker_ns_{};
  std::array<int, 128> worker_ids_{};
  std::size_t workers_{};
};

[[nodiscard]] Cpu ReadCpu()
{
  Cpu cpu;
  Directory tasks{"/proc/self/task"};
  std::array<char, 256> buffer{};
  for (std::size_t index = 0; tasks && index < 256; ++index)
  {
    const auto entry = tasks.Next();
    if (!entry || !*entry)
    {
      break;
    }
    const auto tid = ParseNumber<int>(**entry);
    if (!tid)
    {
      continue;
    }
    const auto name_fd =
        OpenReadonly(FixedString{"/proc/self/task/{}/comm", *tid}.CStr());
    const auto name = ReadAtStart(name_fd, buffer);
    if (!name || !name->starts_with("iou-wrk"))
    {
      continue;
    }
    const auto stat_fd =
        OpenReadonly(FixedString{"/proc/self/task/{}/schedstat", *tid}.CStr());
    const auto stat = ReadAtStart(stat_fd, buffer).and_then(ParseSchedstat);
    if (stat && cpu.workers_ < cpu.worker_ids_.size())
    {
      cpu.worker_ids_[cpu.workers_++] = *tid;
      cpu.worker_ns_ += stat->runtime_;
    }
  }
  rusage usage{};
  ::getrusage(RUSAGE_SELF, &usage);
  cpu.usage_ns_ = (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * kSecondNs +
                  (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) * 1000;
  cpu.reader_ns_ = ClockNow(CLOCK_THREAD_CPUTIME_ID).count();
  cpu.process_ns_ = ClockNow(CLOCK_PROCESS_CPUTIME_ID).count();
  return cpu;
}

[[nodiscard]] std::string CpuJson(const Cpu& p_cpu)
{
  auto ids = std::string{"["};
  for (std::size_t index = 0; index < p_cpu.workers_; ++index)
  {
    ids += std::format("{}{}", index ? "," : "", p_cpu.worker_ids_[index]);
  }
  ids += "]";
  return std::format(
      R"({{"process_ns":{},"getrusage_ns":{},"reader_ns":{},"visible_worker_ns":{},"worker_ids":{}}})",
      p_cpu.process_ns_, p_cpu.usage_ns_, p_cpu.reader_ns_, p_cpu.worker_ns_,
      ids);
}

[[nodiscard]] bool SameFields(const wire::Record& p_left,
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

struct Verification
{
  std::size_t checked_{};
  std::size_t races_{};
  std::size_t misses_{};
  std::size_t unavailable_{};
};

void Verify(int p_pid, const Thread::Sample& p_sample, Thread& p_truth,
            RateLimitedLogger& p_logger, Verification& p_result)
{
  if (!p_sample.reused_)
  {
    return;
  }
  ++p_result.checked_;
  const auto full = p_truth.TakeSample(p_pid, false, p_logger);
  if (!full)
  {
    ++p_result.unavailable_;
    return;
  }
  if (SameFields(p_sample.record_, full->record_))
  {
    return;
  }
  const auto later = p_truth.TakeSample(p_pid, false, p_logger);
  const auto changed = [&p_sample](const Thread::Sample& p_other)
  {
    return p_sample.record_.wchan_ != p_other.record_.wchan_ ||
           p_sample.record_.run_delay_ != p_other.record_.run_delay_ ||
           p_sample.record_.timeslices_ != p_other.record_.timeslices_;
  };
  if (changed(*full) || (later && changed(*later)))
  {
    ++p_result.races_;
    return;
  }
  ++p_result.misses_;
}

struct Options
{
  bool uring_{};
  int pid_{};
  int ticks_{};
  int rate_{};
  bool verify_{};
};

class Trial final
{
 public:
  explicit Trial(Options p_options) : options_(p_options)
  {
  }

  [[nodiscard]] std::expected<int, int> Run()
  {
    const auto initialized = Initialize();
    if (!initialized)
    {
      return std::unexpected(initialized.error());
    }
    const auto measured = Measure();
    if (!measured)
    {
      return std::unexpected(measured.error());
    }
    Finish();
    Report();
    return verification_.misses_ ? 1 : 0;
  }

 private:
  [[nodiscard]] std::expected<void, int> Initialize()
  {
    baseline_.Rescan(options_.pid_, logger_);
    for (const auto& thread : baseline_.Threads())
    {
      tids_.push_back(thread.Tid());
      truth_.emplace_back(thread.Tid(), false);
    }
    if (tids_.empty())
    {
      return std::unexpected(ESRCH);
    }
    if (options_.uring_)
    {
      auto made = Sampler::Create();
      if (!made)
      {
        return std::unexpected(made.error());
      }
      sampler_ = std::move(*made);
      const auto admitted = sampler_->Admit(options_.pid_, tids_);
      if (!admitted)
      {
        return std::unexpected(admitted.error());
      }
    }
    durations_.resize(static_cast<std::size_t>(options_.ticks_));
    samples_.resize(tids_.size());
    return {};
  }

  [[nodiscard]] std::expected<TickCounts, int> Sample(Nanoseconds p_deadline)
  {
    TickCounts counts;
    if (sampler_)
    {
      const auto taken = sampler_->Tick(p_deadline);
      if (!taken)
      {
        return std::unexpected(taken.error());
      }
      counts = *taken;
      std::ranges::copy(sampler_->Output(), samples_.begin());
    }
    else
    {
      for (std::size_t index = 0; index < tids_.size(); ++index)
      {
        if (ClockNow(CLOCK_MONOTONIC) >= p_deadline)
        {
          counts.deadline_before_chunk_ += tids_.size() - index;
          std::fill(samples_.begin() + static_cast<std::ptrdiff_t>(index),
                    samples_.end(), std::nullopt);
          break;
        }
        samples_[index] = baseline_.Threads()[index].TakeSample(options_.pid_,
                                                                false, logger_);
        counts.published_ += samples_[index].has_value();
        counts.required_errors_ += !samples_[index].has_value();
        if (samples_[index])
        {
          counts.reused_ += samples_[index]->reused_;
        }
      }
    }
    return counts;
  }

  void Record(int p_tick, Nanoseconds p_elapsed, const TickCounts& p_counts)
  {
    durations_[static_cast<std::size_t>(p_tick)] = p_elapsed.count();
    totals_.published_ += p_counts.published_;
    totals_.reused_ += p_counts.reused_;
    totals_.required_errors_ += p_counts.required_errors_;
    totals_.optional_errors_ += p_counts.optional_errors_;
    totals_.pending_completion_ += p_counts.pending_completion_;
    totals_.blocked_by_pending_chunk_ += p_counts.blocked_by_pending_chunk_;
    totals_.deadline_before_chunk_ += p_counts.deadline_before_chunk_;
    totals_.reads_ += p_counts.reads_;
    missed_ += ClockNow(CLOCK_MONOTONIC) > deadline_;
    for (std::size_t index = 0; index < samples_.size(); ++index)
    {
      if (samples_[index])
      {
        checksum_ += samples_[index]->record_.tid_;
        if (options_.verify_)
        {
          Verify(options_.pid_, *samples_[index], truth_[index], logger_,
                 verification_);
        }
      }
    }
  }

  [[nodiscard]] std::expected<void, int> Measure()
  {
    const Nanoseconds period{kSecondNs / options_.rate_};
    deadline_ = ClockNow(CLOCK_MONOTONIC);
    constexpr int kWarmupTicks = 3;
    for (int tick = -kWarmupTicks; tick < options_.ticks_; ++tick)
    {
      if (tick == 0)
      {
        begin_ = ReadCpu();
        window_start_ = ClockNow(CLOCK_MONOTONIC);
        deadline_ = window_start_;
      }
      deadline_ += period;
      const auto start = ClockNow(CLOCK_MONOTONIC);
      const auto sampled = Sample(deadline_);
      if (!sampled)
      {
        return std::unexpected(sampled.error());
      }
      const auto elapsed = ClockNow(CLOCK_MONOTONIC) - start;
      if (tick >= 0)
      {
        Record(tick, elapsed, *sampled);
      }
      const timespec wake{deadline_.count() / kSecondNs,
                          deadline_.count() % kSecondNs};
      ::clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &wake, nullptr);
    }
    return {};
  }

  void Finish()
  {
    window_ns_ = (ClockNow(CLOCK_MONOTONIC) - window_start_).count();
    end_ = ReadCpu();
    errors_ = sampler_ ? sampler_->ReadErrors() : 0;
    pending_ = sampler_ ? sampler_->Pending() : 0;
    sampler_.reset();
    after_teardown_ = ReadCpu();
    for (int attempt = 0; attempt < 20 && after_teardown_.workers_; ++attempt)
    {
      ::usleep(1000);
      after_teardown_ = ReadCpu();
    }
  }

  void Report() const
  {
    auto latency = std::string{"["};
    for (const auto value : durations_)
    {
      latency += std::format("{}{}", latency.size() > 1 ? "," : "", value);
    }
    latency += "]";
    std::puts(
        std::format(
            R"({{"backend":"{}","pid":{},"threads":{},"ticks":{},"rate_hz":{},"verify":{},"cohort":"startup-only","published":{},"reused":{},"required_errors":{},"optional_errors":{},"pending_completion":{},"blocked_by_pending_chunk":{},"deadline_before_chunk":{},"submitted_reads":{},"read_completion_errors_including_warmup":{},"pending_at_end":{},"missed_deadlines":{},"window_ns":{},"cpu_begin":{},"cpu_end":{},"cpu_after_teardown":{},"latency_ns":{},"verified_reused":{},"verification_races":{},"verification_misses":{},"verification_unavailable":{},"checksum":{},"sync_read_errors":"unavailable","total_cpu_coverage":"unvalidated"}})",
            options_.uring_ ? "uring" : "sync", options_.pid_, tids_.size(),
            options_.ticks_, options_.rate_, options_.verify_,
            totals_.published_, totals_.reused_, totals_.required_errors_,
            options_.uring_ ? std::to_string(totals_.optional_errors_) : "null",
            totals_.pending_completion_, totals_.blocked_by_pending_chunk_,
            totals_.deadline_before_chunk_,
            options_.uring_ ? std::to_string(totals_.reads_) : "null",
            options_.uring_ ? std::to_string(errors_) : "null", pending_,
            missed_, window_ns_, CpuJson(begin_), CpuJson(end_),
            CpuJson(after_teardown_), latency, verification_.checked_,
            verification_.races_, verification_.misses_,
            verification_.unavailable_, checksum_)
            .c_str());
  }

  Options options_;
  RateLimitedLogger logger_;
  ThreadCache baseline_{RaiseDescriptorLimit()};
  std::vector<int> tids_;
  std::vector<Thread> truth_;
  std::unique_ptr<Sampler> sampler_;
  std::vector<std::int64_t> durations_;
  std::vector<std::optional<Thread::Sample>> samples_;
  TickCounts totals_;
  Verification verification_;
  std::size_t missed_{};
  std::uint64_t checksum_{};
  Cpu begin_;
  Cpu end_;
  Cpu after_teardown_;
  Nanoseconds deadline_{};
  Nanoseconds window_start_{};
  std::int64_t window_ns_{};
  std::size_t errors_{};
  std::size_t pending_{};
};

}  // namespace
}  // namespace triangulator::experimental

int main(int p_argc, char** p_argv)
{
  using namespace triangulator;
  if (p_argc < 5 || p_argc > 6)
  {
    std::fputs(
        "usage: experimental-sampling sync|uring PID TICKS RATE_HZ [verify]\n",
        stderr);
    return 2;
  }
  const std::string_view backend{p_argv[1]};
  const auto pid = ParseNumber<int>(p_argv[2]);
  const auto ticks = ParseNumber<int>(p_argv[3]);
  const auto rate = ParseNumber<int>(p_argv[4]);
  if ((backend != "sync" && backend != "uring") || !pid || *pid <= 0 ||
      !ticks || *ticks < 1 || *ticks > 100000 || !rate || *rate < 1 ||
      *rate > 1000 || (p_argc == 6 && std::string_view{p_argv[5]} != "verify"))
  {
    return 2;
  }
  try
  {
    const auto result = experimental::Trial{{backend == "uring", *pid, *ticks,
                                             *rate, p_argc == 6}}
                            .Run();
    if (!result)
    {
      std::fprintf(stderr, "experimental-sampling: %s (errno %d)\n",
                   std::strerror(result.error()), result.error());
      return result.error() == EPERM || result.error() == ENOSYS ||
                     result.error() == EACCES || result.error() == EOPNOTSUPP
                 ? 77
                 : 1;
    }
    return *result;
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "experimental-sampling: %s\n", error.what());
    return 1;
  }
}
