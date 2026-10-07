// Checks the collector's memory rule: after startup, the datagram path
// allocates no heap memory. The path is Ingest::Handle (decode, Monitor,
// ResourceMonitor, row building, Storage writes), Monitor::Drain and
// Storage::Flush. The test replaces malloc, calloc, realloc and the aligned
// allocation functions, so it counts every allocation, including those made
// inside libstdc++ and libc.
//
// SQLite's own allocations are counted apart, through
// SQLITE_CONFIG_MALLOC. SQLite grows its page cache while the day file
// grows, up to the cache size limit. The test prints that number but does
// not require it to be zero.
//
// Not covered: the 500 ms dashboard refresh (JSON snapshot), the HTTP
// server and the replay recorder.

#include <dlfcn.h>
#include <malloc.h>
#include <sqlite3.h>
#include <stdlib.h>
#include <unistd.h>

#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

#include "../collector/ingest.hpp"

extern "C"
{
  void* __libc_malloc(std::size_t p_size);
  void* __libc_calloc(std::size_t p_count, std::size_t p_size);
  void* __libc_realloc(void* p_block, std::size_t p_size);
  void* __libc_memalign(std::size_t p_alignment, std::size_t p_size);
}

namespace
{

std::size_t g_allocations = 0;
std::size_t g_sqlite_allocations = 0;

// SQLite's allocator: libc's, counted apart from the program's.
int SqliteInit(void*)
{
  return SQLITE_OK;
}
void SqliteShutdown(void*)
{
}
void* SqliteMalloc(int p_size)
{
  ++g_sqlite_allocations;
  return __libc_malloc(static_cast<std::size_t>(p_size));
}
void SqliteFree(void* p_block)
{
  std::free(p_block);
}
void* SqliteRealloc(void* p_block, int p_size)
{
  ++g_sqlite_allocations;
  return __libc_realloc(p_block, static_cast<std::size_t>(p_size));
}
int SqliteSize(void* p_block)
{
  return static_cast<int>(::malloc_usable_size(p_block));
}
int SqliteRoundup(int p_size)
{
  return (p_size + 7) & ~7;
}

}  // namespace

extern "C"
{
  void* malloc(std::size_t p_size)
  {
    ++g_allocations;
    return __libc_malloc(p_size);
  }

  void* calloc(std::size_t p_count, std::size_t p_size)
  {
    ++g_allocations;
    return __libc_calloc(p_count, p_size);
  }

  void* realloc(void* p_block, std::size_t p_size)
  {
    ++g_allocations;
    return __libc_realloc(p_block, p_size);
  }

  void* memalign(std::size_t p_alignment, std::size_t p_size)
  {
    ++g_allocations;
    return __libc_memalign(p_alignment, p_size);
  }

  void* aligned_alloc(std::size_t p_alignment, std::size_t p_size)
  {
    ++g_allocations;
    return __libc_memalign(p_alignment, p_size);
  }

  int posix_memalign(void** p_result, std::size_t p_alignment,
                     std::size_t p_size)
  {
    ++g_allocations;
    *p_result = __libc_memalign(p_alignment, p_size);
    return *p_result == nullptr ? 12 : 0;
  }
}

namespace
{

using namespace triangulator;
using namespace triangulator::collector;

// Exits instead of throwing, because a thrown exception allocates.
void Require(bool p_condition, const char* p_message)
{
  if (!p_condition)
  {
    std::fprintf(stderr, "collector allocation test failed: %s\n", p_message);
    std::exit(1);
  }
}

constexpr std::size_t kThreads = 25;  // three datagrams per tick
constexpr std::uint64_t kSession = 7;

struct Phase
{
  const char* name_;
  std::size_t allocations_ = 0;
};

class Counter
{
 public:
  explicit Counter(Phase& p_phase) : phase_(p_phase), before_(g_allocations)
  {
  }
  ~Counter()
  {
    phase_.allocations_ += g_allocations - before_;
  }
  Counter(const Counter&) = delete;
  Counter& operator=(const Counter&) = delete;

