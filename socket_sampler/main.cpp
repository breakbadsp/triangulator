#include <bpf/bpf.h>
#include <bpf/libbpf.h>
#include <sys/random.h>

#include <csignal>
#include <cstdio>
#include <filesystem>
#include <thread>
#include <vector>

#include "../sampler/proc.hpp"
#include "transport.hpp"

namespace
{
using namespace triangulator;
using namespace triangulator::socket_metrics;
volatile std::sig_atomic_t stopped = 0;
extern "C" void Stop(int)
{
  stopped = 1;
}
struct ObjectCloser
{
  void operator()(bpf_object* p_object) const
  {
    bpf_object__close(p_object);
  }
};
struct LinkCloser
{
  void operator()(bpf_link* p_link) const
  {
    bpf_link__destroy(p_link);
  }
};
using Link = std::unique_ptr<bpf_link, LinkCloser>;

void Require(bool p_ok, const char* p_message)
{
  if (!p_ok)
  {
    throw std::runtime_error(p_message);
  }
}

int Run(int p_argc, char** p_argv)
{
  if (p_argc != 4 && p_argc != 6)
  {
    std::fprintf(stderr,
                 "usage: %s PID COLLECTOR-IP:PORT BPF-OBJECT [MARKER-BINARY "
                 "MARKER-SYMBOL]\n"
                 "Requires Linux BTF, sock length tracepoints and BPF tracing "
                 "privileges.\n"
                 "Optional marker: one call for each successfully processed "
                 "application message.\n",
                 p_argv[0]);
    return 2;
  }
  const auto pid = ParseNumber<int>(p_argv[1]);
  Require(pid && *pid > 0, "PID must be positive");
  auto target = FindTarget(TargetPid{*pid});
  Require(target && target->has_value(), "target process is not readable");
  auto endpoint = MakeEndpoint(p_argv[2]);
  Require(endpoint.has_value(), "invalid collector endpoint");
  const auto ticks = ::sysconf(_SC_CLK_TCK);
  Require(ticks > 0 && 1000000000 % ticks == 0,
          "unsupported clock tick frequency");
  std::unique_ptr<bpf_object, ObjectCloser> object{
      bpf_object__open_file(p_argv[3], nullptr)};
  Require(object && !libbpf_get_error(object.get()), "cannot open BPF object");
  auto* marker = bpf_object__find_program_by_name(object.get(), "Message");
  Require(marker, "missing marker program");
  if (p_argc != 6)
  {
    bpf_program__set_autoload(marker, false);
  }
  Require(bpf_object__load(object.get()) == 0,
          "cannot load socket probes; need BTF and CAP_BPF/CAP_PERFMON (or "
          "root). No permissions were changed");
  const int config_fd = bpf_object__find_map_fd_by_name(object.get(), "config");
  const int counters_fd =
      bpf_object__find_map_fd_by_name(object.get(), "counters");
  const int losses_fd = bpf_object__find_map_fd_by_name(object.get(), "losses");
  Require(config_fd >= 0 && counters_fd >= 0 && losses_fd >= 0,
          "missing BPF map");
  // Keep the PID filter disabled until every probe has attached.
  std::vector<Link> links;
  bpf_program* program = nullptr;
  bpf_object__for_each_program(program, object.get())
  {
    if (!bpf_program__autoload(program))
    {
      continue;
    }
    bpf_link* link = nullptr;
    if (program == marker)
    {
      bpf_uprobe_opts options{};
      options.sz = sizeof(options);
      options.func_name = p_argv[5];
      // Attach across threads; the BPF program filters the target process and
      // generation. A perf-event attachment to just PID misses existing peers.
      link =
          bpf_program__attach_uprobe_opts(program, -1, p_argv[4], 0, &options);
    }
    else
    {
      link = bpf_program__attach(program);
    }
    Require(link && !libbpf_get_error(link),
            "cannot attach all probes; unsupported kernel/marker or "
            "insufficient permissions");
    links.emplace_back(link);
  }
  Observation observation;
  Require(::getrandom(&observation.observer_, sizeof(observation.observer_),
                      0) == sizeof(observation.observer_) &&
              observation.observer_,
          "cannot generate observer ID");
  observation.pid_ = static_cast<U32>(*pid);
  observation.process_start_ = (**target).starttime_;
  observation.started_ns_ = static_cast<U64>(ClockNow(CLOCK_MONOTONIC).count());
  observation.flags_ = p_argc == 6 ? kMessageEnabled : 0;
  const U32 zero = 0;
  const TraceConfig settings{observation.pid_, 0, observation.process_start_,
                             static_cast<U64>(ticks)};
  Require(bpf_map_update_elem(config_fd, &zero, &settings, BPF_ANY) == 0,
          "cannot enable PID filter");
  std::signal(SIGINT, Stop);
  std::signal(SIGTERM, Stop);
  std::fprintf(stderr,
               "Socket observer %llu monitoring PID %d; 1-second snapshots, %s "
               "message marker\n",
               observation.observer_, *pid, p_argc == 6 ? "with" : "without");
  auto deadline = std::chrono::steady_clock::now();
  for (;;)
  {
    const auto current = FindTarget(TargetPid{*pid});
    const bool finished = stopped || (current && *current != *target);
    if (finished)
    {
      links.clear();  // Stop writes before the final snapshot; keep map
                      // contents.
      observation.flags_ |= kStopped;
    }
    std::vector<std::pair<CounterKey, Counters>> rows;
    CounterKey key{};
    CounterKey next{};
    bool first = true;
    while (bpf_map_get_next_key(counters_fd, first ? nullptr : &key, &next) ==
           0)
    {
      first = false;
      key = next;
      Counters counters{};
      Require(bpf_map_lookup_elem(counters_fd, &key, &counters) == 0,
              "cannot read counters");
      rows.emplace_back(key, counters);
      Require(rows.size() <= kMaxSocketCounters, "counter map exceeded bound");
    }
    Require(errno == ENOENT, "cannot enumerate counters");
    Require(bpf_map_lookup_elem(losses_fd, &zero, &observation.losses_) == 0,
            "cannot read coverage");
    observation.monotonic_ns_ =
        static_cast<U64>(ClockNow(CLOCK_MONOTONIC).count());
    observation.wall_ns_ = static_cast<U64>(ClockNow(CLOCK_REALTIME).count());
    SendSnapshot(observation, rows, *endpoint);
    if (finished)
    {
      break;
    }
    ++observation.sequence_;
    deadline += std::chrono::seconds{1};
    // No catch-up bursts: a delayed observation leaves an explicitly longer
    // interval.
    deadline = std::max(deadline, std::chrono::steady_clock::now());
    std::this_thread::sleep_until(deadline);
  }
  return 0;
}
}  // namespace
int main(int p_argc, char** p_argv)
{
  try
  {
    return Run(p_argc, p_argv);
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "socket sampler: %s\n", error.what());
    return 1;
  }
}
