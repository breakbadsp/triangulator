#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <sched.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include <array>
#include <bit>
#include <charconv>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <format>
#include <iostream>
#include <latch>
#include <mutex>
#include <stdexcept>
#include <stop_token>
#include <string>
#include <string_view>
#include <system_error>
#include <thread>
#include <vector>

#include "runtime_threads.hpp"

// A target process that measures how much the sampler disturbs it. Besides
// sleeping threads it runs four probe threads, each pinned to its own core:
//   spin  reads the clock in a tight loop; a long gap between two reads is
//         time the core spent on something else.
//   wake  sleeps 1 ms on an absolute timer; lateness is wake-up delay.
//   lock  changes its signal mask, which takes the process-wide signal lock
//         the sampler's stat reads also take.
//   mmap  maps and unmaps a page, which takes the address-space lock the
//         sampler's maps reads also take.
// The probes start when stdin delivers a line, run for the requested seconds
// and print one JSON line. The process then waits for stdin to close.
//
// Optional trailing arguments give the target the shape of a real service:
//   mappings=N  N separate memory mappings, half of them file-backed, so
//               /proc/PID/maps has about N lines
//   files=N     N open files
//   sockets=N   N connected TCP loopback pairs (2N descriptors) and one UDP
//               socket, all in the process's network namespace
namespace
{

constexpr int kProbeThreads = 4;
constexpr int kMaxThreads = 500;
constexpr std::int64_t kNsPerSecond = 1'000'000'000;
constexpr std::int64_t kWakePeriodNs = 1'000'000;
constexpr std::size_t kBucketCount = 65;
constexpr std::array<std::uint64_t, 4> kThresholdsNs{10'000, 100'000, 1'000'000,
                                                     10'000'000};
constexpr std::array<std::string_view, 4> kThresholdNames{
    "over_10us", "over_100us", "over_1ms", "over_10ms"};

[[nodiscard]] std::int64_t NowNs() noexcept
{
  timespec value{};
  clock_gettime(CLOCK_MONOTONIC, &value);
  return value.tv_sec * kNsPerSecond + value.tv_nsec;
}

void PinToCpu(int p_cpu) noexcept
{
  if (p_cpu < 0)
  {
    return;
  }
  cpu_set_t set;
  CPU_ZERO(&set);
  CPU_SET(p_cpu, &set);
  pthread_setaffinity_np(pthread_self(), sizeof(set), &set);
}

// Counts durations. Bucket i holds values whose bit width is i, that is
// [2^(i-1), 2^i) nanoseconds. The thresholds are exact counts of durations at
// or above 10 us, 100 us, 1 ms and 10 ms.
class Distribution
{
 public:
  void Add(std::uint64_t p_ns) noexcept
  {
    ++samples_;
    ++buckets_[std::bit_width(p_ns)];
    max_ns_ = p_ns > max_ns_ ? p_ns : max_ns_;
    for (std::size_t index = 0; index < kThresholdsNs.size(); ++index)
    {
      over_[index] += p_ns >= kThresholdsNs[index] ? 1U : 0U;
    }
    slow_total_ns_ += p_ns >= kThresholdsNs[0] ? p_ns : 0U;
  }

  [[nodiscard]] std::string ToJson() const
  {
    std::string text = std::format(
        "{{\"samples\":{},\"max_ns\":{},"
        "\"slow_total_ns\":{}",
        samples_, max_ns_, slow_total_ns_);
    for (std::size_t index = 0; index < kThresholdsNs.size(); ++index)
    {
      text += std::format(",\"{}\":{}", kThresholdNames[index], over_[index]);
    }
    text += ",\"buckets\":[";
    for (std::size_t index = 0; index < buckets_.size(); ++index)
    {
      text += std::format("{}{}", index == 0 ? "" : ",", buckets_[index]);
    }
    text += "]}";
    return text;
  }

