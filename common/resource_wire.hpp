#pragma once

// The resource datagram format ("TRES"), shared by the sampler and the
// collector. Thread ticks ("TMON", wire.hpp) describe threads; these describe
// what the threads share: pressure on the host and the target's cgroup,
// descriptor headroom, process storage I/O, the target's socket queues and
// buffers, and its network namespace's drop and overflow counters. They are
// sampled at a slower rate and use their own format, so neither format's
// fields are repurposed. This header depends only on the standard library.
//
// One sample is up to kMaxParts datagrams that share a header: part 0 holds
// the summary (kSummaryFields values and the cgroup path) and parts 1.. hold
// up to kSocketsPerPart of the target's fullest sockets each.

#include <algorithm>
#include <array>
#include <bit>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <limits>
#include <span>
#include <string_view>
#include <utility>
#include <vector>

#include "wire.hpp"

namespace triangulator::resource_wire
{

inline constexpr std::uint8_t kVersion = 1;
inline constexpr std::size_t kHeaderSize = 64;
inline constexpr std::size_t kCgroupSize = 128;
inline constexpr std::size_t kSocketSize = 160;
inline constexpr std::size_t kSocketsPerPart = 6;
inline constexpr std::size_t kMaxSockets = 24;
inline constexpr std::size_t kMaxParts = 1 + kMaxSockets / kSocketsPerPart;
// A value the sampler could not read. Never a real reading: counters this
// large would take centuries to reach, and limits this large mean unlimited,
// which has no headroom to report either.
inline constexpr std::uint64_t kUnavailable =
    std::numeric_limits<std::uint64_t>::max();

// Summary values, in wire order. Each is a u64; kUnavailable when unknown.
// Units: PSI avg10 in hundredths of a percent, PSI totals in microseconds,
// queues and memory in bytes, sockstat memory and tcp_mem/udp_mem in pages,
// everything else a count. "net_" counters are cumulative for the target's
// network namespace; the others are current values.
inline constexpr std::array<std::string_view, 130> kSummaryFields{
    // Pressure stall information, /proc/pressure and the cgroup's files.
    "host_cpu_some_avg10", "host_cpu_some_total", "host_cpu_full_avg10",
    "host_cpu_full_total", "host_memory_some_avg10", "host_memory_some_total",
    "host_memory_full_avg10", "host_memory_full_total", "host_io_some_avg10",
    "host_io_some_total", "host_io_full_avg10", "host_io_full_total",
    "cgroup_cpu_some_avg10", "cgroup_cpu_some_total", "cgroup_cpu_full_avg10",
    "cgroup_cpu_full_total", "cgroup_memory_some_avg10",
    "cgroup_memory_some_total", "cgroup_memory_full_avg10",
    "cgroup_memory_full_total", "cgroup_io_some_avg10", "cgroup_io_some_total",
    "cgroup_io_full_avg10", "cgroup_io_full_total",
    // Descriptors: /proc/PID/fd and /proc/PID/limits.
    "fd_open", "fd_soft_limit", "fd_hard_limit", "fd_sockets",
    // Process-wide I/O, /proc/PID/io.
    "io_rchar", "io_wchar", "io_syscr", "io_syscw", "io_read_bytes",
    "io_write_bytes", "io_cancelled_write_bytes",
    // The target's own sockets, from sock_diag. Queues exclude listeners,
    // whose "queue" is the accept backlog.
    "tcp_sockets", "tcp_listeners", "tcp_rx_queue", "tcp_tx_queue", "tcp_drops",
    "udp_sockets", "udp_rx_queue", "udp_tx_queue", "udp_drops", "unix_sockets",
    "unix_listeners", "unix_rx_queue", "unix_tx_queue", "unix_drops",
    "sockets_matched", "sockets_unmatched",
    // TCP state counts of the target's sockets.
    "tcp_established", "tcp_syn_sent", "tcp_syn_recv", "tcp_fin_wait1",
    "tcp_fin_wait2", "tcp_close", "tcp_close_wait", "tcp_last_ack",
    "tcp_listen", "tcp_closing",
    // Namespace counters: /proc/PID/net/{snmp,snmp6,netstat}. UDP sums
    // IPv4 and IPv6.
    "net_tcp_active_opens", "net_tcp_passive_opens", "net_tcp_attempt_fails",
    "net_tcp_estab_resets", "net_tcp_in_segs", "net_tcp_out_segs",
    "net_tcp_retrans_segs", "net_tcp_in_errs", "net_tcp_out_rsts",
    "net_listen_overflows", "net_listen_drops", "net_tcp_backlog_drop",
    "net_tcp_rcvq_drop", "net_tcp_zero_window_drop", "net_prune_called",
    "net_rcv_pruned", "net_ofo_pruned", "net_tcp_timeouts",
    "net_tcp_abort_on_memory", "net_tcp_abort_on_timeout",
    "net_tcp_memory_pressures", "net_tcp_req_q_full_drop",
    "net_syncookies_sent", "net_udp_in_datagrams", "net_udp_no_ports",
    "net_udp_in_errors", "net_udp_out_datagrams", "net_udp_rcvbuf_errors",
    "net_udp_sndbuf_errors", "net_udp_mem_errors",
    // /proc/PID/net/sockstat: the namespace's socket counts and memory.
    "sockstat_tcp_inuse", "sockstat_tcp_orphan", "sockstat_tcp_tw",
    "sockstat_tcp_alloc", "sockstat_tcp_mem", "sockstat_udp_inuse",
    "sockstat_udp_mem",
    // Socket memory limits (sysctls).
    "tcp_mem_low", "tcp_mem_pressure", "tcp_mem_high", "udp_mem_low",
    "udp_mem_pressure", "udp_mem_high", "rmem_max", "wmem_max", "somaxconn",
    "page_size",
    // Process memory, /proc/PID/status, in bytes. rss = anon + file + shmem.
    // The peak is the high-water mark since the process started.
    "rss_bytes", "rss_anon_bytes", "rss_file_bytes", "rss_shmem_bytes",
    "rss_peak_bytes", "swap_bytes",
    // The target's own cgroup v2 files: memory.current/max/high/events,
    // cpu.max, cpu.stat, pids.current/max. Unlimited ("max") is unavailable.
    "cgroup_memory_current", "cgroup_memory_max", "cgroup_memory_high",
    "cgroup_memory_max_events", "cgroup_memory_oom_kill", "cgroup_cpu_quota_us",
    "cgroup_cpu_period_us", "cgroup_cpu_nr_periods", "cgroup_cpu_nr_throttled",
    "cgroup_cpu_throttled_usec", "cgroup_pids_current", "cgroup_pids_max",
    // Interface counters, /proc/PID/net/dev, summed over every interface in
    // the namespace except lo.
    "net_if_rx_errors", "net_if_rx_dropped", "net_if_tx_errors",
    "net_if_tx_dropped"};

using SummaryValues = std::array<std::uint64_t, kSummaryFields.size()>;

// Index of a summary field. consteval, so a misspelt name fails to compile.
consteval std::size_t Field(std::string_view p_name)
{
  for (std::size_t index = 0; index < kSummaryFields.size(); ++index)
  {
    if (kSummaryFields[index] == p_name)
    {
      return index;
    }
  }
  throw "unknown resource summary field";
}

[[nodiscard]] inline SummaryValues EmptySummary() noexcept
{
  SummaryValues summary;
  summary.fill(kUnavailable);
  return summary;
}

inline constexpr std::size_t kSummaryPartSize =
    kHeaderSize + kSummaryFields.size() * 8 + kCgroupSize;
inline constexpr std::size_t kMaxPartSize =
    std::max(kSummaryPartSize, kHeaderSize + kSocketsPerPart * kSocketSize);
static_assert(kSummaryPartSize == 1232);
// Fits an unfragmented UDP datagram on a 1,500-byte Ethernet MTU, and is the
// size the collector's receive buffer must exceed.
static_assert(kMaxPartSize <= 1400);

enum class PartKind : std::uint8_t
{
  Summary = 1,
  Sockets = 2
};

// Why some values are missing. Missing values are kUnavailable whatever the
// reason; these say why, so the dashboard can explain it.
enum class Flags : std::uint32_t
{
  None = 0,
  // The target uses another network namespace: its sockets are not in the
  // sampler's sock_diag view, so none are listed.
  OtherNetworkNamespace = 1,
  // The descriptor links are unreadable (another user, or a process that
  // is not dumpable), so sockets cannot be matched to the target.
  DescriptorsHidden = 2,
  // The target has more descriptors than the sampler inspects.
  DescriptorScanTruncated = 4,
  SocketDiagFailed = 8,
  // The target has more sockets than kMaxSockets; only the fullest are sent.
  SocketsTruncated = 16
};
inline constexpr std::uint32_t kKnownFlags = 31;

[[nodiscard]] constexpr Flags operator|(Flags p_left, Flags p_right) noexcept
{
  return static_cast<Flags>(std::to_underlying(p_left) |
                            std::to_underlying(p_right));
}
[[nodiscard]] constexpr bool HasFlag(Flags p_flags, Flags p_flag) noexcept
{
  return (std::to_underlying(p_flags) & std::to_underlying(p_flag)) != 0;
}

enum class SocketKind : std::uint8_t
{
  Tcp4 = 1,
  Tcp6,
  Udp4,
  Udp6,
  UnixStream,
  UnixDatagram,
  UnixSeqpacket
};
inline constexpr std::uint8_t kMaxSocketKind = 7;

[[nodiscard]] constexpr bool IsUnix(SocketKind p_kind) noexcept
{
  return p_kind >= SocketKind::UnixStream;
}

// Which optional parts of a socket row the kernel supplied.
enum class SocketFlags : std::uint16_t
{
  None = 0,
  Memory = 1,      // rmem_alloc .. drops (SO_MEMINFO)
  TcpInfo = 2,     // rtt .. last_data_sent_ms
  TcpLimited = 4,  // busy, rwnd_limited and sndbuf_limited times (4.10+)
  PeerWindow = 8   // peer_window (Linux 6.2+)
};
inline constexpr std::uint16_t kKnownSocketFlags = 15;

[[nodiscard]] constexpr bool HasFlag(std::uint16_t p_flags,
                                     SocketFlags p_flag) noexcept
{
  return (p_flags & std::to_underlying(p_flag)) != 0;
}

// One of the target's sockets, as it is on the wire (see the wire structs
// in wire.hpp). Addresses are in network byte order: IPv4 uses the first
// four bytes. A unix socket has no addresses; its path (abstract names
// start with '@'), NUL-padded and truncated to 32 bytes, uses the same 32
// bytes (UnixPath).
struct Socket
{
  SocketKind kind_{};
  std::uint8_t state_{};  // Linux TCP_* numbering, also used for unix/UDP
  std::uint16_t flags_{};
  std::uint32_t fd_{};
  std::uint64_t inode_{};
  std::array<std::uint8_t, 16> local_address_{};
  std::array<std::uint8_t, 16> remote_address_{};
  std::uint16_t local_port_{};
  std::uint16_t remote_port_{};
  // Bytes waiting to be read and not yet sent or acknowledged. For a
  // listener: connections waiting for accept() and the backlog limit.
  std::uint32_t rx_queue_{};
  std::uint32_t tx_queue_{};
  std::uint32_t rmem_alloc_{};
  std::uint32_t rcvbuf_{};
  std::uint32_t wmem_alloc_{};
  std::uint32_t wmem_queued_{};
  std::uint32_t sndbuf_{};
  std::uint32_t drops_{};
  std::uint32_t rtt_us_{};
  std::uint32_t rttvar_us_{};
  std::uint32_t total_retrans_{};
  std::uint32_t unacked_{};
  std::uint32_t lost_{};
  std::uint32_t notsent_bytes_{};
  std::uint32_t peer_window_{};
  std::uint8_t retransmits_{};
  std::uint8_t probes_{};
  std::uint8_t backoff_{};
  std::uint8_t ca_state_{};
  std::uint32_t last_data_recv_ms_{};
  std::uint32_t last_data_sent_ms_{};
  std::array<std::uint8_t, 4> reserved_{};  // zero
  std::uint64_t busy_us_{};
  std::uint64_t rwnd_limited_us_{};
  std::uint64_t sndbuf_limited_us_{};
  std::array<std::uint8_t, 8> reserved_end_{};  // zero

