#pragma once

// The resource probe: what the target's threads share. It reads, without
// privileges, pressure stall information for the host and the target's
// cgroup, the target's descriptors and storage I/O, the queues and buffers of
// the target's own sockets (sock_diag, matched by inode through
// /proc/PID/fd), and the drop and overflow counters of its network
// namespace. The sampler runs it at a slower rate than thread ticks.

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstring>
#include <optional>
#include <span>
#include <string_view>
#include <tuple>
#include <vector>

#include "io.hpp"
#include "resource_parsing.hpp"
#include "socket_diag.hpp"

namespace triangulator
{

using resource_wire::Field;

// cgroup_ and sockets_ view the probe's storage. They stay valid until the
// probe's next Sample().
struct ResourceSample
{
  resource_wire::SummaryValues summary_ = resource_wire::EmptySummary();
  resource_wire::Flags flags_ = resource_wire::Flags::None;
  std::string_view cgroup_;
  // The target's fullest sockets first, at most kMaxSockets.
  std::span<const resource_wire::Socket> sockets_;
};

// How full a socket's buffers are, 0 (empty) to 1 (at its limit): the
// receive buffer, the send buffer or, for a listener, the accept backlog.
[[nodiscard]] inline double Fullness(const resource_wire::Socket& p_socket)
{
  if (p_socket.state_ == std::to_underlying(SocketState::Listen))
  {
    return p_socket.tx_queue_ ? static_cast<double>(p_socket.rx_queue_) /
                                    static_cast<double>(p_socket.tx_queue_)
                              : 0;
  }
  const double received = p_socket.rcvbuf_
                              ? static_cast<double>(p_socket.rmem_alloc_) /
                                    static_cast<double>(p_socket.rcvbuf_)
                              : 0;
  const double sent = p_socket.sndbuf_
                          ? static_cast<double>(std::max(
                                p_socket.wmem_queued_, p_socket.wmem_alloc_)) /
                                static_cast<double>(p_socket.sndbuf_)
                          : 0;
  return std::max(received, sent);
}

// Keeps the kMaxSockets sockets most worth a look: buffer fullness, then
// queued bytes, then drops. The storage is fixed. It is a heap whose front
// is the least full socket kept, so a fuller socket replaces that one.
class FullestSockets
{
 public:
  void Clear() noexcept
  {
    size_ = 0;
    truncated_ = false;
  }

  void Add(const resource_wire::Socket& p_socket)
  {
    if (size_ < sockets_.size())
    {
      sockets_[size_++] = p_socket;
      std::ranges::push_heap(Kept(), Fuller);
      return;
    }
    truncated_ = true;
    if (Fuller(p_socket, sockets_.front()))
    {
      std::ranges::pop_heap(sockets_, Fuller);
      sockets_.back() = p_socket;
      std::ranges::push_heap(sockets_, Fuller);
    }
  }

  // The kept sockets, fullest first. Add nothing after this until Clear().
  [[nodiscard]] std::span<const resource_wire::Socket> Sorted()
  {
    std::ranges::sort(Kept(), Fuller);
    return Kept();
  }

  // Whether sockets were cut because more than kMaxSockets were added.
  [[nodiscard]] bool Truncated() const noexcept
  {
    return truncated_;
  }

 private:
  [[nodiscard]] std::span<resource_wire::Socket> Kept() noexcept
  {
    return std::span{sockets_}.first(size_);
  }

  [[nodiscard]] static bool Fuller(const resource_wire::Socket& p_left,
                                   const resource_wire::Socket& p_right)
  {
    const auto key = [](const resource_wire::Socket& p_socket)
    {
      return std::tuple{Fullness(p_socket),
                        std::uint64_t{p_socket.rx_queue_} + p_socket.tx_queue_,
                        p_socket.drops_, p_socket.total_retrans_};
    };
    const auto left = key(p_left);
    const auto right = key(p_right);
    return left != right ? left > right : p_left.fd_ < p_right.fd_;
  }

  std::array<resource_wire::Socket, resource_wire::kMaxSockets> sockets_{};
  std::size_t size_ = 0;
  bool truncated_ = false;
};

class ResourceProbe
{
 public:
  // Descriptor links read per sample. A process with more descriptors is
  // still counted, but sockets past this many are not matched.
  static constexpr std::size_t kMaxDescriptorLinks = 65536;
  static constexpr std::size_t kDiagBufferSize = 65536;

