#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/utsname.h>
#include <sys/wait.h>

#include <filesystem>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <type_traits>
#include <vector>

#include "../sampler/exit_status.hpp"
#include "../sampler/kernel_log.hpp"
#include "../sampler/memory.hpp"
#include "../sampler/proc.hpp"
#include "../sampler/process_info.hpp"
#include "../sampler/resources.hpp"
#include "../sampler/schedule.hpp"

namespace
{

using namespace triangulator;

void Require(bool p_condition, std::string_view p_message)
{
  if (!p_condition)
  {
    throw std::runtime_error(std::string{p_message});
  }
}

void TestParsing()
{
  std::string stat = "42 (worker ) ( name) S";
  for (int field = 4; field <= 52; ++field)
  {
    stat += std::format(" {}", field == 12   ? 7
                               : field == 14 ? 100
                               : field == 15 ? 50
                               : field == 22 ? 12345
                               : field == 39 ? 3
                                             : 0);
  }
  const auto parsed = ParseStat(stat);
  Require(parsed.has_value(), "stat with parentheses must parse");
  Require(std::string_view{parsed->name_.data()} == "worker ) ( name",
          "comm must use last closing parenthesis");
  Require(parsed->utime_ == 100 && parsed->stime_ == 50 &&
              parsed->starttime_ == 12345,
          "stat fields must retain their numbering");
  Require(parsed->major_faults_ == 7 && parsed->processor_ == 3,
          "major faults and last CPU");
  Require(!ParseStat("42 (bad) S 0"), "truncated stat must fail");
  Require(!ParseNumber<std::uint64_t>("-1"), "negative counters must fail");
  Require(!ParseNumber<std::uint64_t>("18446744073709551616"),
          "counter overflow must fail");
  Require(!ParseNumber<int>("12garbage"), "partially parsed numbers must fail");
  Require(
      std::string_view{ParseWchan("futex_do_wait").data()} == "futex_do_wait",
      "plain wchan");
  Require(
      std::string_view{
          ParseWchan("poll_schedule_timeout.constprop.0").data()} ==
          "poll_schedule_timeout",
      "compiler suffix is dropped");
  Require(ParseWchan("0").front() == '\0', "running or hidden wchan is empty");
  Require(ParseWchan(std::string(40, 'x')).back() == 'x',
          "long wchan is truncated without overflow");
  const auto io =
      ParseIo("rchar: 11\nwchar: 22\nsyscr: 3\nsyscw: 4\nread_bytes: 0\n");
  Require(io && io->read_bytes_ == 11 && io->write_bytes_ == 22, "io counters");
  Require(!ParseIo("rchar: 11\n"), "both io counters are required");
  const auto schedstat = ParseSchedstat("123 456 789\n");
  Require(schedstat && schedstat->run_delay_ == 456 &&
              schedstat->timeslices_ == 789,
          "scheduler counters");
  const auto status = ParseStatus(
      "Name:\tworker\nvoluntary_ctxt_switches:\t12\nnonvoluntary_ctxt_switches:"
      "\t34\n");
  Require(status && status->run_delay_ == 34 && status->timeslices_ == 12,
          "fallback counters must not be swapped");
  Require(!ParseStatus("nonvoluntary_ctxt_switches: 1\n"),
          "both fallback counters are required");
}

// Omitted feature settings enable sampling; explicit zero disables it.
void TestConfig()
{
  const auto config = ParseConfig(
      "target_process = \"name #1\" # "
      "comment\nrate_hz=0.2\ncollector=\"[::1]:9400\"\nstatus_fallback=true\n");
  Require(config.has_value(), "valid configuration");
  Require(std::get<TargetName>(config->target_).value_ == "name #1",
          "quoted hash is part of process name");
  Require(config->Interval() == 5s && config->IntervalMs() == 5000,
          "rate converted to chrono duration");
  Require(config->status_fallback_, "fallback flag");
  Require(config->resource_interval_s_ == 2, "resource samples default to 2 s");
  const auto resources_off = ParseConfig(
      "target_pid=1\ncollector=127.0.0.1:9400\nresource_interval_s=0\n");
  Require(resources_off && resources_off->resource_interval_s_ == 0,
          "resource samples can be turned off");
  Require(config->memory_interval_s_ == 30,
          "memory-map samples default to 30 s");
  const auto memory_on = ParseConfig(
      "target_pid=1\ncollector=127.0.0.1:9400\nmemory_interval_s=30\n");
  Require(memory_on && memory_on->memory_interval_s_ == 30,
          "memory-map samples can be turned on");
  const auto memory_off = ParseConfig(
      "target_pid=1\ncollector=127.0.0.1:9400\nmemory_interval_s=0\n");
  Require(memory_off && memory_off->memory_interval_s_ == 0,
          "memory-map samples can be turned off");
  for (const auto invalid : {
           "target_pid=1\ntarget_process=foo\ncollector=127.0.0.1:9400",
           "target_pid=1\ncollector=127.0.0.1:9400\nrate_hz=nan",
           "target_pid=1\ncollector=127.0.0.1:9400\nrate_hz=10.1",
           "target_pid=1\ncollector=127.0.0.1:9400\nrate_hz=0.19",
           "target_pid=1\ntarget_pid=2\ncollector=127.0.0.1:9400",
           "target_pid=1\ncollector=\"127.0.0.1:9400",
           "target_pid=-1\ncollector=127.0.0.1:9400",
           "target_pid=1\ncollector=127.0.0.1:9400\nunknown=true",
           "target_pid=1\ncollector=127.0.0.1:9400\nresource_interval_s=61",
           "target_pid=1\ncollector=127.0.0.1:9400\nresource_interval_s=-1",
           "target_pid=1\ncollector=127.0.0.1:9400\nresource_interval_s=2.5",
           "target_pid=1\ncollector=127.0.0.1:9400\nmemory_interval_s=3601",
           "target_pid=1\ncollector=127.0.0.1:9400\nmemory_interval_s=-1",
       })
  {
    Require(!ParseConfig(invalid), "invalid config must be rejected");
  }
  for (const auto invalid :
       {"localhost:9400", "127.0.0.1:65536", "127.0.0.1:0", "[::1:9400",
        "127.0.0.1:no", "::1:9400", "[127.0.0.1]:9400", "127.1:9400",
        "0x7f000001:9400"})
  {
    Require(!MakeEndpoint(invalid),
            "invalid/non-numeric endpoint must be rejected");
  }
  const auto endpoint = MakeEndpoint("127.0.0.1:9400");
  Require(endpoint.has_value(), "numeric endpoint must work");
  Require((::fcntl(endpoint->socket_.Get(), F_GETFL) & O_NONBLOCK) != 0,
          "UDP socket must be nonblocking");
  Require((::fcntl(endpoint->socket_.Get(), F_GETFD) & FD_CLOEXEC) != 0,
          "UDP socket must be close-on-exec");
  const auto* address =
      reinterpret_cast<const sockaddr_in*>(&endpoint->address_);
  Require(address->sin_family == AF_INET &&
              ::ntohs(address->sin_port) == 9400 &&
              ::ntohl(address->sin_addr.s_addr) == 0x7f000001,
          "IPv4 endpoint must preserve the address and network-order port");
  const auto ipv6 = MakeEndpoint("[::1]:9400");
  Require(ipv6.has_value(), "bracketed numeric IPv6 endpoint must work");
  const auto* address6 = reinterpret_cast<const sockaddr_in6*>(&ipv6->address_);
  Require(address6->sin6_family == AF_INET6 &&
              ::ntohs(address6->sin6_port) == 9400 &&
              IN6_IS_ADDR_LOOPBACK(&address6->sin6_addr),
          "IPv6 endpoint must preserve the address and network-order port");
}

void RequireHex(std::span<const std::byte> p_bytes, std::string_view p_expected)
{
  Require(p_bytes.size() * 2 == p_expected.size(), "golden packet length");
  for (std::size_t index = 0; index < p_bytes.size(); ++index)
  {
    Require(std::to_integer<unsigned>(p_bytes[index]) ==
                ParseHex(p_expected.substr(index * 2, 2)),
            "wire bytes must match v2 golden packet");
  }
}

// Target tables retain legacy configuration and reject ambiguous selectors.
void TestMultipleTargetConfig()
{
  const auto parsed = ParseConfig(
      "collector=127.0.0.1:9400\n[[target]]\nid=orders\nprocess=orders-api\n[["
      "target]]\nid=billing\npid=123\n");
  Require(parsed && parsed->targets_.size() == 2, "two target tables");
  Require(ParseConfig("collector=127.0.0.1:9400\ntarget_pid=1")
                  ->targets_.front()
                  .id_ == "default",
          "legacy target has default id");
  for (const auto text :
       {"target_pid=1\n[[target]]\nid=one\npid=2",
        "[[target]]\nid=one\npid=1\nprocess=two", "[[target]]\nid=one",
        "[[target]]\npid=1", "[[target]]\nid=../escape\npid=1",
        "[[target]]\nid=one\npid=1\n[[target]]\nid=one\npid=2",
        "[[target]]\nid=one\npid=1\nrate_hz=2"})
  {
    Require(!ParseConfig(std::string{"collector=127.0.0.1:9400\n"} + text),
            "invalid target table");
  }
  std::string many = "collector=127.0.0.1:9400\n";
  for (int index = 0; index < 17; ++index)
  {
    many += std::format("[[target]]\nid=t{}\npid=1\n", index);
    Require(ParseConfig(many).has_value() == (index < 16),
            "fixed target count");
  }
}

// Caches for different targets use one descriptor count and release it.
void TestSharedDescriptorBudget()
{
  DescriptorBudget budget{
      ThreadCache::kReservedDescriptors + Thread::kDescriptorsPerThread, 0};
  ThreadCache first{budget};
  ThreadCache second{budget};
  RateLimitedLogger logger;
  first.Rescan(::getpid(), logger);
  second.Rescan(::getpid(), logger);
  Require(budget.kept_ == 1, "one shared cached thread");
  first.Clear();
  second.Clear();
  Require(budget.kept_ == 0, "clear releases the shared descriptor budget");
  const std::array<TargetConfig, 2> targets{
      {{"self", TargetPid{::getpid()}},
       {"absent", TargetName{"absent-xyz-123"}}}};
  const auto found = FindTargets(targets);
  Require(found[0] && *found[0] && (**found[0]).pid_ == ::getpid(),
          "shared lookup finds PID");
  Require(found[1] && !*found[1], "shared lookup reports an absent name");
}

void TestWire()
{
  ThreadStat stat{.state_ = 'S',
                  .major_faults_ = 5,
                  .utime_ = 0x0102030405060708ULL,
                  .stime_ = 9,
                  .processor_ = 0x0102};
  std::ranges::copy(std::string_view{"worker"}, stat.name_.begin());
  const auto record =
      wire::EncodeSample(0x01020304, stat, {10, 11}, IoCounters{12, 13},
                         ParseWchan("futex_do_wait"));
  RequireHex(
      wire::AsBytes(record),
      "04030201530002010807060504030201090000000000000"
      "00a000000000000000b0000000000000005000000000000000c000000000000000d00000"
      "000000000"
      "776f726b657200000000000000000000"
      "66757465785f646f5f7761697400000000000000000000000000000000000000");
  const auto missing_io =
      wire::EncodeSample(1, stat, {10, 11}, std::nullopt, WaitChannel{});
  Require(missing_io.flags_ == wire::RecordFlags::IoUnavailable,
          "unreadable io is flagged");
  const wire::Header header{.flags_ = wire::Flags::StatusFallback,
                            .chunk_ = 1,
                            .chunks_ = 3,
                            .session_ = 0x0102030405060708ULL,
                            .sequence_ = 0x090a0b0c,
                            .records_ = 1,
                            .monotonic_ns_ = 12,
                            .wall_ns_ = 13,
                            .interval_ms_ = 1000,
                            .pid_ = 0x01020304};
  RequireHex(wire::AsBytes(header),
             "544d4f4e0202010308070605040302010c0b0a09010000000c000000000000000"
             "d00000000000000e803000004030201");
}

void TestRaii()
{
  static_assert(!std::is_copy_constructible_v<FileDescriptor>);
  static_assert(std::is_nothrow_move_constructible_v<FileDescriptor>);
  static_assert(!std::is_copy_constructible_v<Thread>);
  static_assert(std::is_nothrow_move_assignable_v<Thread>);
  int closed_descriptor;
  {
    auto original = OpenReadonly("/dev/null");
    Require(static_cast<bool>(original), "open descriptor");
    closed_descriptor = original.Get();
    auto moved = std::move(original);
    Require(!original && moved.Get() == closed_descriptor,
            "move must transfer ownership");
    auto destination = OpenReadonly("/dev/null");
    const auto replaced_descriptor = destination.Get();
    destination = std::move(moved);
    Require(!moved && destination.Get() == closed_descriptor,
            "move assignment transfers ownership");
    Require(::fcntl(replaced_descriptor, F_GETFD) == -1 && errno == EBADF,
            "move assignment closes old descriptor");
  }
  Require(::fcntl(closed_descriptor, F_GETFD) == -1 && errno == EBADF,
          "destructor closes descriptor");
}

void TestResourceParsing()
{
  const auto pressure = ParsePressure(
      "some avg10=1.51 avg60=2.41 avg300=1.57 total=520879556\n"
      "full avg10=0.00 avg60=0.00 avg300=0.00 total=12\n");
  Require(pressure.some_ && pressure.some_->avg10_hundredths_ == 151 &&
              pressure.some_->total_us_ == 520879556,
          "PSI some line");
  Require(pressure.full_ && pressure.full_->avg10_hundredths_ == 0 &&
              pressure.full_->total_us_ == 12,
          "PSI full line");
  const auto old_cpu =
      ParsePressure("some avg10=0.50 avg60=0.10 avg300=0.00 total=7\n");
  Require(old_cpu.some_ && !old_cpu.full_,
          "CPU without a full line (before Linux 5.13)");
  Require(!ParsePressure("some avg10=x total=1\nfull total=2\n").some_,
          "a malformed PSI line is unavailable, not zero");

  const auto limits = ParseDescriptorLimits(
      "Limit                     Soft Limit           Hard Limit           "
      "Units\nMax processes             63426                63426         "
      "       processes\nMax open files            1024                 "
      "524288               files\n");
  Require(limits && limits->soft_ == 1024 && limits->hard_ == 524288,
          "descriptor limits");
  const auto unlimited = ParseDescriptorLimits(
      "Max open files            unlimited            unlimited            "
      "files\n");
  Require(unlimited && unlimited->soft_ == resource_wire::kUnavailable,
          "an unlimited limit has no headroom to report");
  Require(!ParseDescriptorLimits("Max processes 1 1 processes\n"),
          "missing row");

  const std::string_view io =
      "rchar: 11\nwchar: 22\nsyscr: 3\nsyscw: 4\nread_bytes: 5\n"
      "write_bytes: 6\ncancelled_write_bytes: 7\n";
  Require(FindKeyValue(io, "write_bytes") == 6 &&
              FindKeyValue(io, "cancelled_write_bytes") == 7,
          "process io keys");
  Require(!FindKeyValue("read_bytes_extra: 1\n", "read_bytes"),
          "a longer key is not the key");
  Require(FindKeyValue("Udp6InErrors                     \t42\n",
                       "Udp6InErrors") == 42,
          "snmp6 key and value separated by blanks");

  const std::string_view snmp =
      "Tcp: RtoAlgorithm MaxConn ActiveOpens RetransSegs\n"
      "Tcp: 1 -1 607048 4246\n"
      "Udp: InDatagrams RcvbufErrors\nUdp: 9 1297\n";
  const std::string_view netstat =
      "TcpExt: SyncookiesSent ListenOverflows ListenDrops\n"
      "TcpExt: 0 12 13\n"
      "IpExt: InNoRoutes\nIpExt: 5\n";
  Require(FindTableCounter(snmp, "Tcp", "RetransSegs") == 4246 &&
              FindTableCounter(snmp, "Udp", "RcvbufErrors") == 1297,
          "snmp counters");
  Require(!FindTableCounter(snmp, "Tcp", "MaxConn"),
          "a signed value is not a counter");
  Require(FindTableCounter(netstat, "TcpExt", "ListenOverflows") == 12,
          "netstat counters");
  Require(!FindTableCounter(netstat, "Tcp", "ListenOverflows"),
          "TcpExt is not the Tcp section");
  Require(!FindTableCounter(netstat, "TcpExt", "TCPRcvQDrop"),
          "a counter this kernel lacks is unavailable");

  const std::string_view sockstat =
      "sockets: used 1214\nTCP: inuse 23 orphan 0 tw 773 alloc 49 mem 151\n"
      "UDP: inuse 12 mem 263\n";
  Require(FindSockstat(sockstat, "TCP", "mem") == 151 &&
              FindSockstat(sockstat, "UDP", "mem") == 263 &&
              FindSockstat(sockstat, "TCP", "tw") == 773,
          "sockstat values");
  Require(!FindSockstat(sockstat, "UDPLITE", "mem"), "missing protocol");

  Require(ParseCgroupPath("12:cpu:/x\n0::/system.slice/app.service\n") ==
              "/system.slice/app.service",
          "cgroup v2 path");
  Require(!ParseCgroupPath("12:cpu,cpuacct:/x\n"), "cgroup v1 only");
  const auto triple = ParseTriple("187146\t249531\t374292\n");
  Require(triple && (*triple)[2] == 374292, "tcp_mem triple");
  Require(!ParseTriple("1 2\n"), "short triple");
}

void TestMemoryCgroupAndInterfaceParsing()
{
  const std::string_view status =
      "Name:\tworker\nVmPeak:\t 9000 kB\nVmHWM:\t 2048 kB\nVmRSS:\t 1024 kB\n"
      "RssAnon:\t 512 kB\nRssFile:\t 400 kB\nRssShmem:\t 112 kB\n"
      "VmSwap:\t 0 kB\n";
  Require(FindKilobytes(status, "VmRSS") == 1024 * 1024 &&
              FindKilobytes(status, "VmHWM") == 2048 * 1024 &&
              FindKilobytes(status, "VmSwap") == 0,
          "status memory lines are in bytes");
  Require(!FindKilobytes("VmRSS:\t12 MB\n", "VmRSS"),
          "a line that is not in kB is unavailable");
  Require(!FindKilobytes("Name:\tx\n", "VmRSS"),
          "a kernel thread has no VmRSS");
  Require(!FindKilobytes("VmRSSX:\t1 kB\n", "VmRSS"),
          "a longer key is not the key");
  Require(ParseCgroupNumber("1073741824\n") == 1073741824, "cgroup number");
  Require(!ParseCgroupNumber("max\n"), "no limit has no headroom");
  const auto quota = ParseCpuMax("50000 100000\n");
  Require(quota && quota->quota_us_ == 50000 && quota->period_us_ == 100000,
          "cpu.max quota");
  const auto unlimited = ParseCpuMax("max 100000\n");
  Require(unlimited && !unlimited->quota_us_ && unlimited->period_us_ == 100000,
          "cpu.max without a quota");
  Require(!ParseCpuMax("max\n") && !ParseCpuMax("50000 0\n"),
          "malformed cpu.max");
  Require(
      FindKeyValue("low 0\nhigh 0\nmax 7\noom 2\noom_kill 1\n", "max") == 7 &&
          FindKeyValue("low 0\nhigh 0\nmax 7\noom 2\noom_kill 1\n",
                       "oom_kill") == 1,
      "memory.events counters");

  const auto devices = ParseNetDev(
      "Inter-|   Receive                                                |  "
      "Transmit\n face |bytes    packets errs drop fifo frame compressed "
      "multicast|bytes    packets errs drop fifo colls carrier compressed\n"
      "    lo: 100 1 9 9 0 0 0 0 100 1 9 9 0 0 0 0\n"
      "  eth0: 2000 20 1 2 0 0 0 0 3000 30 3 4 0 0 0 0\n"
      "  eth1: 1 1 10 20 0 0 0 0 1 1 30 40 0 0 0 0\n");
  Require(devices && devices->rx_errors_ == 11 && devices->rx_dropped_ == 22 &&
              devices->tx_errors_ == 33 && devices->tx_dropped_ == 44,
          "interface counters skip lo and add the rest");
  Require(!ParseNetDev("    lo: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0\n"),
          "only lo has no interface counters");
  Require(!ParseNetDev("eth0: 1 2 3\n"), "a short line is unavailable");
}

resource_wire::Socket SyntheticSocket(std::uint32_t p_fd, std::uint32_t p_used)
{
  resource_wire::Socket socket;
  socket.kind_ = resource_wire::SocketKind::Tcp4;
  socket.state_ = 1;
  socket.fd_ = p_fd;
  socket.rcvbuf_ = 1000;
  socket.sndbuf_ = 1000;
  socket.rmem_alloc_ = p_used;
  return socket;
}

void TestSocketRanking()
{
  auto listener = SyntheticSocket(1, 0);
  listener.state_ = std::to_underlying(SocketState::Listen);
  listener.rx_queue_ = 3;  // pending connections
  listener.tx_queue_ = 2;  // backlog
  Require(Fullness(listener) == 1.5, "an overflowing accept queue");
  auto sender = SyntheticSocket(2, 0);
  sender.wmem_queued_ = 900;
  Require(Fullness(sender) == 0.9, "a nearly full send buffer");
  FullestSockets fullest;
  for (std::uint32_t fd = 10; fd < 40; ++fd)
  {
    fullest.Add(SyntheticSocket(fd, fd));
  }
  fullest.Add(sender);
  const auto sockets = fullest.Sorted();
  Require(fullest.Truncated(), "more than kMaxSockets are cut");
  Require(sockets.size() == resource_wire::kMaxSockets &&
              sockets.front().fd_ == 2 && sockets[1].fd_ == 39 &&
              sockets.back().fd_ == 17,
          "the fullest sockets are kept, fullest first");
  fullest.Clear();
  fullest.Add(SyntheticSocket(1, 0));
  Require(!fullest.Truncated() && fullest.Sorted().size() == 1,
          "few sockets are all kept");
}

const resource_wire::Socket* FindSocket(const ResourceSample& p_sample,
                                        int p_fd)
{
  for (const auto& socket : p_sample.sockets_)
  {
    if (socket.fd_ == static_cast<std::uint32_t>(p_fd))
    {
      return &socket;
    }
  }
  return nullptr;
}

// Samples this test process with sockets in known states: a TCP listener, an
// accepted connection with unread data, a UDP socket and a unix pair with
// unread data.
void TestResourceProbe()
{
  FileDescriptor listener{::socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0)};
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  socklen_t length = sizeof(address);
  Require(
      ::bind(listener.Get(), reinterpret_cast<sockaddr*>(&address), length) ==
              0 &&
          ::listen(listener.Get(), 4) == 0 &&
          ::getsockname(listener.Get(), reinterpret_cast<sockaddr*>(&address),
                        &length) == 0,
      "listen on loopback");
  FileDescriptor client{::socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0)};
  Require(::connect(client.Get(), reinterpret_cast<sockaddr*>(&address),
                    length) == 0,
          "connect");
  FileDescriptor server{
      ::accept4(listener.Get(), nullptr, nullptr, SOCK_CLOEXEC)};
  const std::string payload(1000, 'x');
  Require(::send(client.Get(), payload.data(), payload.size(), 0) == 1000,
          "send");
  // Bound: sock_diag lists only UDP sockets in the kernel's UDP table.
  FileDescriptor udp{::socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0)};
  sockaddr_in udp_address{};
  udp_address.sin_family = AF_INET;
  udp_address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  Require(::bind(udp.Get(), reinterpret_cast<sockaddr*>(&udp_address),
                 sizeof(udp_address)) == 0,
          "bind UDP");
  int pair[2]{};
  Require(::socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair) == 0,
          "socketpair");
  FileDescriptor unix_writer{pair[0]};
  FileDescriptor unix_reader{pair[1]};
  Require(::write(unix_writer.Get(), payload.data(), 300) == 300, "unix write");
  // Wait for loopback delivery, which is asynchronous.
  for (int attempt = 0; attempt < 100; ++attempt)
  {
    int queued = 0;
    if (::ioctl(server.Get(), FIONREAD, &queued) == 0 && queued == 1000)
    {
      break;
    }
    ::usleep(10000);
  }

  ResourceProbe probe;
  const auto sample = probe.Sample(::getpid());
  const auto& summary = sample.summary_;
  Require(sample.flags_ == resource_wire::Flags::None,
          "nothing hidden from the sampler's own user");
  Require(summary[Field("fd_open")] >= 6 && summary[Field("fd_sockets")] >= 6 &&
              summary[Field("fd_soft_limit")] != resource_wire::kUnavailable,
          "descriptor counts and limit");
  Require(summary[Field("tcp_sockets")] >= 3 &&
              summary[Field("tcp_listeners")] >= 1 &&
              summary[Field("tcp_rx_queue")] >= 1000 &&
              summary[Field("tcp_established")] >= 2 &&
              summary[Field("tcp_listen")] >= 1 &&
              summary[Field("udp_sockets")] >= 1 &&
              summary[Field("unix_sockets")] >= 2 &&
              summary[Field("unix_rx_queue")] >= 300,
          "socket totals");
  Require(summary[Field("sockets_matched")] >= 6 &&
              summary[Field("sockets_matched")] +
                      summary[Field("sockets_unmatched")] ==
                  summary[Field("fd_sockets")],
          "every socket descriptor is matched or counted as unmatched");
  const auto* accepted = FindSocket(sample, server.Get());
  Require(accepted != nullptr && accepted->rx_queue_ == 1000 &&
              accepted->rcvbuf_ > 0 && accepted->rmem_alloc_ > 0 &&
              accepted->local_port_ == ntohs(address.sin_port) &&
              resource_wire::HasFlag(accepted->flags_,
                                     resource_wire::SocketFlags::TcpInfo),
          "the accepted socket's unread bytes and buffer");
  const auto* listening = FindSocket(sample, listener.Get());
  Require(listening != nullptr &&
              listening->state_ == std::to_underlying(SocketState::Listen) &&
              listening->tx_queue_ == 4,
          "the listener's backlog");
  const auto* reader = FindSocket(sample, unix_reader.Get());
  Require(reader != nullptr &&
              reader->kind_ == resource_wire::SocketKind::UnixStream &&
              reader->rx_queue_ == 300,
          "the unix reader's unread bytes");
  Require(
      summary[Field("io_rchar")] != resource_wire::kUnavailable &&
          summary[Field("net_tcp_active_opens")] !=
              resource_wire::kUnavailable &&
          summary[Field("sockstat_tcp_inuse")] != resource_wire::kUnavailable,
      "process io and namespace counters");
  const auto rss = summary[Field("rss_bytes")];
  Require(rss != resource_wire::kUnavailable && rss > 0 &&
              summary[Field("rss_peak_bytes")] >= rss &&
              summary[Field("rss_anon_bytes")] <= rss,
          "process memory: peak is at least the current size");
  Require(summary[Field("net_if_rx_dropped")] == resource_wire::kUnavailable ||
              summary[Field("net_if_rx_dropped")] <
                  std::numeric_limits<std::uint64_t>::max() / 2,
          "interface counters are counters or unavailable");
  if (!sample.cgroup_.empty())
  {
    // Present on cgroup v2 hosts; the values themselves vary by host.
    Require(summary[Field("cgroup_memory_current")] !=
                    resource_wire::kUnavailable ||
                summary[Field("cgroup_pids_current")] !=
                    resource_wire::kUnavailable,
            "cgroup memory or pids is readable for our own cgroup");
  }
  // PSI is optional (CONFIG_PSI, psi=0); when present it must be sane.
  const auto some = summary[Field("host_io_some_avg10")];
  Require(some == resource_wire::kUnavailable || some <= 10000,
          "PSI avg10 is a percentage in hundredths");
}

}  // namespace