  using UnixPathBytes = std::array<char, 32>;
  using AddressPair = std::array<std::array<std::uint8_t, 16>, 2>;
  [[nodiscard]] UnixPathBytes UnixPath() const noexcept
  {
    return std::bit_cast<UnixPathBytes>(
        AddressPair{local_address_, remote_address_});
  }
  void SetUnixPath(const UnixPathBytes& p_path) noexcept
  {
    const auto addresses = std::bit_cast<AddressPair>(p_path);
    local_address_ = addresses[0];
    remote_address_ = addresses[1];
  }

  bool operator==(const Socket&) const = default;
};
static_assert(wire::WireStruct<Socket> && sizeof(Socket) == kSocketSize);
static_assert(offsetof(Socket, local_address_) == 16 &&
              offsetof(Socket, local_port_) == 48 &&
              offsetof(Socket, retransmits_) == 112 &&
              offsetof(Socket, busy_us_) == 128);

inline constexpr std::array<char, 4> kMagic{'T', 'R', 'E', 'S'};

struct Header
{
  std::array<char, 4> magic_ = kMagic;
  std::uint8_t version_ = kVersion;
  PartKind kind_{};
  std::uint8_t part_{};
  std::uint8_t parts_{};
  // The thread ticks' session, so the two streams can be matched.
  std::uint64_t session_{};
  std::uint32_t sequence_{};
  std::uint16_t count_{};  // summary values or socket rows in this part
  std::array<std::uint8_t, 2> reserved_{};  // zero
  std::uint64_t monotonic_ns_{};
  std::uint64_t wall_ns_{};
  std::uint32_t interval_ms_{};
  std::uint32_t pid_{};
  std::uint64_t process_start_{};  // /proc/PID/stat starttime, clock ticks
  Flags flags_{};
  std::array<std::uint8_t, 4> reserved_end_{};  // zero