  // All of the probe's heap storage is allocated here, at startup.
  ResourceProbe() : diag_buffer_(kDiagBufferSize)
  {
    socket_fds_.reserve(kMaxDescriptorLinks);
  }

  // The result views the probe's storage until the next call.
  [[nodiscard]] ResourceSample Sample(int p_pid)
  {
    ResourceSample sample;
    ReadPressure(p_pid, sample);
    ReadDescriptors(p_pid, sample);
    ReadProcessIo(p_pid, sample);
    ReadProcessMemory(p_pid, sample);
    ReadCgroupLimits(sample);
    const auto same_namespace = SameNetworkNamespace(p_pid);
    if (same_namespace == false)
    {
      sample.flags_ =
          sample.flags_ | resource_wire::Flags::OtherNetworkNamespace;
    }
    else
    {
      ReadSockets(sample);
      ReadSocketLimits(sample);
    }
    ReadNamespaceCounters(p_pid, sample);
    return sample;
  }

 private:
  using Flags = resource_wire::Flags;

  // Pressure fields are four per resource (some avg10, some total, full
  // avg10, full total) for cpu, memory and io, host first, then cgroup.
  static constexpr std::size_t kHostPressure = Field("host_cpu_some_avg10");
  static constexpr std::size_t kCgroupPressure = Field("cgroup_cpu_some_avg10");
  static_assert(Field("host_io_full_total") == kHostPressure + 11);
  static_assert(Field("cgroup_io_full_total") == kCgroupPressure + 11);
  static constexpr std::array<std::string_view, 3> kPressureResources{
      "cpu", "memory", "io"};
  static constexpr std::size_t kTcpStates = Field("tcp_established");
  static_assert(Field("tcp_closing") == kTcpStates + 9);

  // A socket descriptor of the target, found by the socket's inode.
  struct SocketFd
  {
    std::uint64_t inode_;
    std::uint32_t fd_;
  };

  // Contents of p_path, valid until the next read, or nullopt.
  [[nodiscard]] std::optional<std::string_view> Read(const char* p_path)
  {
    return ReadAtStart(OpenReadonly(p_path), buffer_);
  }

  void StorePressure(std::size_t p_first, std::string_view p_text,
                     resource_wire::SummaryValues& p_summary)
  {
    const auto pressure = ParsePressure(p_text);
    if (pressure.some_)
    {
      p_summary[p_first] = pressure.some_->avg10_hundredths_;
      p_summary[p_first + 1] = pressure.some_->total_us_;
    }
    if (pressure.full_)
    {
      p_summary[p_first + 2] = pressure.full_->avg10_hundredths_;
      p_summary[p_first + 3] = pressure.full_->total_us_;
    }
  }

  void ReadPressure(int p_pid, ResourceSample& p_sample)
  {
    for (std::size_t index = 0; index < kPressureResources.size(); ++index)
    {
      if (const auto text =
              Read(FixedString{"/proc/pressure/{}", kPressureResources[index]}
                       .CStr()))
      {
        StorePressure(kHostPressure + index * 4, *text, p_sample.summary_);
      }
    }
    const auto cgroups = Read(FixedString{"/proc/{}/cgroup", p_pid}.CStr());
    const auto path = cgroups.and_then(ParseCgroupPath);
    if (!path)
    {
      return;
    }
    // Copy the path: it views buffer_, which the next Read() overwrites. A
    // path too long for FixedString becomes empty, and is skipped.
    cgroup_ = FixedString{"{}", *path};
    p_sample.cgroup_ = cgroup_.View();
    if (p_sample.cgroup_.empty())
    {
      return;
    }
    for (std::size_t index = 0; index < kPressureResources.size(); ++index)
    {
      if (const auto text =
              Read(FixedString{"/sys/fs/cgroup{}/{}.pressure", p_sample.cgroup_,
                               kPressureResources[index]}
                       .CStr()))
      {
        StorePressure(kCgroupPressure + index * 4, *text, p_sample.summary_);
      }
    }
  }