std::size_t OpenDescriptors()
{
  std::size_t count = 0;
  Directory directory{"/proc/self/fd"};
  while (directory.Next())
  {
    ++count;
  }
  return count;
}

void TestDescriptorBudget()
{
  Require(ThreadCache{10}.MaxKept() == 0,
          "a tiny limit keeps no descriptors open");
  Require(ThreadCache{ThreadCache::kReservedDescriptors +
                      2 * Thread::kDescriptorsPerThread}
                  .MaxKept() == 2,
          "budget is the limit minus the reserve, divided per thread");
  RateLimitedLogger logger;
  const int pid = ::getpid();
  Thread transient{pid, false};
  const auto before = OpenDescriptors();
  Require(transient.TakeSample(pid, false, logger).has_value(),
          "transient thread samples");
  Require(OpenDescriptors() == before,
          "a thread over the budget holds no descriptors between ticks");
  Thread kept{pid, true};
  Require(kept.TakeSample(pid, false, logger).has_value(),
          "kept thread samples");
  Require(OpenDescriptors() == before + Thread::kDescriptorsPerThread,
          "a thread within the budget keeps its files open");
  Require(RaiseDescriptorLimit() >= 64, "descriptor limit is readable");
}

// Checks the maps line parser, the joining of mappings into regions and the
// summary helpers on fixed text.
void TestMemoryParsing()
{
  using memory_wire::RegionKind;
  const auto library = ParseMapsLine(
      "7f12a000-7f12c000 r-xp 00001000 08:01 1234    /usr/lib/libc.so.6");
  Require(
      library && library->start_ == 0x7f12a000 && library->end_ == 0x7f12c000 &&
          library->kind_ == RegionKind::File &&
          library->name_ == "/usr/lib/libc.so.6" && library->permissions_ == 5,
      "file mapping");
  const auto spaced =
      ParseMapsLine("1000-2000 rw-s 00000000 00:01 7  /tmp/a b (deleted)");
  Require(spaced && spaced->name_ == "/tmp/a b (deleted)" &&
              spaced->permissions_ == 11,
          "a path keeps its spaces; shared mapping");
  const auto anonymous = ParseMapsLine("3000-4000 ---p 00000000 00:00 0");
  Require(anonymous && anonymous->kind_ == RegionKind::Anonymous &&
              anonymous->name_.empty() && anonymous->permissions_ == 0,
          "anonymous mapping without a name");
  Require(
      ParseMapsLine("5000-6000 rw-p 00000000 00:00 0  [heap]")->kind_ ==
              RegionKind::Heap &&
          ParseMapsLine("5000-6000 rw-p 00000000 00:00 0  [stack]")->kind_ ==
              RegionKind::Stack &&
          ParseMapsLine("5000-6000 r-xp 00000000 00:00 0  [vdso]")->kind_ ==
              RegionKind::Kernel &&
          ParseMapsLine("5000-6000 rw-p 00000000 00:00 0  [anon:x]")->kind_ ==
              RegionKind::Anonymous &&
          ParseMapsLine("5000-6000 rw-s 00000000 00:10 9  anon_inode:gem")
                  ->kind_ == RegionKind::Anonymous,
      "names that are not paths");
  for (const auto invalid :
       {"", "2000-1000 r--p 0 00:00 0", "1000-2000 r-p 0 00:00 0",
        "zz-2000 r--p 0 00:00 0", "1000-2000 r--p 0 00:00"})
  {
    Require(!ParseMapsLine(invalid), "invalid maps line must be rejected");
  }

  LayoutBuilder layout;
  for (const auto line : {"1000-2000 r--p 00000000 08:01 1 /usr/lib/libc.so.6",
                          "2000-3000 r-xp 00001000 08:01 1 /usr/lib/libc.so.6",
                          "3000-4000 rw-p 00002000 08:01 1 /usr/lib/libc.so.6",
                          "5000-6000 rw-p 00000000 00:00 0",
                          "6000-7000 rw-p 00000000 00:00 0  [heap]"})
  {
    layout.Add(*ParseMapsLine(line));
  }
  const auto regions = layout.Regions();
  Require(layout.VmaCount() == 5 && regions.size() == 3, "regions joined");
  Require(regions[0].start_ == 0x1000 && regions[0].end_ == 0x4000 &&
              regions[0].vma_count_ == 3 && regions[0].permissions_ == 7 &&
              std::string_view{regions[0].name_.data()} == "/usr/lib/libc.so.6",
          "adjacent mappings of one file are one region");
  Require(regions[1].kind_ == RegionKind::Anonymous &&
              regions[2].kind_ == RegionKind::Heap,
          "a gap or another kind starts a new region");
  const std::string long_path = "/" + std::string(60, 'd') + "/libname.so";
  layout.Clear();
  layout.Add(*ParseMapsLine("1000-2000 r--p 0 08:01 1 " + long_path));
  Require(std::string_view{layout.Regions()[0].name_.data()}.ends_with(
              "/libname.so") &&
              layout.Regions()[0].name_.back() == '\0',
          "a long path keeps its end");
  layout.Clear();
  const std::string common = "/a/common/path/longer/than/39/bytes/library.so";
  layout.Add(*ParseMapsLine("1000-2000 r--p 0 08:01 1 /package-A" + common));
  layout.Add(*ParseMapsLine("2000-3000 r-xp 0 08:01 2 /package-B" + common));
  Require(layout.Regions().size() == 2 &&
              layout.Regions()[0].name_ == layout.Regions()[1].name_ &&
              layout.Regions()[0].permissions_ == 1,
          "files whose sent names are equal are not joined");
  for (std::size_t index = 0; index <= memory_wire::kMaxRegions; ++index)
  {
    const auto start = 0x2000 * (index + 1);
    layout.Add(MapsLine{start, start + 0x1000, 1, RegionKind::Anonymous, {}});
  }
  Require(
      layout.Truncated() && layout.Regions().size() == memory_wire::kMaxRegions,
      "regions beyond kMaxRegions are counted, not kept");

  std::string stat = "42 (a b) S";
  for (int field = 4; field <= 52; ++field)
  {
    stat += std::format(" {}", field);
  }
  Require(FindStatField(stat, 10) == 10u && FindStatField(stat, 12) == 12u &&
              !FindStatField(stat, 60),
          "stat fields by number");
  const std::string_view limits =
      "Limit                     Soft Limit           Hard Limit           "
      "Units\n"
      "Max stack size            8388608              unlimited            "
      "bytes\n"
      "Max address space         unlimited            unlimited            "
      "bytes\n";
  Require(FindSoftLimit(limits, "Max stack size") == 8388608 &&
              FindSoftLimit(limits, "Max address space") ==
                  memory_wire::kUnavailable &&
              FindSoftLimit(limits, "Max locked memory") ==
                  memory_wire::kUnavailable,
          "soft limits; unlimited and missing are unavailable");
}

