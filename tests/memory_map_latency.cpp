// The acceptance test of docs/process-memory-map-design.md, section 11: how
// much the memory-map reads delay the target's own memory calls.
//
// One thread of this process calls mmap, touches the pages (page faults) and
// calls munmap in a loop, and records the time of each call. The process
// also has many small mappings, so a maps read takes many reads and a large
// populated mapping, so the pagemap scan is long. The test measures twice:
// without the reader, then with a second thread that runs the memory-map
// reader (tiers 0, 1 and 2 on the large mapping) back to back, with no pause.
// That is far more often than the 2 s default, so it shows the worst case.
//
// Run with `make memory-map-latency`. It is not part of `make check`,
// because timings depend on the machine.

#include <sys/mman.h>
#include <sys/utsname.h>

#include <algorithm>
#include <atomic>
#include <cstdio>
#include <thread>
#include <vector>

#include "../sampler/memory_map.hpp"

namespace
{

using namespace triangulator;

struct Latencies
{
  std::vector<std::int64_t> mmap_;
  std::vector<std::int64_t> fault_;
  std::vector<std::int64_t> munmap_;
};

[[nodiscard]] std::int64_t Now()
{
  return ClockNow(CLOCK_MONOTONIC).count();
}

// Calls mmap, faults in each page, and munmap, until p_stop is set.
Latencies Work(const std::atomic<bool>& p_stop, std::size_t p_page)
{
  Latencies result;
  constexpr std::size_t kPages = 16;
  while (!p_stop.load(std::memory_order_relaxed))
  {
    auto start = Now();
    auto* region = static_cast<char*>(
        ::mmap(nullptr, kPages * p_page, PROT_READ | PROT_WRITE,
               MAP_PRIVATE | MAP_ANONYMOUS, -1, 0));
    result.mmap_.push_back(Now() - start);
    if (region == MAP_FAILED)
    {
      std::perror("mmap");
      std::exit(1);
    }
    for (std::size_t page = 0; page < kPages; ++page)
    {
      start = Now();
      region[page * p_page] = 1;
      result.fault_.push_back(Now() - start);
    }
    start = Now();
    ::munmap(region, kPages * p_page);
    result.munmap_.push_back(Now() - start);
  }
  return result;
}

void Report(const char* p_phase, const char* p_call,
            std::vector<std::int64_t> p_values)
{
  std::ranges::sort(p_values);
  const auto at = [&](double p_share)
  {
    return static_cast<double>(p_values[static_cast<std::size_t>(
               p_share * static_cast<double>(p_values.size() - 1))]) /
           1000.0;
  };
  std::printf("%-14s %-7s n=%-8zu p50=%8.2f us  p99=%8.2f us  max=%9.2f us\n",
              p_phase, p_call, p_values.size(), at(0.5), at(0.99),
              static_cast<double>(p_values.back()) / 1000.0);
}

Latencies Measure(bool p_with_reader, std::uintptr_t p_selected,
                  std::size_t p_page, std::size_t& p_cycles)
{
  std::atomic<bool> stop = false;
  Latencies latencies;
  std::thread worker{[&]
                     {
                       latencies = Work(stop, p_page);
                     }};
  std::jthread reader;
  std::atomic<std::size_t> cycles = 0;
  if (p_with_reader)
  {
    reader = std::jthread(
        [&](std::stop_token p_stop)
        {
          MemoryMapReader memory{memory_wire::kMaxVmas};
          while (!p_stop.stop_requested())
          {
            static_cast<void>(memory.Read(::getpid(), p_selected, p_stop));
            ++cycles;
          }
        });
  }
  std::this_thread::sleep_for(std::chrono::seconds{3});
  stop = true;
  worker.join();
  reader.request_stop();
  if (reader.joinable())
  {
    reader.join();
  }
  p_cycles = cycles;
  return latencies;
}

}  // namespace

int main()
{
  const auto page = static_cast<std::size_t>(::sysconf(_SC_PAGESIZE));
  utsname name{};
  ::uname(&name);
  // Many small mappings with different permissions, so they do not merge.
  constexpr std::size_t kSmallMappings = 20'000;
  for (std::size_t index = 0; index < kSmallMappings; ++index)
  {
    if (::mmap(nullptr, page, index % 2 ? PROT_READ : PROT_READ | PROT_WRITE,
               MAP_PRIVATE | MAP_ANONYMOUS, -1, 0) == MAP_FAILED)
    {
      std::perror("mmap small");
      return 1;
    }
  }
  // A large populated mapping: 1 GiB, so a pagemap pass needs every read of
  // the burst.
  constexpr std::size_t kLargeBytes = std::size_t{1} << 30;
  auto* large =
      static_cast<char*>(::mmap(nullptr, kLargeBytes, PROT_READ | PROT_WRITE,
                                MAP_PRIVATE | MAP_ANONYMOUS, -1, 0));
  if (large == MAP_FAILED)
  {
    std::perror("mmap large");
    return 1;
  }
  for (std::size_t offset = 0; offset < kLargeBytes; offset += page)
  {
    large[offset] = 1;
  }
  std::printf("kernel %s, %zu small mappings, 1 GiB populated mapping\n",
              name.release, kSmallMappings);
  std::size_t cycles = 0;
  const auto baseline =
      Measure(false, reinterpret_cast<std::uintptr_t>(large), page, cycles);
  const auto loaded =
      Measure(true, reinterpret_cast<std::uintptr_t>(large), page, cycles);
  for (const auto& [phase, values] : {std::pair{"without reader", &baseline},
                                      std::pair{"with reader", &loaded}})
  {
    Report(phase, "mmap", values->mmap_);
    Report(phase, "fault", values->fault_);
    Report(phase, "munmap", values->munmap_);
  }
  std::printf("reader cycles in 3 s (back to back): %zu\n", cycles);
}