  // Counts the descriptors and remembers which are sockets, by inode.
  void ReadDescriptors(int p_pid, ResourceSample& p_sample)
  {
    auto& summary = p_sample.summary_;
    socket_fds_.clear();
    links_hidden_ = false;
    if (const auto limits = Read(FixedString{"/proc/{}/limits", p_pid}.CStr())
                                .and_then(ParseDescriptorLimits))
    {
      summary[Field("fd_soft_limit")] = limits->soft_;
      summary[Field("fd_hard_limit")] = limits->hard_;
    }
    Directory directory{FixedString{"/proc/{}/fd", p_pid}.CStr()};
    if (!directory)
    {
      links_hidden_ = true;
      p_sample.flags_ = p_sample.flags_ | Flags::DescriptorsHidden;
      return;
    }
    std::uint64_t open = 0;
    std::uint64_t sockets = 0;
    std::array<char, 64> link{};
    while (const auto entry = directory.Next())
    {
      const auto fd = ParseNumber<std::uint32_t>(*entry);
      if (!fd)
      {
        continue;
      }
      ++open;
      if (links_hidden_ || open > kMaxDescriptorLinks)
      {
        continue;
      }
      // entry views a NUL-terminated name, so data() is a C string.
      const auto length =
          ::readlinkat(directory.Fd(), entry->data(), link.data(), link.size());
      if (length < 0)
      {
        // EACCES/EPERM: not dumpable or another user. ENOENT: closed since
        // readdir.
        links_hidden_ = errno == EACCES || errno == EPERM;
        continue;
      }
      const std::string_view target{link.data(),
                                    static_cast<std::size_t>(length)};
      if (target.starts_with("socket:[") && target.ends_with(']'))
      {
        if (const auto inode =
                ParseNumber<std::uint64_t>(target.substr(8, target.size() - 9)))
        {
          ++sockets;
          // Within capacity: at most kMaxDescriptorLinks links are read.
          socket_fds_.push_back({*inode, *fd});
        }
      }
    }
    // Sort for binary search by inode. A socket open on several
    // descriptors keeps the lowest one.
    std::ranges::sort(socket_fds_, {},
                      [](const SocketFd& p_entry)
                      {
                        return std::pair{p_entry.inode_, p_entry.fd_};
                      });
    const auto duplicates =
        std::ranges::unique(socket_fds_, {}, &SocketFd::inode_);
    socket_fds_.erase(duplicates.begin(), duplicates.end());
    summary[Field("fd_open")] = open;
    if (links_hidden_)
    {
      p_sample.flags_ = p_sample.flags_ | Flags::DescriptorsHidden;
      return;
    }
    if (open > kMaxDescriptorLinks)
    {
      p_sample.flags_ = p_sample.flags_ | Flags::DescriptorScanTruncated;
      return;
    }
    summary[Field("fd_sockets")] = sockets;
  }

  void ReadProcessMemory(int p_pid, ResourceSample& p_sample)
  {
    const auto text = Read(FixedString{"/proc/{}/status", p_pid}.CStr());
    if (!text)
    {
      return;
    }
    for (const auto& [key, field] :
         {std::pair{"VmRSS", Field("rss_bytes")},
          std::pair{"RssAnon", Field("rss_anon_bytes")},
          std::pair{"RssFile", Field("rss_file_bytes")},
          std::pair{"RssShmem", Field("rss_shmem_bytes")},
          std::pair{"VmHWM", Field("rss_peak_bytes")},
          std::pair{"VmSwap", Field("swap_bytes")}})
    {
      p_sample.summary_[field] =
          FindKilobytes(*text, key).value_or(resource_wire::kUnavailable);
    }
  }