 private:
  std::uint64_t samples_ = 0;
  std::uint64_t max_ns_ = 0;
  std::uint64_t slow_total_ns_ = 0;
  std::array<std::uint64_t, kThresholdsNs.size()> over_{};
  std::array<std::uint64_t, kBucketCount> buckets_{};
};

struct ProbeConfig
{
  int cpu_ = -1;
  std::int64_t deadline_ns_ = 0;
};

[[nodiscard]] Distribution SpinProbe(const ProbeConfig& p_config)
{
  PinToCpu(p_config.cpu_);
  Distribution gaps;
  auto previous = NowNs();
  while (previous < p_config.deadline_ns_)
  {
    const auto now = NowNs();
    gaps.Add(static_cast<std::uint64_t>(now - previous));
    previous = now;
  }
  return gaps;
}

[[nodiscard]] Distribution WakeProbe(const ProbeConfig& p_config)
{
  PinToCpu(p_config.cpu_);
  // The default 50 us timer slack would hide the delays measured here.
  prctl(PR_SET_TIMERSLACK, 1UL, 0UL, 0UL, 0UL);
  Distribution lateness;
  auto wake_ns = NowNs();
  while (wake_ns < p_config.deadline_ns_)
  {
    wake_ns += kWakePeriodNs;
    const timespec wake{.tv_sec = wake_ns / kNsPerSecond,
                        .tv_nsec = wake_ns % kNsPerSecond};
    clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &wake, nullptr);
    const auto late = NowNs() - wake_ns;
    lateness.Add(late > 0 ? static_cast<std::uint64_t>(late) : 0U);
  }
  return lateness;
}

[[nodiscard]] Distribution LockProbe(const ProbeConfig& p_config)
{
  PinToCpu(p_config.cpu_);
  sigset_t blocked;
  sigemptyset(&blocked);
  sigaddset(&blocked, SIGUSR2);
  sigset_t previous_mask;
  Distribution durations;
  auto start = NowNs();
  while (start < p_config.deadline_ns_)
  {
    // Both calls change the mask, so each takes the signal lock once.
    pthread_sigmask(SIG_BLOCK, &blocked, &previous_mask);
    pthread_sigmask(SIG_SETMASK, &previous_mask, nullptr);
    const auto end = NowNs();
    durations.Add(static_cast<std::uint64_t>(end - start));
    start = end;
  }
  return durations;
}

