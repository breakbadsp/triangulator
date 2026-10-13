#include <array>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <exception>
#include <expected>
#include <string_view>
#include <vector>

#include "../sampler/proc.hpp"

namespace triangulator
{
namespace
{
using Records = std::array<wire::Record, wire::kMaxThreads>;

[[nodiscard]] std::expected<int, std::string_view> ParseArgument(
    std::string_view p_argument, int p_minimum, int p_maximum)
{
  int value = 0;
  const auto parsed = std::from_chars(
      p_argument.data(), p_argument.data() + p_argument.size(), value);
  if (parsed.ec != std::errc{} ||
      parsed.ptr != p_argument.data() + p_argument.size() ||
      value < p_minimum || value > p_maximum)
  {
    return std::unexpected("argument is outside its permitted range");
  }
  return value;
}

// Use the production sampler functions. Retain every record as SampleTick does.
[[nodiscard]] std::expected<void, std::string_view> SampleThreads(
    int p_pid, std::size_t p_thread_count, ThreadCache& p_cache,
    RateLimitedLogger& p_logger, Records& p_records)
{
  const auto target = FindTarget(TargetSelector{TargetPid{p_pid}});
  if (!target || !*target)
  {
    return std::unexpected("target is absent or unreadable");
  }
  p_cache.Rescan(p_pid, p_logger);
  if (p_cache.Threads().size() != p_thread_count)
  {
    return std::unexpected("target thread count changed");
  }
  std::size_t index = 0;
  for (auto& thread : p_cache.Threads())
  {
    const auto sample = thread.TakeSample(p_pid, false, p_logger);
    if (!sample || sample->record_.flags_ == wire::RecordFlags::IoUnavailable)
    {
      return std::unexpected("thread sample is absent or incomplete");
    }
    p_records[index++] = sample->record_;
  }
  return {};
}
}  // namespace
}  // namespace triangulator

int main(int p_argc, char** p_argv)
{
  if (p_argc != 5)
  {
    std::fputs("usage: benchmark-sampling PID THREADS ITERATIONS WARMUP_MS\n",
               stderr);
    return 2;
  }
  const auto pid = triangulator::ParseArgument(p_argv[1], 1, 2147483647);
  const auto threads = triangulator::ParseArgument(p_argv[2], 1, 500);
  const auto iterations = triangulator::ParseArgument(p_argv[3], 100, 1000000);
  const auto warmup_ms = triangulator::ParseArgument(p_argv[4], 0, 60000);
  if (!pid || !threads || !iterations || !warmup_ms)
  {
    std::fputs("benchmark sampling: invalid arguments\n", stderr);
    return 2;
  }
  try
  {
    triangulator::ThreadCache cache{triangulator::RaiseDescriptorLimit()};
    triangulator::RateLimitedLogger logger;
    triangulator::Records records{};
    const auto thread_count = static_cast<std::size_t>(*threads);
    if (cache.MaxKept() < thread_count)
    {
      std::fputs("benchmark sampling: descriptor limit is too small\n", stderr);
      return 1;
    }
    std::vector<std::int64_t> latency_ns(static_cast<std::size_t>(*iterations));
    const auto deadline = triangulator::ClockNow(CLOCK_MONOTONIC) +
                          std::chrono::milliseconds{*warmup_ms};
    // At least one untimed pass opens the cached descriptors, even at zero
    // warmup.
    do
    {
      const auto sampled = triangulator::SampleThreads(*pid, thread_count,
                                                       cache, logger, records);
      if (!sampled)
      {
        std::fprintf(stderr, "benchmark sampling: %.*s\n",
                     static_cast<int>(sampled.error().size()),
                     sampled.error().data());
        return 1;
      }
    } while (triangulator::ClockNow(CLOCK_MONOTONIC) < deadline);
    for (auto& elapsed : latency_ns)
    {
      const auto started = triangulator::ClockNow(CLOCK_MONOTONIC);
      const auto sampled = triangulator::SampleThreads(*pid, thread_count,
                                                       cache, logger, records);
      // GCC and Clang must retain the complete record writes. This empty
      // compiler barrier emits no instructions and performs no network I/O.
      asm volatile("" : : "g"(records.data()) : "memory");
      elapsed = (triangulator::ClockNow(CLOCK_MONOTONIC) - started).count();
      if (!sampled)
      {
        std::fprintf(stderr, "benchmark sampling: %.*s\n",
                     static_cast<int>(sampled.error().size()),
                     sampled.error().data());
        return 1;
      }
    }
    // Output happens after every timed pass. The Python driver calculates
    // exact percentiles from these durations and stores the run summaries.
    std::printf("{\"threads\":%d,\"latency_ns\":[", *threads);
    for (std::size_t index = 0; index < latency_ns.size(); ++index)
    {
      std::printf("%s%lld", index == 0 ? "" : ",",
                  static_cast<long long>(latency_ns[index]));
    }
    std::puts("]}");
  }
  catch (const std::exception& p_error)
  {
    std::fprintf(stderr, "benchmark sampling: %s\n", p_error.what());
    return 1;
  }
}