// Samples this test process: a deadline in the past stops before the first
// read and leaves the sample for a later call, which completes it. The next
// sample of an unchanged layout leaves the regions out, and a refresh sends
// them again. This assumes the process maps nothing between the samples.
void TestMemoryProbe()
{
  using memory_wire::Field;
  MemoryProbe probe;
  probe.Start(::getpid(), false);
  Require(probe.Busy() && !probe.Continue(Nanoseconds{0}) && probe.Busy(),
          "an expired budget defers the read");
  const auto sample = probe.Continue(ClockNow(CLOCK_MONOTONIC) + 10s);
  Require(sample.has_value() && !probe.Busy(), "the sample completes");
  Require(sample->flags_ == memory_wire::Flags::None, "no flags for self");
  Require(
      sample->summary_[Field("vma_count")] > 0 &&
          sample->summary_[Field("vma_count")] != memory_wire::kUnavailable &&
          sample->summary_[Field("maps_reads")] > 0 &&
          sample->summary_[Field("vm_size_bytes")] > 0 &&
          sample->summary_[Field("minor_faults")] !=
              memory_wire::kUnavailable &&
          sample->summary_[Field("max_map_count")] > 0,
      "summary values");
  Require(!sample->regions_.empty() &&
              std::ranges::any_of(sample->regions_,
                                  [](const memory_wire::Region& p_region)
                                  {
                                    return p_region.kind_ ==
                                           memory_wire::RegionKind::Stack;
                                  }),
          "the layout has the main stack");
  // TODO(PR 37 review): this check assumes the test process maps nothing
  // between the two samples. If it flakes, for example because the allocator
  // added a mapping, loosen the check or sample a target with a fixed layout.
  probe.Start(::getpid(), false);
  const auto again = probe.Continue(ClockNow(CLOCK_MONOTONIC) + 10s);
  Require(again && again->regions_.empty(), "an unchanged layout is not sent");
  probe.Start(::getpid(), true);
  const auto refreshed = probe.Continue(ClockNow(CLOCK_MONOTONIC) + 10s);
  Require(refreshed && !refreshed->regions_.empty(),
          "a refresh sends an unchanged layout again");
  probe.Start(0x7fffffff, false);
  const auto missing = probe.Continue(ClockNow(CLOCK_MONOTONIC) + 10s);
  Require(missing && memory_wire::HasFlag(missing->flags_,
                                          memory_wire::Flags::MapsHidden),
          "a missing process has no layout");
}