[[nodiscard]] Distribution MmapProbe(const ProbeConfig& p_config)
{
  PinToCpu(p_config.cpu_);
  Distribution durations;
  auto start = NowNs();
  while (start < p_config.deadline_ns_)
  {
    void* page = mmap(nullptr, 4096, PROT_READ | PROT_WRITE,
                      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (page != MAP_FAILED)
    {
      munmap(page, 4096);
    }
    const auto end = NowNs();
    durations.Add(static_cast<std::uint64_t>(end - start));
    start = end;
  }
  return durations;
}

// Descriptors and mappings that make the target look like a service. Mappings
// alternate between readable and inaccessible pages, so the kernel cannot
// merge neighbours and /proc/PID/maps keeps one line for each.
class Ballast
{
 public:
  Ballast() = default;
  Ballast(const Ballast&) = delete;
  Ballast& operator=(const Ballast&) = delete;
  Ballast(Ballast&&) = delete;
  Ballast& operator=(Ballast&&) = delete;

  ~Ballast()
  {
    for (const auto fd : descriptors_)
    {
      close(fd);
    }
    for (void* region : regions_)
    {
      munmap(region, kPageBytes);
    }
  }

  void AddMappings(int p_count)
  {
    if (p_count == 0)
    {
      return;
    }
    // The program's own file gives the file-backed lines a realistic path.
    const int file = open("/proc/self/exe", O_RDONLY | O_CLOEXEC);
    Keep(file);
    const auto file_pages = lseek(file, 0, SEEK_END) / kPageBytes;
    regions_.reserve(static_cast<std::size_t>(p_count));
    for (int index = 0; index < p_count; ++index)
    {
      // Each file page is used once; the offset wraps if the file is short.
      const bool from_file = index % 2 == 0 && file_pages > 0;
      const int protection = index % 4 < 2 ? PROT_READ : PROT_NONE;
      void* region = from_file
                         ? mmap(nullptr, kPageBytes, protection, MAP_PRIVATE,
                                file, (index / 2 % file_pages) * kPageBytes)
                         : mmap(nullptr, kPageBytes, protection,
                                MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
      if (region == MAP_FAILED)
      {
        throw std::runtime_error("mmap failed; raise vm.max_map_count?");
      }
      regions_.push_back(region);
    }
  }

  void AddFiles(int p_count)
  {
    for (int index = 0; index < p_count; ++index)
    {
      Keep(open("/dev/null", O_RDONLY | O_CLOEXEC));
    }
  }

  void AddSockets(int p_pairs)
  {
    if (p_pairs == 0)
    {
      return;
    }
    const int listener = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    Keep(listener);
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    socklen_t length = sizeof(address);
    if (bind(listener, reinterpret_cast<sockaddr*>(&address), length) != 0 ||
        listen(listener, 128) != 0 ||
        getsockname(listener, reinterpret_cast<sockaddr*>(&address), &length) !=
            0)
    {
      throw std::runtime_error("cannot listen on loopback");
    }
    for (int index = 0; index < p_pairs; ++index)
    {
      const int client = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
      Keep(client);
      if (connect(client, reinterpret_cast<sockaddr*>(&address), length) != 0)
      {
        throw std::runtime_error("cannot connect on loopback");
      }
      Keep(accept4(listener, nullptr, nullptr, SOCK_CLOEXEC));
    }
    Keep(socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0));
  }

 private:
  static constexpr long kPageBytes = 4096;

  void Keep(int p_fd)
  {
    if (p_fd < 0)
    {
      throw std::runtime_error("cannot open a descriptor; raise ulimit -n?");
    }
    descriptors_.push_back(p_fd);
  }

  std::vector<int> descriptors_;
  std::vector<void*> regions_;
};

[[nodiscard]] bool ParseInt(std::string_view p_text, int& p_value) noexcept
{
  const auto parsed =
      std::from_chars(p_text.data(), p_text.data() + p_text.size(), p_value);
  return parsed.ec == std::errc{} &&
         parsed.ptr == p_text.data() + p_text.size();
}

// Blocks until the stop token fires. The thread stays in the target, so the
// sampler sees the same thread set for the whole run.
void SleepUntilStopped(std::stop_token p_stop)
{
  std::mutex mutex;
  std::unique_lock lock{mutex};
  std::condition_variable_any stopped;
  stopped.wait(lock, p_stop,
               []
               {
                 return false;
               });
}

struct Arguments
{
  int threads_ = 0;
  int duration_s_ = 0;
  std::array<int, kProbeThreads> probe_cpus_{};
  int mappings_ = 0;
  int files_ = 0;
  int sockets_ = 0;
};

[[nodiscard]] bool ParseArguments(int p_argc, char** p_argv,
                                  Arguments& p_arguments)
{
  if (p_argc < 3 + kProbeThreads)
  {
    return false;
  }
  bool valid = ParseInt(p_argv[1], p_arguments.threads_) &&
               ParseInt(p_argv[2], p_arguments.duration_s_);
  for (int index = 0; index < kProbeThreads; ++index)
  {
    valid = valid &&
            ParseInt(p_argv[3 + index],
                     p_arguments.probe_cpus_[static_cast<std::size_t>(index)]);
  }
  for (int index = 3 + kProbeThreads; index < p_argc; ++index)
  {
    const std::string_view option{p_argv[index]};
    const auto equals = option.find('=');
    int* target = nullptr;
    if (option.substr(0, equals) == "mappings")
    {
      target = &p_arguments.mappings_;
    }
    else if (option.substr(0, equals) == "files")
    {
      target = &p_arguments.files_;
    }
    else if (option.substr(0, equals) == "sockets")
    {
      target = &p_arguments.sockets_;
    }
    valid = valid && target != nullptr && equals != std::string_view::npos &&
            ParseInt(option.substr(equals + 1), *target) && *target >= 0;
  }
  return valid && p_arguments.threads_ > kProbeThreads &&
         p_arguments.threads_ <= kMaxThreads && p_arguments.duration_s_ >= 1;
}

}  // namespace

