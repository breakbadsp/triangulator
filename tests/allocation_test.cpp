// Checks the TigerStyle memory rule for the sampler: after startup, sampling
// (threads, resources and the memory map) allocates no heap memory. The
// Makefile links this test statically with
// --wrap=malloc,--wrap=calloc,--wrap=realloc. Every one of those calls then
// goes through the wrappers below, including calls from the C++ library
// (operator new) and from libc functions such as opendir.

#include <sys/socket.h>
#include <unistd.h>

#include <cstdio>
#include <cstdlib>

#include "../sampler/memory.hpp"
#include "../sampler/proc.hpp"
#include "../sampler/resources.hpp"

namespace
{

std::size_t allocation_count = 0;

}  // namespace

extern "C"
{
  void* __real_malloc(std::size_t p_size);
  void* __real_calloc(std::size_t p_count, std::size_t p_size);
  void* __real_realloc(void* p_block, std::size_t p_size);

  void* __wrap_malloc(std::size_t p_size)
  {
    ++allocation_count;
    return __real_malloc(p_size);
  }

  void* __wrap_calloc(std::size_t p_count, std::size_t p_size)
  {
    ++allocation_count;
    return __real_calloc(p_count, p_size);
  }

  void* __wrap_realloc(void* p_block, std::size_t p_size)
  {
    ++allocation_count;
    return __real_realloc(p_block, p_size);
  }
}

namespace
{

using namespace triangulator;

// Exits instead of throwing, because a thrown exception allocates.
void Require(bool p_condition, const char* p_message)
{
  if (!p_condition)
  {
    std::fprintf(stderr, "allocation test failed: %s\n", p_message);
    std::exit(1);
  }
}

}  // namespace

int main()
{
  // Startup. More socket pairs than kMaxSockets, so the probe also cuts
  // sockets.
  constexpr std::size_t kSocketPairs = resource_wire::kMaxSockets;
  std::array<FileDescriptor, 2 * kSocketPairs> sockets{};
  for (std::size_t index = 0; index < kSocketPairs; ++index)
  {
    int pair[2]{};
    Require(::socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) == 0,
            "socketpair");
    sockets[2 * index] = FileDescriptor{pair[0]};
    sockets[2 * index + 1] = FileDescriptor{pair[1]};
  }
  const int pid = ::getpid();
  const TargetSelector by_pid = TargetPid{pid};
  const TargetSelector by_name = TargetName{"allocation-test"};
  // One cache keeps /proc files open. The other has no descriptor budget, so
  // its threads build their paths and reopen their files every tick.
  ThreadCache kept{1024};
  ThreadCache reopened{ThreadCache::kReservedDescriptors};
  ResourceProbe probe;
  MemoryProbe memory;
  RateLimitedLogger logger;

  // Sampling, for several ticks.
  const auto before = allocation_count;
  for (int tick = 0; tick < 3; ++tick)
  {
    const auto target = FindTarget(by_pid);
    Require(target && *target && (*target)->pid_ == pid, "lookup by PID");
    Require(FindTarget(by_name).has_value(), "lookup by name");
    kept.Rescan(pid, logger);
    reopened.Rescan(pid, logger);
    Require(!kept.Threads().empty() && !reopened.Threads().empty(),
            "thread scan");
    for (auto& thread : kept.Threads())
    {
      Require(thread.TakeSample(pid, false, logger).has_value(),
              "thread sample with kept files");
    }
    for (auto& thread : reopened.Threads())
    {
      Require(thread.TakeSample(pid, true, logger).has_value(),
              "thread sample with reopened files");
    }
    const auto sample = probe.Sample(pid);
    Require(sample.sockets_.size() == resource_wire::kMaxSockets &&
                resource_wire::HasFlag(sample.flags_,
                                       resource_wire::Flags::SocketsTruncated),
            "resource sample keeps the fullest sockets");
    // A memory-map sample split over two calls, as over two ticks.
    memory.Start(pid);
    Require(!memory.Continue(Nanoseconds{0}), "memory-map read deferred");
    const auto layout = memory.Continue(ClockNow(CLOCK_MONOTONIC) + 10s);
    Require(layout && layout->summary_[memory_wire::Field("vma_count")] > 0,
            "memory-map sample");
    logger.Warn("allocation test tick {}: warning text uses fixed storage",
                tick);
  }
  const auto during = allocation_count - before;
  std::printf("heap allocations after startup: %zu\n", during);
  Require(during == 0, "sampling allocated heap memory after startup");
}