// Reads maps text that the kernel does not produce, through the path seam:
// a last line without a newline, a line longer than the buffer, and a read
// error (a directory). Each sets MapsPartial and keeps the complete lines.
void TestMemoryProbePartialMaps()
{
  std::string pattern =
      (std::filesystem::temp_directory_path() / "sampler-test-XXXXXX").string();
  Require(::mkdtemp(pattern.data()) != nullptr, "mkdtemp failed");
  const std::filesystem::path directory{pattern};
  const auto sample = [&](const std::string& p_text)
  {
    const auto path = directory / "maps";
    std::ofstream{path} << p_text;
    MemoryProbe probe;
    probe.Start(::getpid(), false, path.c_str());
    return probe.Continue(ClockNow(CLOCK_MONOTONIC) + 10s);
  };
  const auto partial = memory_wire::Flags::MapsPartial;
  const std::string line = "1000-2000 r--p 0 08:01 1 /lib/a.so\n";
  const auto complete = sample(line + line);
  Require(complete && complete->flags_ == memory_wire::Flags::None &&
              complete->summary_[memory_wire::Field("vma_count")] == 2,
          "complete maps text");
  const auto cut = sample(line + "2000-3000 r--p 0 08:01 1 /lib/b");
  Require(cut && memory_wire::HasFlag(cut->flags_, partial) &&
              cut->summary_[memory_wire::Field("vma_count")] == 1,
          "a last line without a newline is partial");
  const auto long_line = sample(line + "3000-4000 r--p 0 08:01 1 /" +
                                std::string(20000, 'x') + "\n" + line);
  Require(long_line && memory_wire::HasFlag(long_line->flags_, partial) &&
              long_line->summary_[memory_wire::Field("vma_count")] == 2,
          "a line longer than the buffer is dropped");
  MemoryProbe probe;
  probe.Start(::getpid(), false, directory.c_str());
  const auto failed = probe.Continue(ClockNow(CLOCK_MONOTONIC) + 10s);
  Require(failed && memory_wire::HasFlag(failed->flags_, partial) &&
              failed->summary_[memory_wire::Field("vma_count")] == 0,
          "a read error is partial");
  std::error_code error;
  std::filesystem::remove_all(directory, error);
}

