#include <array>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <exception>
#include <expected>
#include <optional>
#include <string_view>
#include <vector>

#include "../sampler/memory.hpp"
#include "../sampler/proc.hpp"
#include "../sampler/resources.hpp"

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

// CPU time of this thread. The sampler has one thread, so this is the CPU one
// sample costs, apart from the wall time spent waiting.
[[nodiscard]] std::int64_t ThreadCpuNs()
{
  return ClockNow(CLOCK_THREAD_CPUTIME_ID).count();
}

// One resource sample, as the sampler takes it on a tick.
void SampleResources(int p_pid, ResourceProbe& p_probe)
{
  const auto sample = p_probe.Sample(p_pid);
  asm volatile("" : : "g"(&sample) : "memory");
}

// One whole memory-map sample, read to the end at once. The sampler spreads
// the same reads over several ticks; the total work is the same. The layout is
// always requested, which is the costlier case.
[[nodiscard]] std::optional<MemorySample> SampleMemory(int p_pid,
                                                       MemoryProbe& p_probe)
{
  p_probe.Start(p_pid, true);
  auto sample = p_probe.Continue(Nanoseconds::max());
  asm volatile("" : : "g"(&sample) : "memory");
  return sample;
}

enum class Kind
{
  Threads = 0,
  Resources,
  Memory,
};
}  // namespace
}  // namespace triangulator

int main(int p_argc, char** p_argv)
{
  if (p_argc != 5 && p_argc != 6)
  {
    std::fputs(
        "usage: benchmark-sampling PID THREADS ITERATIONS WARMUP_MS "
        "[threads|resources|memory]\n",
        stderr);
    return 2;
  }
  const auto pid = triangulator::ParseArgument(p_argv[1], 1, 2147483647);
  const auto threads = triangulator::ParseArgument(p_argv[2], 1, 500);
  const auto iterations = triangulator::ParseArgument(p_argv[3], 100, 1000000);
  const auto warmup_ms = triangulator::ParseArgument(p_argv[4], 0, 60000);
  const std::string_view kind_name = p_argc == 6 ? p_argv[5] : "threads";
  auto kind = triangulator::Kind::Threads;
  if (kind_name == "resources")
  {
    kind = triangulator::Kind::Resources;
  }
  else if (kind_name == "memory")
  {
    kind = triangulator::Kind::Memory;
  }
  else if (kind_name != "threads")
  {
    std::fputs("benchmark sampling: unknown sample kind\n", stderr);
    return 2;
  }
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
    triangulator::ResourceProbe resources;
    triangulator::MemoryProbe memory;
    // Longest single maps read and total read time of each memory sample,
    // in microseconds, as the sampler reports them.
    std::vector<std::uint64_t> maps_longest_read_us;
    std::vector<std::uint64_t> maps_read_us;
    std::uint64_t maps_lines = 0;
    const auto thread_count = static_cast<std::size_t>(*threads);
    if (cache.MaxKept() < thread_count)
    {
      std::fputs("benchmark sampling: descriptor limit is too small\n", stderr);
      return 1;
    }
    // One sample of the chosen kind. Returns an error text, or nullptr.
    const auto take_sample = [&]() -> const char*
    {
      switch (kind)
      {
        case triangulator::Kind::Resources:
          triangulator::SampleResources(*pid, resources);
          return nullptr;
        case triangulator::Kind::Memory:
        {
          const auto sample = triangulator::SampleMemory(*pid, memory);
          if (!sample || sample->regions_.empty())
          {
            return "memory sample is absent or has no layout";
          }
          using triangulator::memory_wire::Field;
          maps_longest_read_us.push_back(
              sample->summary_[Field("maps_read_max_us")]);
          maps_read_us.push_back(sample->summary_[Field("maps_read_us")]);
          maps_lines = sample->summary_[Field("vma_count")];
          return nullptr;
        }
        case triangulator::Kind::Threads:
          break;
      }
      const auto sampled = triangulator::SampleThreads(*pid, thread_count,
                                                       cache, logger, records);
      // GCC and Clang must retain the complete record writes. This empty
      // compiler barrier emits no instructions and performs no network I/O.
      asm volatile("" : : "g"(records.data()) : "memory");
      return sampled ? nullptr : sampled.error().data();
    };
    std::vector<std::int64_t> latency_ns(static_cast<std::size_t>(*iterations));
    std::vector<std::int64_t> cpu_ns(latency_ns.size());
    const auto deadline = triangulator::ClockNow(CLOCK_MONOTONIC) +
                          std::chrono::milliseconds{*warmup_ms};
    // At least one untimed pass opens the cached descriptors, even at zero
    // warmup.
    do
    {
      if (const auto* error = take_sample())
      {
        std::fprintf(stderr, "benchmark sampling: %s\n", error);
        return 1;
      }
    } while (triangulator::ClockNow(CLOCK_MONOTONIC) < deadline);
    maps_longest_read_us.clear();
    maps_read_us.clear();
    for (std::size_t index = 0; index < latency_ns.size(); ++index)
    {
      const auto cpu_started = triangulator::ThreadCpuNs();
      const auto started = triangulator::ClockNow(CLOCK_MONOTONIC);
      const auto* error = take_sample();
      latency_ns[index] =
          (triangulator::ClockNow(CLOCK_MONOTONIC) - started).count();
      cpu_ns[index] = triangulator::ThreadCpuNs() - cpu_started;
      if (error != nullptr)
      {
        std::fprintf(stderr, "benchmark sampling: %s\n", error);
        return 1;
      }
    }
    // Output happens after every timed pass. The Python driver calculates
    // exact percentiles from these durations and stores the run summaries.
    const auto print_list = [](const char* p_name, const auto& p_values)
    {
      std::printf(",\"%s\":[", p_name);
      for (std::size_t index = 0; index < p_values.size(); ++index)
      {
        std::printf("%s%lld", index == 0 ? "" : ",",
                    static_cast<long long>(p_values[index]));
      }
      std::fputs("]", stdout);
    };
    std::printf("{\"threads\":%d", *threads);
    print_list("latency_ns", latency_ns);
    print_list("cpu_ns", cpu_ns);
    if (kind == triangulator::Kind::Memory)
    {
      print_list("maps_read_us", maps_read_us);
      print_list("maps_longest_read_us", maps_longest_read_us);
      std::printf(",\"maps_lines\":%llu",
                  static_cast<unsigned long long>(maps_lines));
    }
    std::puts("}");
  }
  catch (const std::exception& p_error)
  {
    std::fprintf(stderr, "benchmark sampling: %s\n", p_error.what());
    return 1;
  }
}
