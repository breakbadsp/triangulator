#include <atomic>
#include <charconv>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <exception>
#include <latch>
#include <mutex>
#include <stop_token>
#include <string_view>
#include <thread>
#include <vector>

// One thread burns CPU. The other threads remain asleep. The benchmark
// stops this process with SIGTERM after it has measured the sampler.
int main(int p_argc, char* p_argv[])
{
  try
  {
    int thread_count = 500;
    if (p_argc > 2)
    {
      std::fputs("usage: benchmark-target [threads: 1..1000]\n", stderr);
      return 1;
    }
    if (p_argc == 2)
    {
      const std::string_view argument{p_argv[1]};
      const auto parsed = std::from_chars(
          argument.data(), argument.data() + argument.size(), thread_count);
      if (parsed.ec != std::errc{} ||
          parsed.ptr != argument.data() + argument.size() || thread_count < 1 ||
          thread_count > 1000)
      {
        std::fputs("threads must be an integer from 1 to 1000\n", stderr);
        return 1;
      }
    }
    std::latch ready{thread_count};
    std::vector<std::jthread> sleepers;
    sleepers.reserve(static_cast<std::size_t>(thread_count - 1));
    for (int index = 1; index < thread_count; ++index)
    {
      sleepers.emplace_back(
          [ready_latch = &ready](std::stop_token p_stop)
          {
            std::mutex mutex;
            std::unique_lock lock{mutex};
            std::condition_variable_any stopped;
            ready_latch->count_down();
            stopped.wait(lock, p_stop,
                         []
                         {
                           return false;
                         });
          });
    }
    ready.count_down();
    ready.wait();
    std::printf("%d threads ready\n", thread_count);
    std::fflush(stdout);
    std::atomic<std::uint64_t> state{1};
    while (true)
    {
      const auto value = state.load(std::memory_order_relaxed);
      state.store(value * 1664525 + 1013904223, std::memory_order_relaxed);
    }
  }
  catch (const std::exception& p_error)
  {
    std::fprintf(stderr, "benchmark target: %s\n", p_error.what());
    return 1;
  }
}