// Checks NextDeadline, which schedules resource and memory-map samples: the
// first run and a run that fell behind count from now; a run on time keeps
// the previous deadlines' cadence.
// Status text as the kernel writes it, with an owner that differs between the
// real and effective IDs (a setuid program), a security mode and a capability
// set; then text with missing or invalid lines.
void TestProcessInfoParsing()
{
  using process_wire::Flags;
  process_wire::Packet packet;
  ParseProcessStatus(
      "Name:\tapp\nUid:\t1000\t0\t0\t0\nGid:\t100\t200\t200\t200\n"
      "NoNewPrivs:\t1\nSeccomp:\t2\nCapEff:\t0000000000003000\n"
      "Cpus_allowed_list:\t0-3,8\n",
      packet);
  Require(packet.uid_real_ == 1000 && packet.uid_effective_ == 0 &&
              packet.gid_real_ == 100 && packet.gid_effective_ == 200,
          "the real and effective IDs differ for a setuid program");
  Require(packet.no_new_privs_ == 1 && packet.seccomp_ == 2 &&
              packet.cap_effective_ == 0x3000,
          "security settings");
  Require(process_wire::Text(packet.cpus_allowed_) == "0-3,8" &&
              packet.flags_ == Flags::None,
          "allowed CPUs");

  process_wire::Packet unknown;
  ParseProcessStatus("Uid:\t1000\nSeccomp:\t9\nNoNewPrivs:\t2\nCapEff:\tzz\n",
                     unknown);
  Require(unknown.uid_real_ == process_wire::kUnavailable32 &&
              unknown.seccomp_ == process_wire::kUnavailable8 &&
              unknown.no_new_privs_ == process_wire::kUnavailable8 &&
              unknown.cap_effective_ == process_wire::kUnavailable64 &&
              unknown.gid_real_ == process_wire::kUnavailable32,
          "a missing or invalid line stays unavailable");
  Require(!FindStatusText("Uidx:\t1\n", "Uid"), "a longer key is not the key");

  process_wire::Packet cut;
  ParseProcessStatus("Cpus_allowed_list:\t" + std::string(100, '1') + "\n",
                     cut);
  Require(process_wire::HasFlag(cut.flags_, Flags::CpuListTruncated) &&
              process_wire::Text(cut.cpus_allowed_).size() ==
                  process_wire::kCpuListSize - 1,
          "a long CPU list is cut and flagged");

  const auto replaced = SplitDeleted("/usr/bin/app (deleted)");
  Require(replaced.deleted_ && replaced.path_ == "/usr/bin/app",
          "the deleted marker is removed and reported");
  Require(!SplitDeleted("/usr/bin/app").deleted_, "a normal path");

  std::array<char, 16> command{'a', 'p', 'p', '\0', '-', '-', 'x', '\0', '\0'};
  Require(JoinCommandLine(std::span{command}.first(9)) == "app --x",
          "arguments are joined by spaces; trailing NULs are dropped");
  Require(JoinCommandLine(std::span<char>{}).empty(), "no command line");

  Require(StartedWallNs(250, 100, 1000s, 100s) == 902'500'000'000,
          "start time is boot wall time plus ticks since boot");
  Require(StartedWallNs(std::numeric_limits<std::uint64_t>::max() / 4, 100,
                        1000s, 100s) != 0,
          "a large tick count does not overflow the product");
  Require(StartedWallNs(1, 0, 1000s, 100s) == 0 &&
              StartedWallNs(1, 100, 10s, 100s) == 0,
          "unusable clocks give zero");
}

