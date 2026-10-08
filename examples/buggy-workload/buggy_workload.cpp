// Sample program with deliberate resource bugs, used to check what
// Triangulator shows for real-world problems. Every scenario is a bug that
// production services really have. Do not copy this code into a product.
//
//   buggy-workload --list
//   buggy-workload <scenario> [seconds]      (0 or no seconds: run until
//   SIGTERM)
//
// Scenarios that grow without limit stop at a cap, so a forgotten run cannot
// take down the host.

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <pthread.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <expected>
#include <filesystem>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

namespace
{

using std::chrono::milliseconds;

constexpr std::size_t kMiB = 1024 * 1024;

std::atomic<bool>& StopFlag()
{
  static std::atomic<bool> stop{false};
  return stop;
}

bool Stopped()
{
  return StopFlag().load(std::memory_order_relaxed);
}

void SleepMs(long p_ms)
{
  std::this_thread::sleep_for(milliseconds(p_ms));
}

void Log(std::string_view p_message)
{
  std::fprintf(stderr, "[buggy-workload] %.*s\n",
               static_cast<int>(p_message.size()), p_message.data());
}

// Starts a detached thread with a kernel thread name (15 bytes at most), which
// is what Triangulator shows and groups by prefix.
void Spawn(std::string p_name, std::function<void()> p_body)
{
  std::thread(
      [name = std::move(p_name), body = std::move(p_body)]()
      {
        pthread_setname_np(pthread_self(), name.c_str());
        body();
      })
      .detach();
}

// Owns a file descriptor.
class Fd final
{
 public:
  Fd() = default;
  explicit Fd(int p_fd) : fd_(p_fd)
  {
  }
  Fd(const Fd&) = delete;
  Fd& operator=(const Fd&) = delete;
  Fd(Fd&& p_other) noexcept : fd_(std::exchange(p_other.fd_, -1))
  {
  }
  Fd& operator=(Fd&& p_other) noexcept
  {
    if (this != &p_other)
    {
      Reset();
      fd_ = std::exchange(p_other.fd_, -1);
    }
    return *this;
  }
  ~Fd()
  {
    Reset();
  }

  [[nodiscard]] int Get() const
  {
    return fd_;
  }

 private:
  void Reset()
  {
    if (fd_ >= 0)
    {
      ::close(fd_);
      fd_ = -1;
    }
  }

