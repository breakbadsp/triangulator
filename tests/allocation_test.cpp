// Checks the TigerStyle memory rule for the sampler: after startup, sampling
// (threads, resources, the memory map and the process identity) allocates no
// heap memory. The Makefile links this test statically with
// --wrap=malloc,--wrap=calloc,--wrap=realloc. Every one of those calls then
// goes through the wrappers below, including calls from the C++ library
// (operator new) and from libc functions such as opendir. Sanitizer builds
// use the runtime allocation hook instead of replacing its allocator.

#include <fcntl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>

#include <csignal>
#include <cstdio>
#include <cstdlib>

#include "../sampler/budget.hpp"
#include "../sampler/config_watch.hpp"
#include "../sampler/discovery.hpp"
#include "../sampler/memory.hpp"
#include "../sampler/proc.hpp"
#include "../sampler/process_info.hpp"
#include "../sampler/resources.hpp"

#define TRIANGULATOR_SAMPLER_TEST
#include "../sampler/main.cpp"

namespace
{

#ifdef TRIANGULATOR_SANITIZER
thread_local std::size_t allocation_count = 0;
#else
std::size_t allocation_count = 0;
#endif

}  // namespace

extern "C"
{
#ifdef TRIANGULATOR_SANITIZER
  // The runtime calls this hook during its own initialization. Do not
  // instrument the hook or allocate memory from it.
  __attribute__((no_sanitize("address", "thread", "undefined"))) void
  __sanitizer_malloc_hook(const volatile void*, std::size_t)
  {
    ++allocation_count;
  }
#else
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
#endif
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

// Scans until a pass ends. Each call starts a pass: its time is past the
// discovery interval of the last one.
void ScanPass(Discovery& p_discovery, const Config& p_config)
{
  static Nanoseconds now{0};
  now += 2 * kDiscoveryInterval;
  for (int step = 0; step < 10'000; ++step)
  {
    const auto done = p_discovery.Scan(p_config, now + Nanoseconds{step});
    Require(done.has_value(), "discovery scan");
    if (*done)
    {
      return;
    }
  }
  Require(false, "discovery pass ends");
}

// Reads actual emitted ticks. The queue is bounded by the few SampleTick
// calls made between reads; other packet types are ignored.
[[nodiscard]] std::uint64_t ReadSession(const FileDescriptor& p_receiver)
{
  std::array<std::byte, 8192> bytes{};
  std::uint64_t session = 0;
  for (int packet = 0; packet < 32; ++packet)
  {
    const auto count =
        ::recv(p_receiver.Get(), bytes.data(), bytes.size(), MSG_DONTWAIT);
    if (count < 0)
    {
      break;
    }
    if (count >= static_cast<ssize_t>(sizeof(wire::Header)) &&
        std::memcmp(bytes.data(), "TMON", 4) == 0)
    {
      session = wire::FromBytes<wire::Header>(
                    std::span{bytes}.first(sizeof(wire::Header)))
                    .session_;
    }
  }
  Require(session != 0, "an emitted sampling session");
  return session;
}

[[nodiscard]] pid_t StartChild()
{
  const auto child = ::fork();
  Require(child >= 0, "fork");
  if (child == 0)
  {
    // A failed check exits the test; the child must not stay.
    ::prctl(PR_SET_PDEATHSIG, SIGKILL, 0, 0, 0);
    ::prctl(PR_SET_NAME, "alloc-child", 0, 0, 0);
    ::pause();
    ::_exit(0);
  }
  return child;
}

// One arrival and exit: two children arrive, one is admitted and one is
// excluded at full capacity, then the admitted one exits and its slot is
// released and freed, as the sampler loop does.
void StepDiscovery(Discovery& p_discovery, const Config& p_config,
                   TargetSampler& p_sampler)
{
  const std::array children{StartChild(), StartChild()};
  // A child sets its name after fork; give it time before the pass.
  ::usleep(20'000);
  ScanPass(p_discovery, p_config);
  const auto slots = p_discovery.Used();
  Require(slots[0].state_ == SlotState::Running &&
              slots[0].identity_.pid_ == ::getpid(),
          "this process by name");
  Require(slots[1].state_ == SlotState::Running && p_discovery.Excluded() == 1,
          "one child admitted, one excluded");
  Require(p_sampler.Assign("alloc-child.16").has_value(), "slot assignment");
  Require(p_sampler.SampleTick(slots[1].identity_, ClockNow(CLOCK_MONOTONIC))
              .has_value(),
          "real child sample");
  for (const auto child : children)
  {
    ::kill(child, SIGKILL);
    ::waitpid(child, nullptr, 0);
  }
  const auto found = FindTarget(TargetPid{slots[1].identity_.pid_});
  Require(found && *found != slots[1].identity_, "the child ended");
  Require(
      p_sampler.SampleTick(std::nullopt, ClockNow(CLOCK_MONOTONIC)).has_value(),
      "real child exit");
  p_discovery.End(p_config, 1);
  while (slots[1].state_ == SlotState::Releasing)
  {
    Require(p_discovery.Flags(1) != 0, "release flags");
    p_discovery.StepRelease(1);
  }
  Require(slots[1].state_ == SlotState::Free, "the slot is free again");
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
  ProcessInfoProbe process_info;
  RateLimitedLogger logger;

  CpuBudget cpu_budget{5, 1};
  const std::array<TargetConfig, 2> selected_targets{
      {{"self", by_pid}, {"name", by_name}}};
  // Discovery with two slots: this process by name, and children that a
  // pattern selects. The second child finds no slot, so it is excluded.
  Config discovery_config;
  discovery_config.process_names_ = {"allocation-test"};
  discovery_config.process_patterns_ = {"alloc-child*"};
  discovery_config.max_targets_ = 2;
  Discovery discovery;
  discovery.Configure(discovery_config);
  char watch_directory[] = "/tmp/allocation-watch-XXXXXX";
  Require(::mkdtemp(watch_directory) != nullptr, "watch directory");
  const FixedString watched{"{}/sampler.toml", watch_directory};
  ConfigWatch watch{watched.View()};
  RuntimeConfig runtime;
  FileDescriptor receiver{
      ::socket(AF_INET, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0)};
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  Require(::bind(receiver.Get(), reinterpret_cast<sockaddr*>(&address),
                 sizeof(address)) == 0,
          "receiver bind");
  socklen_t address_size = sizeof(address);
  Require(::getsockname(receiver.Get(), reinterpret_cast<sockaddr*>(&address),
                        &address_size) == 0,
          "receiver port");
  runtime.settings_.collector_ =
      std::format("127.0.0.1:{}", ntohs(address.sin_port));
  auto endpoint = MakeEndpoint(runtime.settings_.collector_);
  Require(endpoint.has_value(), "UDP endpoint");
  runtime.endpoint_ = std::move(*endpoint);
  DescriptorBudget budget{1024};
  const std::array<char, 64> host{'t', 'e', 's', 't'};
  auto sampler = std::make_unique<TargetSampler>(runtime, TargetConfig{},
                                                 budget, logger, host);
  Require(sampler->Initialize().has_value(), "real sampler startup");
  Require(watch.Watching(), "config watch");

  // Sampling, for several ticks.
  const auto before = allocation_count;
  for (int tick = 0; tick < 3; ++tick)
  {
    StepDiscovery(discovery, discovery_config, *sampler);
    // Slot assignment, sampling, exit, and reassignment run production code.
    Require(sampler->Assign("allocation-test.16").has_value(),
            "slot assignment");
    const auto identity = FindTarget(by_pid);
    Require(identity.has_value(), "identity");
    Require(
        sampler->SampleTick(*identity, ClockNow(CLOCK_MONOTONIC)).has_value(),
        "sample");
    const auto old_session = ReadSession(receiver);
    auto reused = **identity;
    ++reused.starttime_;
    Require(sampler->SampleTick(reused, ClockNow(CLOCK_MONOTONIC)).has_value(),
            "same PID, different start time");
    Require(ReadSession(receiver) != old_session,
            "PID reuse starts a different session");
    Require(sampler->SampleTick(std::nullopt, ClockNow(CLOCK_MONOTONIC))
                .has_value(),
            "end");
    {
      const FileDescriptor file{::open(
          watched.CStr(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600)};
      Require(file && ::write(file.Get(), "x", 1) == 1, "config write");
    }
    Require(watch.Poll(false, Nanoseconds{tick} * 2'000'000'000, logger),
            "an edit makes a reload pending");
    watch.Reloaded(Nanoseconds{tick} * 2'000'000'000);
    const auto target = FindTarget(by_pid);
    Require(target && *target && (*target)->pid_ == pid, "lookup by PID");
    Require(FindTarget(by_name).has_value(), "lookup by name");
    const auto targets = FindTargets(selected_targets);
    Require(targets[0] && *targets[0], "shared target lookup");
    for (int sample = 0; sample < 100; ++sample)
    {
      cpu_budget.Add(4ms, 200ms);
    }
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
    memory.Start(pid, true);
    Require(!memory.Continue(Nanoseconds{0}), "memory-map read deferred");
    const auto layout = memory.Continue(ClockNow(CLOCK_MONOTONIC) + 10s);
    Require(layout && layout->summary_[memory_wire::Field("vma_count")] > 0,
            "memory-map sample");
    Require(process_info.Read(pid, (*target)->starttime_).pid_ ==
                static_cast<std::uint32_t>(pid),
            "process identity");
    logger.Warn("allocation test tick {}: warning text uses fixed storage",
                tick);
  }
  const auto during = allocation_count - before;
  std::printf("heap allocations after startup: %zu\n", during);
  Require(during == 0, "sampling allocated heap memory after startup");
}