  // Every part of one sample carries the same header apart from these.
  [[nodiscard]] bool SameSample(const Header& p_other) const noexcept
  {
    return parts_ == p_other.parts_ && session_ == p_other.session_ &&
           sequence_ == p_other.sequence_ &&
           monotonic_ns_ == p_other.monotonic_ns_ &&
           wall_ns_ == p_other.wall_ns_ &&
           interval_ms_ == p_other.interval_ms_ && pid_ == p_other.pid_ &&
           process_start_ == p_other.process_start_ && flags_ == p_other.flags_;
  }
};
static_assert(wire::WireStruct<Header> && sizeof(Header) == kHeaderSize);
static_assert(offsetof(Header, session_) == 8 &&
              offsetof(Header, count_) == 20 &&
              offsetof(Header, monotonic_ns_) == 24 &&
              offsetof(Header, flags_) == 56);

// Part 0 of a sample.
struct SummaryPart
{
  Header header_;
  SummaryValues values_{};
  std::array<char, kCgroupSize> cgroup_{};  // NUL-terminated
};
static_assert(wire::WireStruct<SummaryPart> &&
              sizeof(SummaryPart) == kSummaryPartSize);

// Parts 1..: the header, then header_.count_ socket rows.
struct SocketsPart
{
  Header header_;
  std::array<Socket, kSocketsPerPart> sockets_{};
};
static_assert(wire::WireStruct<SocketsPart> &&
              sizeof(SocketsPart) ==
                  kHeaderSize + kSocketsPerPart * kSocketSize);

// Number of datagrams for a sample with p_sockets socket rows.
[[nodiscard]] constexpr std::uint8_t PartCount(std::size_t p_sockets) noexcept
{
  return static_cast<std::uint8_t>(
      1 + (std::min(p_sockets, kMaxSockets) + kSocketsPerPart - 1) /
              kSocketsPerPart);
}

// Writes the summary part into p_buffer and returns its length.
[[nodiscard]] inline std::size_t EncodeSummary(
    std::span<std::byte, kMaxPartSize> p_buffer, Header p_header,
    const SummaryValues& p_summary, std::string_view p_cgroup)
{
  p_header.kind_ = PartKind::Summary;
  p_header.part_ = 0;
  p_header.count_ = static_cast<std::uint16_t>(p_summary.size());
  SummaryPart part{.header_ = p_header, .values_ = p_summary};
  std::memcpy(part.cgroup_.data(), p_cgroup.data(),
              std::min(p_cgroup.size(), kCgroupSize - 1));
  std::ranges::copy(wire::AsBytes(part), p_buffer.begin());
  return sizeof(part);
}

// Writes sockets part p_part (1-based) of p_sockets into p_buffer and
// returns its length.
[[nodiscard]] inline std::size_t EncodeSockets(
    std::span<std::byte, kMaxPartSize> p_buffer, Header p_header,
    std::span<const Socket> p_sockets, std::uint8_t p_part)
{
  const auto first = (p_part - std::size_t{1}) * kSocketsPerPart;
  const auto rows = std::min(kSocketsPerPart, p_sockets.size() - first);
  p_header.kind_ = PartKind::Sockets;
  p_header.part_ = p_part;
  p_header.count_ = static_cast<std::uint16_t>(rows);
  SocketsPart part{.header_ = p_header};
  std::ranges::copy(p_sockets.subspan(first, rows), part.sockets_.begin());
  const auto length = kHeaderSize + rows * kSocketSize;
  std::ranges::copy(wire::AsBytes(part).first(length), p_buffer.begin());
  return length;
}

// One decoded datagram. values_ and cgroup_ are set for the summary part,
// sockets_ for the others.
struct Part
{
  Header header_;
  SummaryValues values_{};
  std::array<char, kCgroupSize> cgroup_{};
  // The socket rows of this part: sockets_[0 .. socket_count_).
  std::array<Socket, kSocketsPerPart> sockets_{};
  std::size_t socket_count_ = 0;