  // The target's own cgroup (ancestors' limits are not followed): memory
  // use and limits, OOM kills, CPU quota and throttling, process count.
  void ReadCgroupLimits(ResourceSample& p_sample)
  {
    if (p_sample.cgroup_.empty())
    {
      return;
    }
    auto& summary = p_sample.summary_;
    const auto path = [&](std::string_view p_file)
    {
      return FixedString{"/sys/fs/cgroup{}/{}", p_sample.cgroup_, p_file};
    };
    const auto number = [&](std::string_view p_file, std::size_t p_field)
    {
      if (const auto text = Read(path(p_file).CStr()))
      {
        summary[p_field] =
            ParseCgroupNumber(*text).value_or(resource_wire::kUnavailable);
      }
    };
    number("memory.current", Field("cgroup_memory_current"));
    number("memory.max", Field("cgroup_memory_max"));
    number("memory.high", Field("cgroup_memory_high"));
    number("pids.current", Field("cgroup_pids_current"));
    number("pids.max", Field("cgroup_pids_max"));
    if (const auto text = Read(path("memory.events").CStr()))
    {
      summary[Field("cgroup_memory_max_events")] =
          FindKeyValue(*text, "max").value_or(resource_wire::kUnavailable);
      summary[Field("cgroup_memory_oom_kill")] =
          FindKeyValue(*text, "oom_kill").value_or(resource_wire::kUnavailable);
    }
    if (const auto text = Read(path("cpu.max").CStr()).and_then(ParseCpuMax))
    {
      summary[Field("cgroup_cpu_period_us")] = text->period_us_;
      summary[Field("cgroup_cpu_quota_us")] =
          text->quota_us_.value_or(resource_wire::kUnavailable);
    }
    if (const auto text = Read(path("cpu.stat").CStr()))
    {
      for (const auto& [key, field] :
           {std::pair{"nr_periods", Field("cgroup_cpu_nr_periods")},
            std::pair{"nr_throttled", Field("cgroup_cpu_nr_throttled")},
            std::pair{"throttled_usec", Field("cgroup_cpu_throttled_usec")}})
      {
        summary[field] =
            FindKeyValue(*text, key).value_or(resource_wire::kUnavailable);
      }
    }
  }

  void ReadProcessIo(int p_pid, ResourceSample& p_sample)
  {
    const auto text = Read(FixedString{"/proc/{}/io", p_pid}.CStr());
    if (!text)
    {
      return;
    }
    constexpr std::array<std::pair<std::string_view, std::size_t>, 7> kKeys{
        {{"rchar", Field("io_rchar")},
         {"wchar", Field("io_wchar")},
         {"syscr", Field("io_syscr")},
         {"syscw", Field("io_syscw")},
         {"read_bytes", Field("io_read_bytes")},
         {"write_bytes", Field("io_write_bytes")},
         {"cancelled_write_bytes", Field("io_cancelled_write_bytes")}}};
    for (const auto& [key, field] : kKeys)
    {
      p_sample.summary_[field] =
          FindKeyValue(*text, key).value_or(resource_wire::kUnavailable);
    }
  }

  // nullopt when either namespace link is unreadable; the inode match then
  // decides (sockets of another namespace simply never match).
  [[nodiscard]] static std::optional<bool> SameNetworkNamespace(int p_pid)
  {
    std::array<char, 64> own{};
    std::array<char, 64> target{};
    const auto own_length =
        ::readlink("/proc/self/ns/net", own.data(), own.size());
    const auto target_length =
        ::readlink(FixedString{"/proc/{}/ns/net", p_pid}.CStr(), target.data(),
                   target.size());
    if (own_length <= 0 || target_length <= 0)
    {
      return std::nullopt;
    }
    return std::string_view{own.data(), static_cast<std::size_t>(own_length)} ==
           std::string_view{target.data(),
                            static_cast<std::size_t>(target_length)};
  }