 private:
  Phase& phase_;
  std::size_t before_;
};

// The datagrams of thread tick p_sequence, as the sampler would send them.
std::vector<std::array<std::byte, wire::kPacketSize>> ThreadTick(
    std::uint32_t p_sequence, std::vector<std::size_t>& p_sizes)
{
  const std::size_t chunks =
      (kThreads + wire::kRecordsPerPacket - 1) / wire::kRecordsPerPacket;
  std::vector<std::array<std::byte, wire::kPacketSize>> datagrams(chunks);
  p_sizes.assign(chunks, 0);
  for (std::size_t chunk = 0; chunk < chunks; ++chunk)
  {
    const std::size_t first = chunk * wire::kRecordsPerPacket;
    const std::size_t count =
        std::min(wire::kRecordsPerPacket, kThreads - first);
    wire::Packet packet{
        .header_ = {
            .chunk_ = static_cast<std::uint8_t>(chunk),
            .chunks_ = static_cast<std::uint8_t>(chunks),
            .session_ = kSession,
            .sequence_ = p_sequence,
            .records_ = static_cast<std::uint16_t>(count),
            .monotonic_ns_ = (1000 + std::uint64_t{p_sequence}) * 1'000'000'000,
            .wall_ns_ =
                (1'700'000'000 + std::uint64_t{p_sequence}) * 1'000'000'000,
            .interval_ms_ = 1000,
            .pid_ = 123}};
    for (std::size_t index = 0; index < count; ++index)
    {
      const std::size_t thread = first + index;
      auto& record = packet.records_[index];
      // Thread 0 gets a new id every seven ticks, so threads also come and go.
      record.tid_ = static_cast<std::uint32_t>(
          100 + thread + (thread == 0 ? 1000 * (p_sequence / 7) : 0));
      record.state_ = 'S';
      record.utime_ = std::uint64_t{p_sequence} * 10;
      record.stime_ = std::uint64_t{p_sequence} * 5;
      record.run_delay_ = std::uint64_t{p_sequence} * 1000;
      record.timeslices_ = std::uint64_t{p_sequence} * 3;
      record.read_bytes_ = std::uint64_t{p_sequence} * 4096;
      record.write_bytes_ = std::uint64_t{p_sequence} * 512;
      const std::string name = thread % 2 == 0 ? "worker-" : "io-";
      std::memcpy(record.comm_.data(), name.data(), name.size());
      std::memcpy(record.wchan_.data(), "futex_do_wait", 13);
    }
    std::ranges::copy(wire::AsBytes(packet), datagrams[chunk].begin());
    p_sizes[chunk] = wire::DatagramSize(count);
  }
  return datagrams;
}

// The datagrams of resource sample p_sequence: a summary and two socket
// parts.
std::vector<std::vector<std::byte>> ResourceSample(std::uint32_t p_sequence)
{
  resource_wire::Header header;
  header.parts_ = 3;
  header.session_ = kSession;
  header.sequence_ = p_sequence;
  header.monotonic_ns_ = (1000 + std::uint64_t{p_sequence} * 5) * 1'000'000'000;
  header.wall_ns_ =
      (1'700'000'000 + std::uint64_t{p_sequence} * 5) * 1'000'000'000;
  header.interval_ms_ = 5000;
  header.pid_ = 123;
  header.process_start_ = 99;
  resource_wire::SummaryValues values{};
  for (std::size_t index = 0; index < values.size(); ++index)
  {
    values[index] = index + std::uint64_t{p_sequence};
  }
  std::vector<resource_wire::Socket> sockets(12);
  for (std::size_t index = 0; index < sockets.size(); ++index)
  {
    sockets[index].kind_ = resource_wire::SocketKind::Tcp4;
    sockets[index].state_ = 1;
    sockets[index].fd_ = static_cast<std::uint32_t>(10 + index);
    sockets[index].inode_ = 5000 + index;
    sockets[index].local_port_ = 8080;
    sockets[index].remote_port_ = static_cast<std::uint16_t>(40000 + index);
    sockets[index].rx_queue_ = static_cast<std::uint32_t>(index * 100);
  }
  std::vector<std::vector<std::byte>> parts;
  std::array<std::byte, resource_wire::kMaxPartSize> buffer{};
  auto length = resource_wire::EncodeSummary(buffer, header, values,
                                             "/user.slice/app.service");
  parts.emplace_back(buffer.begin(), buffer.begin() + length);
  for (std::uint8_t part = 1; part < header.parts_; ++part)
  {
    length = resource_wire::EncodeSockets(buffer, header, sockets, part);
    parts.emplace_back(buffer.begin(), buffer.begin() + length);
  }
  return parts;
}

struct Totals
{
  Phase threads_{"thread datagrams (decode, ticks, rows)"};
  Phase resources_{"resource datagrams (decode, rows)"};
  Phase flush_{"Storage::Flush"};

  [[nodiscard]] std::size_t Sum() const
  {
    return threads_.allocations_ + resources_.allocations_ +
           flush_.allocations_;
  }
};

// Feeds p_ticks thread ticks and one resource sample per five ticks, through
// Ingest like the main loop does. Each tick is drained after its last chunk,
// so the Monitor joins all the chunks of the tick.
void Run(Ingest& p_ingest, Monitor& p_monitor, Storage& p_storage,
         std::uint32_t p_first, std::uint32_t p_ticks, Totals& p_totals)
{
  const PeerText peer{"10.0.0.1"};
  for (std::uint32_t sequence = p_first; sequence < p_first + p_ticks;
       ++sequence)
  {
    const double now = 1'700'000'000.0 + sequence;
    std::vector<std::size_t> sizes;
    auto datagrams = ThreadTick(sequence, sizes);
    for (std::size_t index = 0; index < datagrams.size(); ++index)
    {
      const std::span<const std::byte> data{datagrams[index].data(),
                                            sizes[index]};
      Counter counter{p_totals.threads_};
      Require(p_ingest.Handle(data, peer, now).has_value(), "thread datagram");
    }
    {
      Counter counter{p_totals.threads_};
      p_monitor.Drain(now, true);
    }
    if (sequence % 5 == 0)
    {
      for (const auto& part : ResourceSample(sequence))
      {
        Counter counter{p_totals.resources_};
        Require(p_ingest.Handle(part, peer, now).has_value(),
                "resource datagram");
      }
    }
    {
      Counter counter{p_totals.flush_};
      Require(p_storage.Flush(now).has_value(), "flush");
    }
  }
}

std::size_t Measure(bool p_store_raw)
{
  const auto directory =
      std::filesystem::temp_directory_path() /
      ("triangulator-alloc-test-" + std::to_string(::getpid()) +
       (p_store_raw ? "-raw" : ""));
  std::filesystem::create_directories(directory);
  Config config;
  config.store_raw_ = p_store_raw;
  config.groups_.push_back({"worker", "worker-"});
  auto created = Storage::Create(directory, 7);
  Require(created.has_value(), "storage opens");
  Storage storage = std::move(*created);
  StorageSink sink{storage};
  Monitor monitor{config, 1'700'000'000, sink};
  ResourceMonitor resources{sink};
  Ingest ingest{std::nullopt, monitor, resources, storage, sink};

  // Warm-up covers startup: the first session, every thread, the first
  // windows and the first resource samples.
  Totals warmup;
  Run(ingest, monitor, storage, 1, 30, warmup);
  // Steady state: more than ten windows, 12 resource samples.
  Totals steady;
  const auto sqlite_before = g_sqlite_allocations;
  Run(ingest, monitor, storage, 31, 60, steady);
  // Health and Snapshot allocate, so they run after the measurement. They
  // show that no chunk was dropped as late and that every thread is live.
  const double end = 1'700'000'000.0 + 90;
  Require(
      monitor.Health(end).Find("late_packets")->AsInt() == 0 &&
          monitor.Snapshot(end).Find("threads")->AsArray().size() == kThreads,
      "every chunk of every tick is processed");
  std::printf("%s\n", p_store_raw ? "store_raw = true" : "store_raw = false");
  for (const auto* phase :
       {&steady.threads_, &steady.resources_, &steady.flush_})
  {
    std::printf("  %-36s %zu\n", phase->name_, phase->allocations_);
  }
  std::printf("  %-36s %zu (warm-up: %zu)\n", "total", steady.Sum(),
              warmup.Sum());
  std::printf("  %-36s %zu (not in the total)\n",
              "SQLite allocations (separate)",
              g_sqlite_allocations - sqlite_before);
  std::filesystem::remove_all(directory);
  return steady.Sum();
}

}  // namespace

int main()
{
  sqlite3_mem_methods methods{SqliteMalloc,   SqliteFree,    SqliteRealloc,
                              SqliteSize,     SqliteRoundup, SqliteInit,
                              SqliteShutdown, nullptr};
  Require(sqlite3_config(SQLITE_CONFIG_MALLOC, &methods) == SQLITE_OK,
          "sqlite3_config");
  const std::size_t without_raw = Measure(false);
  const std::size_t with_raw = Measure(true);
  if (without_raw + with_raw != 0)
  {
    std::fprintf(stderr, "collector allocation test failed: %zu allocations\n",
                 without_raw + with_raw);
    return 1;
  }
  std::puts("collector allocation test passed: 0 allocations");
  return 0;
}