  [[nodiscard]] std::span<const Socket> Sockets() const noexcept
  {
    return std::span{sockets_}.first(socket_count_);
  }
};

// Checks the format (length, magic, version, part numbering, reserved
// bytes) and that the identities and clocks are set. Whether the values
// make sense is up to the reader.
[[nodiscard]] inline std::expected<Part, std::string_view> Decode(
    std::span<const std::byte> p_data)
{
  if (p_data.size() < kHeaderSize || std::memcmp(p_data.data(), "TRES", 4) != 0)
  {
    return std::unexpected("not a resource datagram");
  }
  Part part;
  auto& header = part.header_;
  header = wire::FromBytes<Header>(p_data);
  if (header.version_ != kVersion)
  {
    return std::unexpected("unsupported resource protocol");
  }
  if ((std::to_underlying(header.flags_) & ~kKnownFlags) != 0 ||
      header.reserved_ != decltype(header.reserved_){} ||
      header.reserved_end_ != decltype(header.reserved_end_){} ||
      header.parts_ == 0 || header.parts_ > kMaxParts ||
      header.part_ >= header.parts_)
  {
    return std::unexpected("invalid resource header");
  }
  if (header.pid_ == 0 || header.monotonic_ns_ == 0 || header.wall_ns_ == 0 ||
      header.interval_ms_ < 1000 || header.interval_ms_ > 60000)
  {
    return std::unexpected("invalid resource sample identity or clock");
  }
  if (header.kind_ == PartKind::Summary)
  {
    if (header.part_ != 0 || header.count_ != kSummaryFields.size() ||
        p_data.size() != kSummaryPartSize)
    {
      return std::unexpected("invalid resource summary");
    }
    const auto summary = wire::FromBytes<SummaryPart>(p_data);
    part.values_ = summary.values_;
    part.cgroup_ = summary.cgroup_;
    if (part.cgroup_.back() != '\0')
    {
      return std::unexpected("invalid resource summary");
    }
    return part;
  }
  if (header.kind_ != PartKind::Sockets || header.part_ == 0 ||
      header.count_ == 0 || header.count_ > kSocketsPerPart ||
      p_data.size() != kHeaderSize + header.count_ * kSocketSize)
  {
    return std::unexpected("invalid resource socket part");
  }
  for (std::size_t row = 0; row < header.count_; ++row)
  {
    const auto socket = wire::FromBytes<Socket>(
        p_data.subspan(kHeaderSize + row * kSocketSize));
    const auto kind = std::to_underlying(socket.kind_);
    if (kind == 0 || kind > kMaxSocketKind ||
        (socket.flags_ & ~kKnownSocketFlags) != 0 ||
        socket.reserved_ != decltype(socket.reserved_){} ||
        socket.reserved_end_ != decltype(socket.reserved_end_){})
    {
      return std::unexpected("invalid socket row");
    }
    part.sockets_[part.socket_count_++] = socket;
  }
  return part;
}

}  // namespace triangulator::resource_wire
