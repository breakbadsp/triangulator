#include <atomic>
#include <chrono>
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

#include "runtime_threads.hpp"

// One thread burns CPU. The other threads remain asleep. With "wake", each
// of them wakes every 0.1 to 1.6 s and runs for 50 us, like the idle
// workers of a server; the sampler then reads more of them in full. The
// benchmark stops this process with SIGTERM after it has measured the
// sampler.
int main(int p_argc, char** p_argv)
{
  int thread_count = 500;
  const bool wake = p_argc == 3 && std::string_view{p_argv[2]} == "wake";
  if (p_argc == 2 || wake)
  {
    const std::string_view argument{p_argv[1]};
    const auto parsed = std::from_chars(
        argument.data(), argument.data() + argument.size(), thread_count);
    if (parsed.ec != std::errc{} ||
        parsed.ptr != argument.data() + argument.size() || thread_count < 1 ||
        thread_count > 500)
    {
      std::fputs("benchmark target: thread count must be 1..500\n", stderr);
      return 1;
    }
  }
  else if (p_argc != 1)
  {
    std::fputs("usage: benchmark-target [THREADS [wake]]\n", stderr);
    return 1;
  }
  try
  {
    const int runtime_threads =
        triangulator::RuntimeThreadCount(thread_count > 1);
    const int worker_threads = thread_count - runtime_threads;
    if (worker_threads < 1)
    {
      std::fputs(
          "benchmark target: thread count cannot fit the sanitizer runtime\n",
          stderr);
      return 1;
    }
    std::latch ready{worker_threads};
    std::vector<std::jthread> sleepers;
    sleepers.reserve(static_cast<std::size_t>(worker_threads - 1));
    for (int index = 1; index < worker_threads; ++index)
    {
      sleepers.emplace_back(
          [ready_latch = &ready, wake, index](std::stop_token p_stop)
          {
            std::mutex mutex;
            std::unique_lock lock{mutex};
            std::condition_variable_any stopped;
            ready_latch->count_down();
            const auto never = []
            {
              return false;
            };
            if (!wake)
            {
              stopped.wait(lock, p_stop, never);
              return;
            }
            auto seed = static_cast<std::uint32_t>(index) * 2654435761U;
            while (!p_stop.stop_requested())
            {
              seed = seed * 1103515245U + 12345U;
              const std::chrono::milliseconds sleep{100 + seed % 1500};
              stopped.wait_for(lock, p_stop, sleep, never);
              const auto start = std::chrono::steady_clock::now();
              while (std::chrono::steady_clock::now() - start <
                     std::chrono::microseconds{50})
              {
              }
            }
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