  void ReadSockets(ResourceSample& p_sample)
  {
    if (links_hidden_ ||
        p_sample.summary_[Field("fd_sockets")] == resource_wire::kUnavailable)
    {
      return;
    }
    // Count into a copy, so a failed dump leaves the totals unavailable.
    auto totals = p_sample.summary_;
    ClearSocketTotals(totals);
    std::uint64_t matched = 0;
    fullest_.Clear();
    if (!socket_fds_.empty())
    {
      if (!diag_)
      {
        auto opened = SocketDiag::Open(diag_buffer_);
        if (!opened)
        {
          Fail(p_sample, "open", opened.error());
          return;
        }
        diag_.emplace(std::move(*opened));
      }
      const auto keep = [&](resource_wire::Socket p_socket)
      {
        const auto found = std::ranges::lower_bound(
            socket_fds_, p_socket.inode_, {}, &SocketFd::inode_);
        if (found != socket_fds_.end() && found->inode_ == p_socket.inode_)
        {
          p_socket.fd_ = found->fd_;
          ++matched;
          CountSocket(totals, p_socket);
          fullest_.Add(p_socket);
        }
      };
      for (const auto& [family, protocol] :
           {std::pair{AF_INET, IPPROTO_TCP}, std::pair{AF_INET6, IPPROTO_TCP},
            std::pair{AF_INET, IPPROTO_UDP}, std::pair{AF_INET6, IPPROTO_UDP}})
      {
        if (auto dumped =
                diag_->DumpInet(static_cast<std::uint8_t>(family),
                                static_cast<std::uint8_t>(protocol), keep);
            !dumped)
        {
          // EAFNOSUPPORT/ENOENT: no IPv6 or no UDP diag module; nothing of
          // that kind exists to list.
          if (dumped.error() != EAFNOSUPPORT && dumped.error() != ENOENT)
          {
            Fail(p_sample, "inet dump", dumped.error());
            return;
          }
        }
      }
      if (auto dumped = diag_->DumpUnix(keep);
          !dumped && dumped.error() != ENOENT)
      {
        Fail(p_sample, "unix dump", dumped.error());
        return;
      }
    }
    totals[Field("sockets_matched")] = matched;
    totals[Field("sockets_unmatched")] =
        socket_fds_.size() -
        std::min<std::uint64_t>(socket_fds_.size(), matched);
    p_sample.summary_ = totals;
    p_sample.sockets_ = fullest_.Sorted();
    if (fullest_.Truncated())
    {
      p_sample.flags_ = p_sample.flags_ | Flags::SocketsTruncated;
    }
  }

  void Fail(ResourceSample& p_sample, std::string_view p_step, int p_error)
  {
    diag_.reset();  // reopen next time, in case the socket is the problem
    p_sample.flags_ = p_sample.flags_ | Flags::SocketDiagFailed;
    logger_.Warn("sock_diag {} failed: {}; socket queues omitted", p_step,
                 std::strerror(p_error));
  }

  // Socket totals and TCP state counts start at zero.
  static void ClearSocketTotals(resource_wire::SummaryValues& p_summary)
  {
    for (const auto field :
         {Field("tcp_sockets"), Field("tcp_listeners"), Field("tcp_rx_queue"),
          Field("tcp_tx_queue"), Field("tcp_drops"), Field("udp_sockets"),
          Field("udp_rx_queue"), Field("udp_tx_queue"), Field("udp_drops"),
          Field("unix_sockets"), Field("unix_listeners"),
          Field("unix_rx_queue"), Field("unix_tx_queue"), Field("unix_drops")})
    {
      p_summary[field] = 0;
    }
    for (std::size_t field = kTcpStates; field <= kTcpStates + 9; ++field)
    {
      p_summary[field] = 0;
    }
  }

  // Adds one matched socket to the totals and TCP state counts.
  static void CountSocket(resource_wire::SummaryValues& p_summary,
                          const resource_wire::Socket& p_socket)
  {
    using resource_wire::SocketKind;
    // Each kind's fields start with its socket count; UDP has no listeners.
    static_assert(Field("tcp_drops") == Field("tcp_sockets") + 4);
    static_assert(Field("udp_drops") == Field("udp_sockets") + 3);
    static_assert(Field("unix_drops") == Field("unix_sockets") + 4);
    constexpr std::array<std::size_t, 3> kFirst{
        Field("tcp_sockets"), Field("udp_sockets"), Field("unix_sockets")};
    const bool tcp = p_socket.kind_ == SocketKind::Tcp4 ||
                     p_socket.kind_ == SocketKind::Tcp6;
    const bool udp = p_socket.kind_ == SocketKind::Udp4 ||
                     p_socket.kind_ == SocketKind::Udp6;
    const auto first = kFirst[tcp ? 0 : udp ? 1 : 2];
    const bool listener =
        p_socket.state_ == std::to_underlying(SocketState::Listen);
    // UDP has no listeners field: its fields after "sockets" are queues.
    ++p_summary[first];
    const auto queues = udp ? first + 1 : first + 2;
    if (listener && !udp)
    {
      ++p_summary[first + 1];
    }
    else
    {
      p_summary[queues] += p_socket.rx_queue_;
      p_summary[queues + 1] += p_socket.tx_queue_;
    }
    p_summary[queues + 2] += p_socket.drops_;
    // States 1..11 without TIME_WAIT (6), which no descriptor owns.
    if (tcp && p_socket.state_ >= 1 && p_socket.state_ <= 11 &&
        p_socket.state_ != std::to_underlying(SocketState::TimeWait))
    {
      const auto offset =
          p_socket.state_ < 6 ? p_socket.state_ - 1 : p_socket.state_ - 2;
      ++p_summary[kTcpStates + static_cast<std::size_t>(offset)];
    }
  }

