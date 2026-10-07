#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/ioctl.h>
#include <sys/mman.h>

#include <limits>
#include <stdexcept>
#include <type_traits>

#include "../sampler/memory_map.hpp"
#include "../sampler/memory_parsing.hpp"
#include "../sampler/proc.hpp"
#include "../sampler/resources.hpp"

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
  Require(config->resource_interval_s_ == 5, "resource samples default to 5 s");
  const auto resources_off = ParseConfig(
      "target_pid=1\ncollector=127.0.0.1:9400\nresource_interval_s=0\n");
  Require(resources_off && resources_off->resource_interval_s_ == 0,
          "resource samples can be turned off");
  const auto memory = ParseConfig(
      "target_pid=1\ncollector=127.0.0.1:9400\nmemory_map_enabled=true\n"
      "memory_map_token_file=/tmp/token\nmemory_map_interval_s=5\n"
      "memory_map_keyframe_s=5\nmemory_map_max_vmas=256\n"
      "memory_map_max_lease_s=60\nmemory_map_listen=\"[::1]:9500\"\n");
  Require(memory && memory->memory_map_enabled_ &&
              memory->memory_map_interval_s_ == 5 &&
              memory->memory_map_max_vmas_ == 256 &&
              memory->memory_map_max_lease_s_ == 60 &&
              memory->memory_map_listen_ == "[::1]:9500",
          "memory-map keys");
  Require(config->memory_map_interval_s_ == 2 &&
              config->memory_map_keyframe_s_ == 30 &&
              config->memory_map_max_vmas_ == 8192 &&
              !config->memory_map_enabled_,
          "memory-map defaults: off, 2 s, 30 s, 8192");
  auto changed = *memory;
  changed.memory_map_interval_s_ = 9;
  changed.memory_map_enabled_ = false;
  Require(changed.SameSampling(*memory), "memory keys keep the session");
  changed.rate_hz_ = 2;
  Require(!changed.SameSampling(*memory), "the rate starts a new session");
  for (const auto invalid : {
           "target_pid=1\ncollector=127.0.0.1:9400\nmemory_map_enabled=true",
           "target_pid=1\ncollector=127.0.0.1:9400\nmemory_map_interval_s=0",
           "target_pid=1\ncollector=127.0.0.1:9400\nmemory_map_max_vmas=255",
           "target_pid=1\ncollector=127.0.0.1:9400\nmemory_map_max_lease_s=4",
           "target_pid=1\ncollector=127.0.0.1:9400\nmemory_map_keyframe_s=301",
           "target_pid=1\ncollector=127.0.0.1:9400\nmemory_map_interval_s=9\n"
           "memory_map_keyframe_s=8",
           "target_pid=1\ncollector=127.0.0.1:9400\nmemory_map_other=1",
           "target_pid=1\ncollector=127.0.0.1:9400\nmemory_map_enabled=yes",
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

// The memory-map parsers read fixture text shaped like the kernel's files,
// including the cases that real files have: names with spaces, deleted
// files, kernel names and unlimited limits.
void TestMemoryParsing()
{
  const auto heap = ParseMapsLine(
      "55d0c1a00000-55d0c6e00000 rw-p 00000000 00:00 0                    "
      "      [heap]");
  Require(heap.has_value(), "heap line must parse");
  Require(heap->start_ == 0x55d0c1a00000 && heap->end_ == 0x55d0c6e00000,
          "address range");
  Require(heap->permissions_ == 3, "rw-p is read and write, private");
  Require(heap->name_ == "[heap]" && heap->inode_ == 0, "heap name");
  const auto library = ParseMapsLine(
      "7f8a10000000-7f8a10021000 r-xs 0001c000 fd:01 1234567   "
      "/usr/lib/my lib.so (deleted)");
  Require(library.has_value(), "library line must parse");
  Require(library->permissions_ == (1 | 4 | 8), "r-xs");
  Require(library->offset_ == 0x1c000 && library->inode_ == 1234567 &&
              library->device_major_ == 0xfd && library->device_minor_ == 1,
          "offset, inode and device");
  Require(library->name_ == "/usr/lib/my lib.so" && library->deleted_,
          "a name with a space keeps it; (deleted) becomes a flag");
  const auto anonymous =
      ParseMapsLine("7f8a20000000-7f8a24000000 ---p 00000000 00:00 0\n");
  Require(anonymous && anonymous->name_.empty() && anonymous->permissions_ == 0,
          "an anonymous guard mapping has no name and no permissions");
  Require(!ParseMapsLine("7f8a-7f80 rw-p 0 00:00 0"),
          "an empty or reversed range is invalid");
  Require(!ParseMapsLine("7f80-7f8a rwzp 0 00:00 0"),
          "unknown permission letters are invalid");
  Require(!ParseMapsLine("7f80-7f8a rw-p 0 0000 0"), "device needs a colon");
  Require(!ParseMapsLine(""), "an empty line is invalid");

  std::string stat = "42 (a) b) S";
  for (int field = 4; field <= 52; ++field)
  {
    stat += std::format(" {}", field == 10   ? 900
                               : field == 12 ? 7
                               : field == 28 ? 140737488347136
                                             : 0);
  }
  const auto process = ParseProcessStat(stat);
  Require(process && process->minor_faults_ == 900 &&
              process->major_faults_ == 7 &&
              process->start_stack_ == 140737488347136,
          "process stat fields 10, 12 and 28");
  Require(!ParseProcessStat("42 (a) S 1 2 3"), "short stat is invalid");

  const std::string_view limits =
      "Limit                     Soft Limit           Hard Limit           "
      "Units\n"
      "Max stack size            8388608              unlimited            "
      "bytes\n"
      "Max address space         unlimited            unlimited            "
      "bytes\n"
      "Max locked memory         8388608              8388608              "
      "bytes\n";
  Require(ParseSoftLimit(limits, "Max stack size") == 8388608, "stack limit");
  Require(!ParseSoftLimit(limits, "Max address space"),
          "unlimited is not a number");
  Require(ParseSoftLimit(limits, "Max locked memory") == 8388608,
          "locked memory");
  Require(!ParseSoftLimit(limits, "Max stack"),
          "a row prefix is not a row name");

  const auto present = DecodePagemapEntry((std::uint64_t{1} << 63) |
                                          (std::uint64_t{1} << 56) | 0x1234);
  Require(present.present_ && present.exclusive_ && !present.swapped_ &&
              !present.file_or_shared_,
          "present, exclusive anonymous page");
  const auto swapped = DecodePagemapEntry(std::uint64_t{1} << 62);
  Require(swapped.swapped_ && !swapped.present_, "swapped page");
  const auto file =
      DecodePagemapEntry((std::uint64_t{1} << 63) | (std::uint64_t{1} << 61));
  Require(file.present_ && file.file_or_shared_ && !file.exclusive_,
          "present file page mapped by others too");
  Require(!DecodePagemapEntry(0).present_, "an empty entry is not present");
}

// Finds the VMA that starts at p_start in the reader's list.
const memory_wire::Vma* FindVma(const MemoryMapReader& p_reader,
                                const void* p_start)
{
  const auto start = reinterpret_cast<std::uintptr_t>(p_start);
  for (const auto& vma : p_reader.Vmas())
  {
    if (vma.start_ == start)
    {
      return &vma;
    }
  }
  return nullptr;
}

// The reader on this test process: a new mapping is marked new and raises
// the generation, a grown one is marked EndMoved, a removed one is counted,
// and a cycle without changes keeps the generation. The scanner reads the
// pages of one mapping: half of them touched gives half resident.
void TestMemoryMapReader()
{
  const auto page = static_cast<std::size_t>(::sysconf(_SC_PAGESIZE));
  const int pid = ::getpid();
  MemoryMapReader reader{memory_wire::kMaxVmas};
  const std::stop_token never;
  auto cycle = reader.Read(pid, std::nullopt, never);
  Require(cycle.layout_changed_ && reader.Generation() == 1,
          "the first cycle is a change");
  Require(
      cycle.summary_[memory_wire::Field("vma_count")] == reader.Vmas().size(),
      "every VMA is in the list");
  Require(cycle.summary_[memory_wire::Field("vm_rss_bytes")] > 0 &&
              cycle.summary_[memory_wire::Field("page_size_bytes")] == page,
          "status and page size");
  Require(std::ranges::is_sorted(reader.Vmas(), {}, &memory_wire::Vma::start_),
          "sorted by start");
  Require(std::ranges::all_of(reader.Vmas(),
                              [](const memory_wire::Vma& p_vma)
                              {
                                return p_vma.changes_ == 0;
                              }),
          "the first cycle marks nothing");
  cycle = reader.Read(pid, std::nullopt, never);
  Require(!cycle.layout_changed_ && reader.Generation() == 1,
          "no change, same generation");

  // Reserve more than needed so the mapping can grow in place.
  auto* region = static_cast<char*>(::mmap(nullptr, 64 * page, PROT_NONE,
                                           MAP_PRIVATE | MAP_ANONYMOUS, -1, 0));
  Require(region != MAP_FAILED, "mmap");
  Require(::mprotect(region, 16 * page, PROT_READ | PROT_WRITE) == 0,
          "mprotect");
  cycle = reader.Read(pid, std::nullopt, never);
  const auto* added = FindVma(reader, region);
  Require(
      cycle.layout_changed_ && reader.Generation() == 2 && added != nullptr &&
          added->changes_ == std::to_underlying(memory_wire::Changes::New) &&
          added->end_ == reinterpret_cast<std::uintptr_t>(region) + 16 * page,
      "a new mapping is marked new");
  Require(::mprotect(region, 24 * page, PROT_READ | PROT_WRITE) == 0, "grow");
  cycle = reader.Read(pid, std::nullopt, never);
  const auto* grown = FindVma(reader, region);
  Require(grown != nullptr &&
              grown->changes_ ==
                  std::to_underlying(memory_wire::Changes::EndMoved) &&
              cycle.summary_[memory_wire::Field("vmas_resized")] >= 1,
          "a mapping whose end moved is marked EndMoved");

  for (std::size_t index = 0; index < 24; index += 2)
  {
    region[index * page] = 1;
  }
  cycle = reader.Read(pid, reinterpret_cast<std::uintptr_t>(region), never);
  Require(cycle.detail_.has_value(), "detail on request");
  Require(cycle.detail_->status_ == memory_wire::DetailStatus::Complete &&
              cycle.detail_->pages_per_cell_ == 1 &&
              reader.Cells().size() == 24,
          "one cell per page for a small mapping");
  Require(cycle.detail_->resident_pages_ == 12 &&
              cycle.detail_->measured_pages_ == 24,
          "every other page is resident");
  Require(reader.Cells()[0].resident_ == memory_wire::kCellScale &&
              reader.Cells()[1].resident_ == 0,
          "cells follow the pages");
  Require(reader.Cells()[0].shared_ == 0,
          "a private anonymous page is exclusive");
  cycle = reader.Read(pid, 1, never);
  Require(cycle.detail_->status_ == memory_wire::DetailStatus::NotFound,
          "no VMA at that address");

  Require(::munmap(region, 64 * page) == 0, "munmap");
  cycle = reader.Read(pid, std::nullopt, never);
  Require(cycle.layout_changed_ && FindVma(reader, region) == nullptr &&
              cycle.summary_[memory_wire::Field("vmas_removed")] >= 1,
          "a removed mapping is counted");

  // A mapping larger than one burst is read over several cycles.
  const auto large_pages = 2 * PageScanner::kPagesPerBurst + 10;
  auto* large = ::mmap(nullptr, large_pages * page, PROT_READ,
                       MAP_PRIVATE | MAP_ANONYMOUS | MAP_NORESERVE, -1, 0);
  Require(large != MAP_FAILED, "large mmap");
  const auto large_start = reinterpret_cast<std::uintptr_t>(large);
  MemoryMapReader scanner{memory_wire::kMaxVmas};
  static_cast<void>(scanner.Read(pid, std::nullopt, never));
  std::size_t cycles = 0;
  for (; cycles < 10; ++cycles)
  {
    cycle = scanner.Read(pid, large_start, never);
    if (cycle.detail_->status_ == memory_wire::DetailStatus::Complete)
    {
      break;
    }
    Require(cycle.detail_->status_ == memory_wire::DetailStatus::Measuring &&
                cycle.detail_->measured_pages_ < large_pages,
            "a pass in progress");
  }
  Require(cycles >= 2 && cycles < 10, "the pass ends after several cycles");
  Require(scanner.Cells().size() == memory_wire::kMaxCells &&
              cycle.detail_->measured_pages_ == large_pages &&
              cycle.detail_->resident_pages_ == 0,
          "an untouched reservation has no resident pages");
  Require(::munmap(large, large_pages * page) == 0, "munmap large");

  // A list shorter than the process keeps the largest VMAs and the stack.
  MemoryMapReader truncated{4};
  cycle = truncated.Read(pid, std::nullopt, never);
  Require(memory_wire::HasFlag(cycle.flags_, memory_wire::Flags::Truncated) &&
              truncated.Vmas().size() == 4 &&
              cycle.summary_[memory_wire::Field("vma_count")] > 4,
          "truncated to max_vmas");
  Require(std::ranges::any_of(truncated.Vmas(),
                              [](const memory_wire::Vma& p_vma)
                              {
                                return p_vma.kind_ ==
                                       memory_wire::VmaKind::Stack;
                              }),
          "the stack stays in a truncated list");
  Require(!truncated.Read(999'999'999, std::nullopt, never).layout_changed_,
          "an absent process is not a change");
}

void TestClassifyVma()
{
  const auto kind = [](std::string_view p_line)
  {
    return ClassifyVma(*ParseMapsLine(p_line));
  };
  Require(kind("1000-2000 rw-p 0 00:00 0 [heap]") == memory_wire::VmaKind::Heap,
          "heap");
  Require(
      kind("1000-2000 r-xp 0 00:00 0 [vdso]") == memory_wire::VmaKind::Kernel,
      "vdso");
  Require(kind("1000-2000 rw-p 0 00:00 0 [anon:arena]") ==
              memory_wire::VmaKind::NamedAnonymous,
          "named anonymous");
  Require(
      kind("1000-2000 rw-p 0 00:00 0 [uprobes]") == memory_wire::VmaKind::Other,
      "other kernel name");
  Require(kind("1000-2000 rw-p 0 00:00 0") == memory_wire::VmaKind::Anonymous,
          "anonymous");
  const auto vma =
      ToWireVma(*ParseMapsLine("1000-2000 r-xp 0 08:01 7 /lib/a.so (deleted)"));
  Require(
      vma.kind_ == memory_wire::VmaKind::File &&
          vma.flags_ == std::to_underlying(memory_wire::VmaFlags::Deleted) &&
          vma.Name() == "/lib/a.so",
      "deleted file");
}

int main()
{
  try
  {
    TestParsing();
    TestConfig();
    TestWire();
    TestRaii();
    TestDescriptorBudget();
    TestResourceParsing();
    TestMemoryCgroupAndInterfaceParsing();
    TestSocketRanking();
    TestResourceProbe();
    TestMemoryParsing();
    TestClassifyVma();
    TestMemoryMapReader();
    std::puts(
        "C++ sampler tests passed (parsing, configuration, wire compatibility, "
        "RAII, descriptor budget, resource parsing and probe, memory "
        "parsing and reader)");
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