// Reads this test process, whose answers are known, and a process that does
// not exist.
void TestProcessInfoProbe()
{
  using process_wire::Flags;
  const int pid = ::getpid();
  const auto target = FindTarget(TargetPid{pid});
  Require(target && *target, "the test process is found");
  ProcessInfoProbe probe;
  const auto before = ClockNow(CLOCK_REALTIME);
  const auto packet = probe.Read(pid, (*target)->starttime_);
  Require(packet.pid_ == static_cast<std::uint32_t>(pid) &&
              packet.process_start_ == (*target)->starttime_ &&
              packet.parent_pid_ == static_cast<std::uint32_t>(::getppid()) &&
              packet.uid_real_ == ::getuid() &&
              packet.uid_effective_ == ::geteuid() &&
              packet.gid_real_ == ::getgid(),
          "identity and owner");
  std::array<char, 4096> self{};
  const auto length = ::readlink("/proc/self/exe", self.data(), self.size());
  Require(length > 0 && process_wire::Text(packet.exe_) ==
                            std::string_view{self.data(),
                                             static_cast<std::size_t>(length)},
          "the executable path");
  Require(process_wire::Text(packet.cwd_) ==
              std::filesystem::current_path().string(),
          "the working directory");
  Require(process_wire::Text(packet.command_).find("sampler-test") !=
              std::string_view::npos,
          "the command line names the test program");
  Require(packet.flags_ == Flags::None, "nothing hidden or cut for self");
  Require(packet.oom_score_adj_ != process_wire::kUnavailableAdjust &&
              packet.cap_effective_ != process_wire::kUnavailable64 &&
              packet.seccomp_ != process_wire::kUnavailable8 &&
              process_wire::Text(packet.cpus_allowed_).size() > 0,
          "security settings and allowed CPUs were read");
  const auto started =
      Nanoseconds{static_cast<std::int64_t>(packet.started_wall_ns_)};
  Require(started > Nanoseconds{0} && started <= before &&
              before - started < std::chrono::hours{24 * 365},
          "the start time is wall-clock time in the past");

  const auto missing = probe.Read(0x7fffffff, 1);
  Require(process_wire::HasFlag(missing.flags_, Flags::ExeHidden) &&
              process_wire::HasFlag(missing.flags_, Flags::CwdHidden) &&
              missing.parent_pid_ == process_wire::kUnavailable32 &&
              missing.uid_real_ == process_wire::kUnavailable32 &&
              missing.oom_score_adj_ == process_wire::kUnavailableAdjust &&
              process_wire::Text(missing.command_).empty(),
          "a missing process has nothing but its identity");
}

void TestNextDeadline()
{
  using std::chrono::seconds;
  Require(
      NextDeadline(Nanoseconds{0}, seconds{100}, seconds{5}) == seconds{105},
      "the first run counts from now");
  Require(NextDeadline(seconds{100}, seconds{101}, seconds{5}) == seconds{105},
          "a run on time keeps the cadence");
  Require(NextDeadline(seconds{100}, seconds{99}, seconds{5}) == seconds{105},
          "a run a little early keeps the cadence");
  Require(NextDeadline(seconds{100}, seconds{112}, seconds{5}) == seconds{117},
          "a run that fell behind counts from now");
}

std::array<wire::Record, 3> TickOf(std::uint32_t p_first,
                                   std::uint32_t p_second,
                                   std::uint32_t p_third)
{
  std::array<wire::Record, 3> records{};
  records[0].tid_ = p_first;
  records[1].tid_ = p_second;
  records[2].tid_ = p_third;
  return records;
}