  // Socket memory sysctls. tcp_mem and udp_mem are host-wide; the others
  // belong to the sampler's network namespace, which is the target's here.
  void ReadSocketLimits(ResourceSample& p_sample)
  {
    auto& summary = p_sample.summary_;
    for (const auto& [path, first] :
         {std::pair{"/proc/sys/net/ipv4/tcp_mem", Field("tcp_mem_low")},
          std::pair{"/proc/sys/net/ipv4/udp_mem", Field("udp_mem_low")}})
    {
      if (const auto values = Read(path).and_then(ParseTriple))
      {
        std::ranges::copy(*values, summary.begin() + static_cast<long>(first));
      }
    }
    for (const auto& [path, field] :
         {std::pair{"/proc/sys/net/core/rmem_max", Field("rmem_max")},
          std::pair{"/proc/sys/net/core/wmem_max", Field("wmem_max")},
          std::pair{"/proc/sys/net/core/somaxconn", Field("somaxconn")}})
    {
      if (const auto text = Read(path))
      {
        summary[field] = ParseNumber<std::uint64_t>(Trim(*text))
                             .value_or(resource_wire::kUnavailable);
      }
    }
    if (const auto page = ::sysconf(_SC_PAGESIZE); page > 0)
    {
      summary[Field("page_size")] = static_cast<std::uint64_t>(page);
    }
  }

