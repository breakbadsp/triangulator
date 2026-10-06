#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/ioctl.h>

#include <limits>
#include <stdexcept>
#include <type_traits>

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
      record,
      "04030201530002010807060504030201090000000000000"
      "00a000000000000000b0000000000000005000000000000000c000000000000000d00000"
      "000000000"
      "776f726b657200000000000000000000"
      "66757465785f646f5f7761697400000000000000000000000000000000000000");
  const auto missing_io =
      wire::EncodeSample(1, stat, {10, 11}, std::nullopt, WaitChannel{});
  Require(missing_io[5] == std::byte{1}, "unreadable io is flagged");
  std::array<std::byte, wire::kHeaderSize> header{};
  wire::EncodeHeader(header, {.flags_ = wire::Flags::StatusFallback,
                              .chunk_ = 1,
                              .chunks_ = 3,
                              .session_ = 0x0102030405060708ULL,
                              .sequence_ = 0x090a0b0c,
                              .records_ = 1,
                              .monotonic_ns_ = 12,
                              .wall_ns_ = 13,
                              .interval_ms_ = 1000,
                              .pid_ = 0x01020304});
  RequireHex(header,
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
  std::vector<resource_wire::Socket> sockets;
  for (std::uint32_t fd = 10; fd < 40; ++fd)
  {
    sockets.push_back(SyntheticSocket(fd, fd));
  }
  sockets.push_back(sender);
  Require(KeepFullest(sockets), "more than kMaxSockets are cut");
  Require(sockets.size() == resource_wire::kMaxSockets &&
              sockets.front().fd_ == 2 && sockets[1].fd_ == 39 &&
              sockets.back().fd_ == 17,
          "the fullest sockets are kept, fullest first");
  std::vector<resource_wire::Socket> few{SyntheticSocket(1, 0)};
  Require(!KeepFullest(few) && few.size() == 1, "few sockets are all kept");
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
    std::puts(
        "C++ sampler tests passed (parsing, configuration, wire compatibility, "
        "RAII, descriptor budget, resource parsing and probe)");
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