  int fd_ = -1;
};

[[nodiscard]] std::expected<Fd, int> MakeSocket(int p_type)
{
  const int fd = ::socket(AF_INET, p_type, 0);
  if (fd < 0)
  {
    return std::unexpected(errno);
  }
  return Fd(fd);
}

sockaddr_in LoopbackAddress(std::uint16_t p_port)
{
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(p_port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  return address;
}

// Binds to a free loopback port and returns it.
[[nodiscard]] std::expected<std::uint16_t, int> BindAnyPort(const Fd& p_fd)
{
  sockaddr_in address = LoopbackAddress(0);
  if (::bind(p_fd.Get(), reinterpret_cast<const sockaddr*>(&address),
             sizeof(address)) != 0)
  {
    return std::unexpected(errno);
  }
  socklen_t length = sizeof(address);
  if (::getsockname(p_fd.Get(), reinterpret_cast<sockaddr*>(&address),
                    &length) != 0)
  {
    return std::unexpected(errno);
  }
  return ntohs(address.sin_port);
}

[[nodiscard]] bool ConnectLoopback(const Fd& p_fd, std::uint16_t p_port)
{
  const sockaddr_in address = LoopbackAddress(p_port);
  return ::connect(p_fd.Get(), reinterpret_cast<const sockaddr*>(&address),
                   sizeof(address)) == 0;
}

void SetBufferBytes(const Fd& p_fd, int p_option, int p_bytes)
{
  ::setsockopt(p_fd.Get(), SOL_SOCKET, p_option, &p_bytes, sizeof(p_bytes));
}

// Many services run with a small descriptor limit; make it small on purpose so
// the leak is visible in seconds instead of hours.
void LowerFdLimit(rlim_t p_soft)
{
  rlimit limit{};
  ::getrlimit(RLIMIT_NOFILE, &limit);
  limit.rlim_cur = std::min(p_soft, limit.rlim_max);
  ::setrlimit(RLIMIT_NOFILE, &limit);
}

// A quiet, healthy thread so the dashboard has a normal baseline to compare.
void SpawnHeartbeat()
{
  Spawn("misc-heartbeat",
        []()
        {
          while (!Stopped())
          {
            SleepMs(1000);
          }
        });
}

void BurnCpu()
{
  volatile double value = 1.0;
  while (!Stopped())
  {
    for (int i = 0; i < 1'000'000; ++i)
    {
      value = value * 1.0000001 + 0.5;
    }
  }
}

// ---- CPU ------------------------------------------------------------------

// BUG: a consumer polls an empty queue in a loop without blocking or sleeping.
// A second thread burns CPU on pointless recomputation.
void StartCpuSpin()
{
  SpawnHeartbeat();
  Spawn("worker-spin", BurnCpu);
  Spawn("worker-poll",
        []()
        {
          std::atomic<bool> ready{false};  // BUG: nobody ever sets this.
          while (!ready.load(std::memory_order_relaxed) && !Stopped())
          {
          }
        });
}

// BUG: four CPU-bound threads per core ("one thread per task"). Nothing is
// idle, yet every thread waits for a CPU most of the time.
void StartOversubscribed()
{
  SpawnHeartbeat();
  const unsigned threads =
      std::max(4U, std::thread::hardware_concurrency() * 4);
  for (unsigned i = 0; i < threads; ++i)
  {
    Spawn("worker-" + std::to_string(i), BurnCpu);
  }
}

// BUG: the pool does its slow call (a "database query") while holding the one
// shared lock. CPU is nearly zero, yet throughput is that of one thread.
void StartLockConvoy()
{
  SpawnHeartbeat();
  static std::mutex lock;
  for (int i = 0; i < 8; ++i)
  {
    Spawn("worker-" + std::to_string(i),
          []()
          {
            while (!Stopped())
            {
              {
                const std::lock_guard<std::mutex> guard(lock);
                SleepMs(40);
              }
              std::this_thread::yield();
            }
          });
  }
}

// BUG: two threads take two locks in opposite order. Once they meet, they
// wait forever and the requests queued behind them wait too. The process
// stays alive and looks idle.
void StartDeadlock()
{
  SpawnHeartbeat();
  static std::mutex first;
  static std::mutex second;
  Spawn("worker-a",
        []()
        {
          const std::lock_guard<std::mutex> outer(first);
          SleepMs(200);
          const std::lock_guard<std::mutex> inner(second);
        });
  Spawn("worker-b",
        []()
        {
          const std::lock_guard<std::mutex> outer(second);
          SleepMs(200);
          const std::lock_guard<std::mutex> inner(first);
        });
  SleepMs(500);
  for (int i = 0; i < 3; ++i)
  {
    Spawn("worker-req-" + std::to_string(i),
          []()
          {
            while (!Stopped())
            {
              const std::lock_guard<std::mutex> guard(first);
              SleepMs(10);
            }
          });
  }
}

// ---- Memory ---------------------------------------------------------------

// BUG: an in-memory cache with no eviction. Capped at 1 GiB for safety.
void StartMemoryLeak()
{
  SpawnHeartbeat();
  Spawn("worker-cache",
        []()
        {
          constexpr std::size_t kChunkBytes = 8 * kMiB;
          constexpr std::size_t kCapBytes = 1024 * kMiB;
          static std::vector<std::vector<char>> cache;
          std::size_t total_bytes = 0;
          while (!Stopped() && total_bytes < kCapBytes)
          {
            cache.emplace_back(kChunkBytes,
                               '\1');  // filled, so the pages are resident
            total_bytes += kChunkBytes;
            SleepMs(500);
          }
          Log("cache reached its cap; the leak stops here only to protect this "
              "host");
          while (!Stopped())
          {
            SleepMs(1000);
          }
        });
  // BUG: a second leak of address space: 64 KiB regions mapped and never
  // unmapped; the guard page splits each into its own mapping.
  Spawn("worker-mmap",
        []()
        {
          constexpr std::size_t kRegionBytes = 64 * 1024;
          constexpr int kCapRegions = 6000;
          for (int i = 0; i < kCapRegions && !Stopped(); ++i)
          {
            void* region = ::mmap(nullptr, kRegionBytes, PROT_READ | PROT_WRITE,
                                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
            if (region == MAP_FAILED)
            {
              break;
            }
            static_cast<char*>(region)[0] = 1;
            ::mprotect(static_cast<char*>(region) + kRegionBytes - 4096, 4096,
                       PROT_NONE);
            SleepMs(10);
          }
          while (!Stopped())
          {
            SleepMs(1000);
          }
        });
}

// BUG: a buffer is mapped, touched and unmapped for every request instead of
// being reused. The memory never grows, but the process spends its time in
// page faults and the kernel.
void StartFaultStorm()
{
  SpawnHeartbeat();
  for (int i = 0; i < 2; ++i)
  {
    Spawn(
        "worker-fault-" + std::to_string(i),
        []()
        {
          constexpr std::size_t kBufferBytes = 64 * kMiB;
          while (!Stopped())
          {
            void* buffer = ::mmap(nullptr, kBufferBytes, PROT_READ | PROT_WRITE,
                                  MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
            if (buffer == MAP_FAILED)
            {
              return;
            }
            for (std::size_t offset = 0; offset < kBufferBytes; offset += 4096)
            {
              static_cast<char*>(buffer)[offset] = 1;
            }
            ::munmap(buffer, kBufferBytes);
          }
        });
  }
}

// ---- Threads --------------------------------------------------------------

// BUG: each "request" starts a thread that waits for a reply that never
// comes. Threads pile up, each holding a stack. Capped at 400.
void StartThreadLeak()
{
  SpawnHeartbeat();
  Spawn("misc-spawner",
        []()
        {
          static std::mutex never_signaled_lock;
          static std::condition_variable never_signaled;
          for (int i = 0; i < 400 && !Stopped(); ++i)
          {
            Spawn("misc-waiter",
                  []()
                  {
                    std::unique_lock<std::mutex> guard(never_signaled_lock);
                    never_signaled.wait(guard,
                                        []()
                                        {
                                          return Stopped();
                                        });
                  });
            SleepMs(100);
          }
        });
}

// BUG: a new thread per tiny task instead of a pool. Thread count stays low
// but threads are born and die all the time.
void StartThreadChurn()
{
  SpawnHeartbeat();
  Spawn("misc-spawner",
        []()
        {
          while (!Stopped())
          {
            Spawn("misc-task",
                  []()
                  {
                    SleepMs(5);
                  });
            SleepMs(2);
          }
        });
}

// ---- Descriptors and sockets ----------------------------------------------

// BUG: files are opened and never closed. After the limit, every open fails,
// and the error handling retries immediately in a tight loop.
void StartFdLeak()
{
  SpawnHeartbeat();
  LowerFdLimit(256);
  Spawn("io-leak",
        []()
        {
          static std::vector<Fd> forgotten;
          bool reported = false;
          while (!Stopped())
          {
            const int fd = ::open("/dev/null", O_RDONLY);
            if (fd >= 0)
            {
              forgotten.emplace_back(fd);
              SleepMs(100);
              continue;
            }
            if (!reported)
            {
              Log("open failed: " + std::string(std::strerror(errno)) +
                  "; retrying");
              reported = true;
            }
            // BUG: no backoff and no giving up.
          }
        });
}

// BUG: the server accepts connections and keeps the descriptors but never
// reads or closes them, so after the client hangs up they stay in CLOSE-WAIT.
// When the descriptors run out, accept fails and the small backlog fills.
void StartCloseWait()
{
  SpawnHeartbeat();
  LowerFdLimit(128);
  auto listener = MakeSocket(SOCK_STREAM);
  if (!listener)
  {
    Log("socket failed");
    return;
  }
  static Fd server = std::move(*listener);
  const int yes = 1;
  ::setsockopt(server.Get(), SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));
  const auto port = BindAnyPort(server);
  if (!port || ::listen(server.Get(), 4) != 0)
  {
    Log("listen failed");
    return;
  }
  const std::uint16_t server_port = *port;
  Spawn("io-accept",
        []()
        {
          static std::vector<Fd> leaked;
          while (!Stopped())
          {
            const int fd = ::accept(server.Get(), nullptr, nullptr);
            if (fd >= 0)
            {
              leaked.emplace_back(fd);  // BUG: never closed, never read.
            }
            else
            {
              SleepMs(50);
            }
          }
        });
  Spawn("sender-client",
        [server_port]()
        {
          while (!Stopped())
          {
            auto client = MakeSocket(SOCK_STREAM);
            if (client && ConnectLoopback(*client, server_port))
            {
              constexpr std::string_view kRequest = "ping";
              [[maybe_unused]] const auto sent =
                  ::send(client->Get(), kRequest.data(), kRequest.size(),
                         MSG_NOSIGNAL);
            }
            SleepMs(100);
          }
        });
}

// BUG: the receiver reads a few bytes at a time, much slower than the sender
// writes. TCP buffers fill and the sender blocks; the UDP receiver's buffer
// overflows and the kernel drops datagrams.
void StartSlowConsumer()
{
  SpawnHeartbeat();
  auto listener = MakeSocket(SOCK_STREAM);
  if (!listener)
  {
    return;
  }
  static Fd server = std::move(*listener);
  const auto port = BindAnyPort(server);
  if (!port || ::listen(server.Get(), 8) != 0)
  {
    return;
  }
  const std::uint16_t tcp_port = *port;
  Spawn("io-slow-reader",
        []()
        {
          const int fd = ::accept(server.Get(), nullptr, nullptr);
          if (fd < 0)
          {
            return;
          }
          Fd connection(fd);
          SetBufferBytes(connection, SO_RCVBUF, 64 * 1024);
          std::array<char, 512> buffer{};
          while (!Stopped())
          {
            [[maybe_unused]] const auto received =
                ::recv(connection.Get(), buffer.data(), buffer.size(), 0);
            SleepMs(200);
          }
        });
  Spawn("sender-tcp",
        [tcp_port]()
        {
          auto client = MakeSocket(SOCK_STREAM);
          if (!client || !ConnectLoopback(*client, tcp_port))
          {
            return;
          }
          SetBufferBytes(*client, SO_SNDBUF, 64 * 1024);
          const std::vector<char> block(64 * 1024, 'x');
          while (!Stopped())
          {
            [[maybe_unused]] const auto sent =
                ::send(client->Get(), block.data(), block.size(), MSG_NOSIGNAL);
          }
        });

  auto udp_receiver = MakeSocket(SOCK_DGRAM);
  if (!udp_receiver)
  {
    return;
  }
  static Fd udp_in = std::move(*udp_receiver);
  SetBufferBytes(udp_in, SO_RCVBUF, 16 * 1024);
  const auto udp_port = BindAnyPort(udp_in);
  if (!udp_port)
  {
    return;
  }
  const std::uint16_t udp_target = *udp_port;
  Spawn("io-udp-reader",
        []()
        {
          std::array<char, 2048> buffer{};
          while (!Stopped())
          {
            [[maybe_unused]] const auto received =
                ::recv(udp_in.Get(), buffer.data(), buffer.size(), 0);
            SleepMs(50);
          }
        });
  Spawn("sender-udp",
        [udp_target]()
        {
          auto out = MakeSocket(SOCK_DGRAM);
          if (!out)
          {
            return;
          }
          const sockaddr_in address = LoopbackAddress(udp_target);
          const std::array<char, 1024> payload{};
          while (!Stopped())
          {
            [[maybe_unused]] const auto sent = ::sendto(
                out->Get(), payload.data(), payload.size(), 0,
                reinterpret_cast<const sockaddr*>(&address), sizeof(address));
            SleepMs(1);
          }
        });
}

// ---- Storage --------------------------------------------------------------

std::filesystem::path IoDirectory()
{
  const char* configured = std::getenv("BUGGY_IO_DIR");
  if (configured != nullptr)
  {
    return configured;
  }
  const char* home = std::getenv("HOME");
  return std::filesystem::path(home != nullptr ? home : ".") / ".cache" /
         "buggy-workload";
}

void CleanupIoFiles()
{
  std::error_code error;
  std::filesystem::remove_all(IoDirectory(), error);
}

// BUG: every small record is followed by fsync, from several threads, instead
// of batching. The threads spend their time in uninterruptible disk waits;
// CPU stays low while I/O pressure rises.
void StartSyncStorm()
{
  SpawnHeartbeat();
  std::error_code error;
  std::filesystem::create_directories(IoDirectory(), error);
  for (int i = 0; i < 4; ++i)
  {
    Spawn("io-writer-" + std::to_string(i),
          [i]()
          {
            const std::string path =
                (IoDirectory() / ("journal-" + std::to_string(i))).string();
            const Fd file(
                ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0600));
            if (file.Get() < 0)
            {
              Log("cannot open " + path);
              return;
            }
            constexpr std::size_t kRecordBytes = 256 * 1024;
            constexpr std::size_t kFileBytes = 64 * kMiB;
            const std::vector<char> record(kRecordBytes, 'r');
            std::size_t offset = 0;
            while (!Stopped())
            {
              [[maybe_unused]] const auto written =
                  ::pwrite(file.Get(), record.data(), record.size(),
                           static_cast<off_t>(offset));
              ::fsync(file.Get());  // BUG: one fsync per record.
              offset = (offset + kRecordBytes) % kFileBytes;
            }
          });
  }
}

struct Scenario
{
  std::string_view name_;
  std::string_view summary_;
  void (*start_)();
  void (*cleanup_)();
};

void NoCleanup()
{
}

constexpr std::array<Scenario, 13> kScenarios{{
    {"cpu-spin", "a busy loop and a poll loop that never blocks", StartCpuSpin,
     NoCleanup},
    {"oversubscribed", "4 CPU-bound threads per core", StartOversubscribed,
     NoCleanup},
    {"lock-convoy", "8 threads serialized on a lock held during a slow call",
     StartLockConvoy, NoCleanup},
    {"deadlock", "two threads take two locks in opposite order", StartDeadlock,
     NoCleanup},
    {"memory-leak", "cache without eviction plus never-unmapped regions",
     StartMemoryLeak, NoCleanup},
    {"fault-storm", "a 64 MiB buffer mapped and touched per request",
     StartFaultStorm, NoCleanup},
    {"thread-leak", "a thread per request that waits forever", StartThreadLeak,
     NoCleanup},
    {"thread-churn", "a new thread for every tiny task", StartThreadChurn,
     NoCleanup},
    {"fd-leak",
     "files never closed; open() fails and is retried in a tight loop",
     StartFdLeak, NoCleanup},
    {"close-wait", "accepted sockets never read or closed", StartCloseWait,
     NoCleanup},
    {"slow-consumer", "readers far slower than TCP and UDP senders",
     StartSlowConsumer, NoCleanup},
    {"sync-storm", "fsync after every record from four threads", StartSyncStorm,
     CleanupIoFiles},
    {"idle-baseline", "a healthy idle process, for comparison", SpawnHeartbeat,
     NoCleanup},
}};

void HandleSignal(int)
{
  StopFlag().store(true, std::memory_order_relaxed);
}

void PrintScenarios()
{
  for (const Scenario& scenario : kScenarios)
  {
    std::printf("%-15.*s %.*s\n", static_cast<int>(scenario.name_.size()),
                scenario.name_.data(),
                static_cast<int>(scenario.summary_.size()),
                scenario.summary_.data());
  }
}

}  // namespace

int main(int p_argc, char** p_argv)
{
  if (p_argc < 2 || std::string_view(p_argv[1]) == "--list")
  {
    PrintScenarios();
    return p_argc < 2 ? 2 : 0;
  }
  const std::string_view name = p_argv[1];
  const auto found = std::ranges::find_if(kScenarios,
                                          [name](const Scenario& p_scenario)
                                          {
                                            return p_scenario.name_ == name;
                                          });
  if (found == kScenarios.end())
  {
    std::fprintf(stderr, "unknown scenario '%s'; try --list\n", p_argv[1]);
    return 2;
  }
  const long duration_s = p_argc > 2 ? std::strtol(p_argv[2], nullptr, 10) : 0;

  std::signal(SIGINT, HandleSignal);
  std::signal(SIGTERM, HandleSignal);
  Log("running " + std::string(found->name_) + " as pid " +
      std::to_string(::getpid()));
  found->start_();

  const auto started = std::chrono::steady_clock::now();
  while (!Stopped())
  {
    SleepMs(100);
    if (duration_s > 0 && std::chrono::steady_clock::now() - started >=
                              std::chrono::seconds(duration_s))
    {
      break;
    }
  }
  found->cleanup_();
  std::_Exit(0);  // Detached threads may be blocked forever, on purpose.
}