  // Counters of the target's network namespace, through /proc/PID/net, so
  // they are right even when the target is in a container.
  void ReadNamespaceCounters(int p_pid, ResourceSample& p_sample)
  {
    auto& summary = p_sample.summary_;
    struct Counter
    {
      std::string_view section_;
      std::string_view name_;
      std::size_t field_;
    };
    constexpr std::array<Counter, 16> kSnmp{{
        {"Tcp", "ActiveOpens", Field("net_tcp_active_opens")},
        {"Tcp", "PassiveOpens", Field("net_tcp_passive_opens")},
        {"Tcp", "AttemptFails", Field("net_tcp_attempt_fails")},
        {"Tcp", "EstabResets", Field("net_tcp_estab_resets")},
        {"Tcp", "InSegs", Field("net_tcp_in_segs")},
        {"Tcp", "OutSegs", Field("net_tcp_out_segs")},
        {"Tcp", "RetransSegs", Field("net_tcp_retrans_segs")},
        {"Tcp", "InErrs", Field("net_tcp_in_errs")},
        {"Tcp", "OutRsts", Field("net_tcp_out_rsts")},
        {"Udp", "InDatagrams", Field("net_udp_in_datagrams")},
        {"Udp", "NoPorts", Field("net_udp_no_ports")},
        {"Udp", "InErrors", Field("net_udp_in_errors")},
        {"Udp", "OutDatagrams", Field("net_udp_out_datagrams")},
        {"Udp", "RcvbufErrors", Field("net_udp_rcvbuf_errors")},
        {"Udp", "SndbufErrors", Field("net_udp_sndbuf_errors")},
        {"Udp", "MemErrors", Field("net_udp_mem_errors")},
    }};
    constexpr std::array<Counter, 14> kNetstat{{
        {"TcpExt", "ListenOverflows", Field("net_listen_overflows")},
        {"TcpExt", "ListenDrops", Field("net_listen_drops")},
        {"TcpExt", "TCPBacklogDrop", Field("net_tcp_backlog_drop")},
        {"TcpExt", "TCPRcvQDrop", Field("net_tcp_rcvq_drop")},
        {"TcpExt", "TCPZeroWindowDrop", Field("net_tcp_zero_window_drop")},
        {"TcpExt", "PruneCalled", Field("net_prune_called")},
        {"TcpExt", "RcvPruned", Field("net_rcv_pruned")},
        {"TcpExt", "OfoPruned", Field("net_ofo_pruned")},
        {"TcpExt", "TCPTimeouts", Field("net_tcp_timeouts")},
        {"TcpExt", "TCPAbortOnMemory", Field("net_tcp_abort_on_memory")},
        {"TcpExt", "TCPAbortOnTimeout", Field("net_tcp_abort_on_timeout")},
        {"TcpExt", "TCPMemoryPressures", Field("net_tcp_memory_pressures")},
        {"TcpExt", "TCPReqQFullDrop", Field("net_tcp_req_q_full_drop")},
        {"TcpExt", "SyncookiesSent", Field("net_syncookies_sent")},
    }};
    if (const auto text = Read(FixedString{"/proc/{}/net/snmp", p_pid}.CStr()))
    {
      for (const auto& counter : kSnmp)
      {
        summary[counter.field_] =
            FindTableCounter(*text, counter.section_, counter.name_)
                .value_or(resource_wire::kUnavailable);
      }
    }
    // IPv6 UDP counters are separate; add them to IPv4's. A host without
    // IPv6 has no file, and IPv4 alone is the whole count.
    if (const auto text = Read(FixedString{"/proc/{}/net/snmp6", p_pid}.CStr()))
    {
      for (const auto& counter : kSnmp)
      {
        if (counter.section_ != "Udp")
        {
          continue;
        }
        const auto ipv6 =
            FindKeyValue(*text, FixedString{"Udp6{}", counter.name_}.View());
        auto& value = summary[counter.field_];
        if (ipv6 && value != resource_wire::kUnavailable)
        {
          value += *ipv6;
        }
      }
    }
    if (const auto text =
            Read(FixedString{"/proc/{}/net/netstat", p_pid}.CStr()))
    {
      for (const auto& counter : kNetstat)
      {
        summary[counter.field_] =
            FindTableCounter(*text, counter.section_, counter.name_)
                .value_or(resource_wire::kUnavailable);
      }
    }
    if (const auto text = Read(FixedString{"/proc/{}/net/dev", p_pid}.CStr())
                              .and_then(ParseNetDev))
    {
      summary[Field("net_if_rx_errors")] = text->rx_errors_;
      summary[Field("net_if_rx_dropped")] = text->rx_dropped_;
      summary[Field("net_if_tx_errors")] = text->tx_errors_;
      summary[Field("net_if_tx_dropped")] = text->tx_dropped_;
    }
    if (const auto text =
            Read(FixedString{"/proc/{}/net/sockstat", p_pid}.CStr()))
    {
      for (const auto& [protocol, name, field] :
           {std::tuple{"TCP", "inuse", Field("sockstat_tcp_inuse")},
            std::tuple{"TCP", "orphan", Field("sockstat_tcp_orphan")},
            std::tuple{"TCP", "tw", Field("sockstat_tcp_tw")},
            std::tuple{"TCP", "alloc", Field("sockstat_tcp_alloc")},
            std::tuple{"TCP", "mem", Field("sockstat_tcp_mem")},
            std::tuple{"UDP", "inuse", Field("sockstat_udp_inuse")},
            std::tuple{"UDP", "mem", Field("sockstat_udp_mem")}})
      {
        summary[field] = FindSockstat(*text, protocol, name)
                             .value_or(resource_wire::kUnavailable);
      }
    }
  }

  std::array<char, 32768> buffer_{};
  FixedString cgroup_{""};
  std::vector<std::byte> diag_buffer_;
  std::optional<SocketDiag> diag_;
  RateLimitedLogger logger_;
  // Sorted by inode. Capacity is reserved at startup and never exceeded.
  std::vector<SocketFd> socket_fds_;
  FullestSockets fullest_;
  bool links_hidden_ = false;
};

}  // namespace triangulator
