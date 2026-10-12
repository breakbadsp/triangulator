#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <exception>
#include <latch>
#include <mutex>
#include <stop_token>
#include <thread>
#include <vector>

// One thread burns CPU. The other 499 threads remain asleep. The benchmark
// stops this process with SIGTERM after it has measured the sampler.
int main()
{
  try
  {
    constexpr int kThreads = 500;
    std::latch ready{kThreads};
    std::vector<std::jthread> sleepers;
    sleepers.reserve(kThreads - 1);
    for (int index = 1; index < kThreads; ++index)
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
    std::puts("500 threads ready");
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