int main(int p_argc, char** p_argv)
{
  Arguments arguments;
  if (!ParseArguments(p_argc, p_argv, arguments))
  {
    std::fputs(
        "usage: benchmark-victim THREADS DURATION_S SPIN_CPU WAKE_CPU "
        "LOCK_CPU MMAP_CPU [mappings=N] [files=N] [sockets=N]\n  THREADS is "
        "5..500 and includes the main and probe threads; a CPU of -1 does not "
        "pin.\n",
        stderr);
    return 1;
  }
  try
  {
    Ballast ballast;
    ballast.AddMappings(arguments.mappings_);
    ballast.AddFiles(arguments.files_);
    ballast.AddSockets(arguments.sockets_);
    const int runtime_threads = triangulator::RuntimeThreadCount(true);
    const int worker_threads = arguments.threads_ - runtime_threads;
    const auto sleeper_count = worker_threads - 1 - kProbeThreads;
    if (sleeper_count < 0)
    {
      std::fputs(
          "benchmark victim: thread count cannot fit the sanitizer runtime\n",
          stderr);
      return 1;
    }
    std::latch ready{worker_threads - 1};
    std::vector<std::jthread> sleepers;
    sleepers.reserve(static_cast<std::size_t>(sleeper_count));
    for (int index = 0; index < sleeper_count; ++index)
    {
      sleepers.emplace_back(
          [ready_latch = &ready](std::stop_token p_stop)
          {
            ready_latch->count_down();
            SleepUntilStopped(p_stop);
          });
    }

    // The probes wait for a deadline set by the start line. The wait also
    // ends on a stop request: if creating a later probe thread throws, the
    // destructors of the probes already created request stop and join, and
    // a wait that ignored the stop request would hang there.
    std::mutex start_mutex;
    std::condition_variable_any start_signal;
    std::int64_t deadline_ns = 0;  // Guarded by start_mutex; 0 is not set.
    std::latch finished{kProbeThreads};
    std::array<Distribution, kProbeThreads> results;
    using Probe = Distribution (*)(const ProbeConfig&);
    constexpr std::array<Probe, kProbeThreads> kProbes{SpinProbe, WakeProbe,
                                                       LockProbe, MmapProbe};
    std::vector<std::jthread> probes;
    probes.reserve(kProbeThreads);
    for (std::size_t index = 0; index < kProbeThreads; ++index)
    {
      // A small RLIMIT_AS prevents sanitizer initialization. Inject the
      // thread constructor error after two probes to test their cleanup.
      if (index == 2 && std::getenv("TRIANGULATOR_TEST_FAIL_THREAD") != nullptr)
      {
        throw std::system_error(
            std::make_error_code(std::errc::resource_unavailable_try_again),
            "injected thread creation failure");
      }
      probes.emplace_back(
          [&, index](std::stop_token p_stop)
          {
            ready.count_down();
            std::int64_t probe_deadline_ns = 0;
            {
              std::unique_lock lock{start_mutex};
              if (!start_signal.wait(lock, p_stop,
                                     [&]
                                     {
                                       return deadline_ns != 0;
                                     }))
              {
                return;
              }
              probe_deadline_ns = deadline_ns;
            }
            results[index] =
                kProbes[index]({.cpu_ = arguments.probe_cpus_[index],
                                .deadline_ns_ = probe_deadline_ns});
            finished.count_down();
            SleepUntilStopped(p_stop);
          });
    }
    ready.wait();
    std::printf("%d threads ready\n", arguments.threads_);
    std::fflush(stdout);

    std::string line;
    // A closed stdin before the start line gives the probes a deadline that
    // has already passed, so they finish at once and the threads can stop.
    const auto started = static_cast<bool>(std::getline(std::cin, line));
    {
      const std::lock_guard lock{start_mutex};
      deadline_ns =
          started ? NowNs() + arguments.duration_s_ * kNsPerSecond : 1;
    }
    start_signal.notify_all();
    finished.wait();
    if (!started)
    {
      return 0;
    }
    std::printf(
        "{\"threads\":%d,\"duration_s\":%d,\"spin\":%s,\"wake\":%s,"
        "\"lock\":%s,\"mmap\":%s}\n",
        arguments.threads_, arguments.duration_s_, results[0].ToJson().c_str(),
        results[1].ToJson().c_str(), results[2].ToJson().c_str(),
        results[3].ToJson().c_str());
    std::fflush(stdout);
    // Stay alive, so the sampler keeps a live target until the driver is done.
    while (std::getline(std::cin, line))
    {
    }
    return 0;
  }
  catch (const std::exception& p_error)
  {
    std::fprintf(stderr, "benchmark victim: %s\n", p_error.what());
    return 1;
  }
}