// The thread that faults is the first to die, so it can be missing from the
// last tick. A regular file stands in for /dev/kmsg: Watch() seeks to its end
// and Collect() reads what is appended afterwards, here one record.
void TestThreadIdsSeenBeforeTheLastTick()
{
  const auto path =
      std::filesystem::temp_directory_path() /
      std::format("triangulator-kmsg-tids-{}", static_cast<int>(::getpid()));
  std::ofstream{path, std::ios::trunc} << "6,1,1,-;old[1240]: segfault\n";
  RateLimitedLogger logger;
  KernelLog log;
  log.Watch(logger, path.c_str());
  const auto early = TickOf(1234, 1240, 1250);
  const auto last = TickOf(1234, 1250, 1260);
  log.Note(early);
  log.Note(last);
  std::ofstream{path, std::ios::app}
      << "6,2,2,-;worker[1240]: segfault at 0 ip 0 sp 0 error 6\n";
  const auto report = log.Collect({.pid_ = 1234, .starttime_ = 7}, last,
                                  Nanoseconds{1}, logger, 1s);
  std::filesystem::remove(path);
  Require(report.kernel_log_ == exit_wire::KernelLog::Read &&
              report.line_count_ == 1 &&
              exit_wire::FieldText(report.lines_[0]) ==
                  "worker[1240]: segfault at 0 ip 0 sp 0 error 6",
          "a thread seen in an earlier tick, not the last, is still matched");

  // A tick full of new threads does not overflow the remembered set, and the
  // threads alive in the last tick are always kept.
  log.Watch(logger, "/nonexistent/kmsg");
  std::vector<wire::Record> first_many(wire::kMaxThreads);
  std::vector<wire::Record> second_many(wire::kMaxThreads);
  for (std::size_t index = 0; index < first_many.size(); ++index)
  {
    first_many[index].tid_ = static_cast<std::uint32_t>(10'000 + index);
    second_many[index].tid_ = static_cast<std::uint32_t>(20'000 + index);
  }
  log.Note(first_many);
  log.Note(second_many);
  const auto recent = log.Threads();
  Require(recent.size() == second_many.size() &&
              std::ranges::binary_search(recent, 20'000U) &&
              std::ranges::binary_search(recent, 20'000U + 2549),
          "when the union does not fit, the last tick's threads are kept");
  log.Watch(logger, "/nonexistent/kmsg");
  Require(log.Threads().empty(), "a new target starts with no threads");
}

// Feeds /dev/kmsg records in the kernel's own formats to ExitMessages and
// checks which ones it keeps for the ended process (pid 1234, thread 1240).
void TestExitMessages()
{
  Require(KmsgText("6,100,5000,-;hello\n SUBSYSTEM=x\n") == "hello",
          "the text is between ';' and the first newline");
  Require(!KmsgText("no separator"), "a record without ';' has no text");

  const std::array<std::uint32_t, 2> ids{1234, 1240};
  Require(NamesTask("worker[1240]: segfault at 0 ip 0 sp 0 error 6", ids),
          "a segfault names the faulting thread in brackets");
  Require(
      NamesTask("Out of memory: Killed process 1234 (app) total-vm:1kB", ids),
      "the OOM killer names the process");
  Require(NamesTask("oom-kill:constraint=CONSTRAINT_NONE,task=app,pid=1234,"
                    "uid=1000",
                    ids),
          "pid=N names the process");
  Require(
      NamesTask("INFO: task app:1240 blocked for more than 120 seconds.", ids),
      "comm:tid names a thread");
  Require(!NamesTask("other[12345]: segfault at 1234abc", ids),
          "a longer number or a number inside a word does not match");
  Require(!NamesTask("usb 1-1: new device 10.1234 at 0x1234", ids),
          "decimals and hex do not match");
  Require(!NamesTask("other[99]: segfault at 0", ids), "other pids do not");
  Require(NamesTask("traps: worker[1240] trap divide error ip:7f sp:7e", ids),
          "a trap line names the thread in brackets");
  Require(NamesTask("CPU: 1 PID: 1234 Comm: app Not tainted", ids),
          "PID: names the process");
  Require(!NamesTask("oom-kill:constraint=CONSTRAINT_NONE,task=app,pid=99,"
                     "ppid=1234,uid=1234",
                     ids),
          "ppid= and uid= are not the task");
  Require(!NamesTask("other[99]: segfault at 1234 ip 0 sp 0 error 6", ids),
          "a fault address equal to a pid is not the task");
  Require(!NamesTask("[ 1234.5678] something happened to usb 1-1", ids),
          "a timestamp is not a task");

  std::array<wire::Record, 2> threads{};
  threads[0].tid_ = 1234;
  threads[1].tid_ = 1240;
  const std::array<std::uint32_t, 2> tids{1234, 1240};
  ExitMessages messages{1234, tids};
  messages.Offer("4,1,10,-;[   1234]  1000  1234  100  50  0  0  0 app\n");
  messages.Offer("6,2,11,-;other[99]: segfault at 0\n");
  // Numbers that merely equal the process or a thread ID: the fault address
  // of another process and a user ID.
  messages.Offer("6,2,11,-;other[99]: segfault at 1234 ip 0 sp 0 error 6\n");
  messages.Offer("6,2,11,-;other[99]: segfault at 1240 ip 0 sp 0 error 6\n");
  for (int index = 0; index < 7; ++index)
  {
    messages.Offer(
        std::format("4,{},12,-;app[1240]: trap {}\n", 3 + index, index));
  }
  messages.Offer("3,10,13,-;Out of memory: Killed process 1234 (app)\n");
  exit_wire::Report report{};
  messages.CopyTo(report);
  Require(report.line_count_ == exit_wire::kMaxLines,
          "only the newest six messages are kept");
  Require(exit_wire::FieldText(report.lines_[0]) == "app[1240]: trap 2" &&
              exit_wire::FieldText(report.lines_[5]) ==
                  "Out of memory: Killed process 1234 (app)",
          "oldest first; the OOM task table and other pids are left out");

  // A process whose PID equals another task's user ID: the OOM killer's
  // summary for pid 99 must not be taken as its own.
  const std::array<std::uint32_t, 1> user_tids{1000};
  ExitMessages other_user{1000, user_tids};
  other_user.Offer(
      "6,20,5,-;oom-kill:constraint=CONSTRAINT_NONE,task=other,pid=99,"
      "uid=1000\n");
  other_user.Offer("6,21,6,-;other[99]: segfault at 1000 ip 0 sp 0 error 6\n");
  exit_wire::Report unrelated{};
  other_user.CopyTo(unrelated);
  Require(unrelated.line_count_ == 0,
          "messages about another task are not kept for this one");

  TestThreadIdsSeenBeforeTheLastTick();

  RateLimitedLogger logger;
  KernelLog log;
  log.Watch(logger, "/nonexistent/kmsg");
  const auto missing = log.Collect({.pid_ = 1234, .starttime_ = 7}, threads,
                                   Nanoseconds{1}, logger);
  Require(missing.kernel_log_ == exit_wire::KernelLog::Unavailable &&
              missing.error_ == ENOENT && missing.line_count_ == 0 &&
              missing.pid_ == 1234 && missing.process_start_ == 7,
          "a missing kernel log gives a report that says so");
  // The sampler adds the two sessions after Collect(), where it knows them.
  auto with_sessions = missing;
  with_sessions.ended_session_ = 1;
  with_sessions.next_session_ = 2;
  Require(exit_wire::Decode(wire::AsBytes(with_sessions)).has_value(),
          "the report the sampler builds is valid on the wire");

  // A kernel log with a record that was written after the watch began. A
  // plain file stands in for /dev/kmsg: Watch seeks to its end.
  const auto fake_log =
      std::filesystem::temp_directory_path() /
      std::format("triangulator-kmsg-{}", static_cast<int>(::getpid()));
  const auto watch_fake_log = [&]
  {
    std::ofstream{fake_log, std::ios::trunc} << "6,1,1,-;old[1234]: segfault\n";
    log.Watch(logger, fake_log.c_str());
    log.Note(threads);
    std::ofstream{fake_log, std::ios::app}
        << "6,2,2,-;worker[1240]: segfault at 0 ip 0 sp 0 error 6\n";
  };
  watch_fake_log();
  const auto found = log.Collect({.pid_ = 1234, .starttime_ = 7}, threads,
                                 Nanoseconds{1}, logger, 1s);
  Require(found.kernel_log_ == exit_wire::KernelLog::Read &&
              found.line_count_ == 1 &&
              exit_wire::FieldText(found.lines_[0]) ==
                  "worker[1240]: segfault at 0 ip 0 sp 0 error 6",
          "only messages logged after the watch began are read");
  watch_fake_log();
  const auto cut = log.Collect({.pid_ = 1234, .starttime_ = 7}, threads,
                               Nanoseconds{1}, logger, Nanoseconds{0});
  std::filesystem::remove(fake_log);
  Require(cut.kernel_log_ == exit_wire::KernelLog::Read && cut.line_count_ == 0,
          "a drain with no time left reads nothing but still reports");

  const auto self = FindTarget(TargetPid{::getpid()});
  Require(self && *self, "the test process is found");
  const auto running = ProcessEnded(**self);
  Require(running && !*running, "a running process has not ended");
  const auto reused = ProcessEnded(
      {.pid_ = (*self)->pid_, .starttime_ = (*self)->starttime_ + 1});
  Require(reused && *reused,
          "a PID that now belongs to another process has ended");
  const auto gone = ProcessEnded({.pid_ = 0x7ffffff0, .starttime_ = 1});
  Require(gone && *gone, "a PID with no /proc entry has ended");

  // With no descriptors left, the check cannot be made. It must say so, and
  // not report that the process is still running.
  rlimit saved{};
  Require(::getrlimit(RLIMIT_NOFILE, &saved) == 0, "the limit is readable");
  rlimit low = saved;
  low.rlim_cur = std::min<rlim_t>(saved.rlim_cur, 64);
  Require(::setrlimit(RLIMIT_NOFILE, &low) == 0, "the limit can be lowered");
  std::vector<FileDescriptor> held;
  for (;;)
  {
    FileDescriptor descriptor{::open("/dev/null", O_RDONLY | O_CLOEXEC)};
    if (!descriptor)
    {
      break;
    }
    held.push_back(std::move(descriptor));
  }
  const auto exhausted = ProcessEnded(**self);
  held.clear();
  Require(::setrlimit(RLIMIT_NOFILE, &saved) == 0, "the limit is restored");
  Require(!exhausted && exhausted.error() == EMFILE,
          "running out of descriptors is an error, not an answer");
}

// Whether the kernel keeps the exit status for a pidfd after the parent
// reaps the process: PIDFD_INFO_EXIT, Linux 6.15 and later.
bool KernelKeepsExitStatus()
{
  utsname name{};
  if (::uname(&name) != 0)
  {
    return false;
  }
  std::string_view release{name.release};
  const auto major = LeadingId(release, ".");
  const auto minor = LeadingId(release.substr(release.find('.') + 1), ".-+");
  return major && minor && (*major > 6 || (*major == 6 && *minor >= 15));
}

// A child process that ends when the test writes to its pipe, so the
// sampler's watch can start while it runs. Reaps the child when it is not
// reaped by the test.
class Child final
{
 public:
  explicit Child(int p_exit_code)
  {
    std::array<int, 2> pipe_ends{};
    if (::pipe(pipe_ends.data()) != 0)
    {
      throw std::runtime_error("pipe failed");
    }
    pid_ = ::fork();
    if (pid_ == 0)
    {
      ::close(pipe_ends[1]);
      char byte = 0;
      ssize_t received = 0;
      do
      {
        received = ::read(pipe_ends[0], &byte, 1);
      } while (received < 0 && errno == EINTR);
      if (received < 0)
      {
        ::_exit(255);
      }
      ::_exit(p_exit_code);
    }
    ::close(pipe_ends[0]);
    release_.Reset(pipe_ends[1]);
    if (pid_ < 0)
    {
      throw std::runtime_error("fork failed");
    }
  }
  Child(const Child&) = delete;
  Child& operator=(const Child&) = delete;
  Child(Child&&) = delete;
  Child& operator=(Child&&) = delete;
  ~Child()
  {
    if (!reaped_)
    {
      ::kill(pid_, SIGKILL);
      Reap();
    }
  }
  [[nodiscard]] TargetIdentity Identity() const
  {
    const auto found = FindTarget(TargetPid{pid_});
    Require(found && *found, "the child is found");
    return **found;
  }
  void End()
  {
    release_.Reset();
  }
  // Waits until the child has ended and is a zombie, without reaping it.
  void AwaitZombie() const
  {
    siginfo_t info{};
    Require(
        ::waitid(P_PID, static_cast<id_t>(pid_), &info, WEXITED | WNOWAIT) == 0,
        "the child ends");
  }
  int Reap()
  {
    int status = 0;
    static_cast<void>(::waitpid(pid_, &status, 0));
    reaped_ = true;
    return status;
  }
  [[nodiscard]] int Pid() const
  {
    return pid_;
  }

 private:
  int pid_ = -1;
  FileDescriptor release_;
  bool reaped_ = false;
};

// Reads exit statuses of real child processes: from /proc while a zombie,
// through the pidfd once reaped, and none for a PID that was reused.
void TestExitStatus()
{
  std::string stat = "1234 (a b) c) S";
  for (int field = 4; field <= 51; ++field)
  {
    stat += std::format(" {}", field);
  }
  Require(ParseExitCode(stat + " 139") == 139,
          "field 52 is read past a name with spaces and ')'");
  Require(!ParseExitCode(stat), "a stat without field 52 has no status");
  Require(!ParseExitCode(stat + " -1") && !ParseExitCode(stat + " 65536"),
          "a value outside a wait status is not one");

  {
    Child child{3};
    ExitStatusWatch watch;
    const auto identity = child.Identity();
    watch.Watch(identity);
    child.End();
    child.AwaitZombie();
    const auto status = watch.Collect(identity);
    Require(status == child.Reap() && status == (3 << 8),
            "a zombie's status is its exit code");
  }
  {
    Child child{0};
    ExitStatusWatch watch;
    const auto identity = child.Identity();
    watch.Watch(identity);
    Require(::kill(child.Pid(), SIGKILL) == 0, "the child is killed");
    Require(child.Reap() == SIGKILL, "the child died of SIGKILL");
    const auto status = watch.Collect(identity);
    Require(KernelKeepsExitStatus() ? status == SIGKILL
                                    : (!status || status == SIGKILL),
            "a reaped process's status comes from the pidfd");
  }
  {
    Child child{0};
    ExitStatusWatch watch;
    auto identity = child.Identity();
    ++identity.starttime_;
    watch.Watch(identity);
    child.End();
    child.Reap();
    Require(!watch.Collect(identity),
            "a PID that belongs to another process is not watched");
  }
}

int main()
{
  try
  {
    TestParsing();
    TestConfig();
    TestMultipleTargetConfig();
    TestSharedDescriptorBudget();
    TestWire();
    TestRaii();
    TestDescriptorBudget();
    TestResourceParsing();
    TestMemoryCgroupAndInterfaceParsing();
    TestSocketRanking();
    TestResourceProbe();
    TestMemoryParsing();
    TestMemoryProbe();
    TestMemoryProbePartialMaps();
    TestProcessInfoParsing();
    TestProcessInfoProbe();
    TestNextDeadline();
    TestExitMessages();
    TestExitStatus();
    std::puts(
        "C++ sampler tests passed (parsing, configuration, wire compatibility, "
        "RAII, descriptor budget, resource parsing and probe, memory map, "
        "process identity, exit messages and status)");
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
