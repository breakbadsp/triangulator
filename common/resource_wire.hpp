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

// One of the target's sockets. Addresses are in network byte order: IPv4
// uses the first four bytes. Unix sockets have a path instead (abstract
// names start with '@'), NUL-padded and truncated to 32 bytes.
struct Socket
{
  SocketKind kind_{};
  std::uint8_t state_{};  // Linux TCP_* numbering, also used for unix/UDP
  std::uint16_t flags_{};
  std::uint32_t fd_{};
  std::uint64_t inode_{};
  std::array<std::uint8_t, 16> local_address_{};
  std::array<std::uint8_t, 16> remote_address_{};
  std::array<char, 32> unix_path_{};
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
  std::uint64_t busy_us_{};
  std::uint64_t rwnd_limited_us_{};
  std::uint64_t sndbuf_limited_us_{};

  bool operator==(const Socket&) const = default;
};

struct Header
{
  PartKind kind_{};
  std::uint8_t part_{};
  std::uint8_t parts_{};
  // The thread ticks' session, so the two streams can be matched.
  std::uint64_t session_{};
  std::uint32_t sequence_{};
  std::uint16_t count_{};  // summary values or socket rows in this part
  std::uint64_t monotonic_ns_{};
  std::uint64_t wall_ns_{};
  std::uint32_t interval_ms_{};
  std::uint32_t pid_{};
  std::uint64_t process_start_{};  // /proc/PID/stat starttime, clock ticks
  Flags flags_{};

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

// Number of datagrams for a sample with p_sockets socket rows.
[[nodiscard]] constexpr std::uint8_t PartCount(std::size_t p_sockets) noexcept
{
  return static_cast<std::uint8_t>(
      1 + (std::min(p_sockets, kMaxSockets) + kSocketsPerPart - 1) /
              kSocketsPerPart);
}

inline void EncodeHeader(std::span<std::byte, kHeaderSize> p_buffer,
                         const Header& p_header)
{
  using wire::WriteLittleEndian;
  std::ranges::fill(p_buffer, std::byte{0});
  std::memcpy(p_buffer.data(), "TRES", 4);
  p_buffer[4] = std::byte{kVersion};
  p_buffer[5] = static_cast<std::byte>(p_header.kind_);
  p_buffer[6] = static_cast<std::byte>(p_header.part_);
  p_buffer[7] = static_cast<std::byte>(p_header.parts_);
  WriteLittleEndian(p_buffer.subspan<8, 8>(), p_header.session_);
  WriteLittleEndian(p_buffer.subspan<16, 4>(), p_header.sequence_);
  WriteLittleEndian(p_buffer.subspan<20, 2>(), p_header.count_);
  WriteLittleEndian(p_buffer.subspan<24, 8>(), p_header.monotonic_ns_);
  WriteLittleEndian(p_buffer.subspan<32, 8>(), p_header.wall_ns_);
  WriteLittleEndian(p_buffer.subspan<40, 4>(), p_header.interval_ms_);
  WriteLittleEndian(p_buffer.subspan<44, 4>(), p_header.pid_);
  WriteLittleEndian(p_buffer.subspan<48, 8>(), p_header.process_start_);
  WriteLittleEndian(p_buffer.subspan<56, 4>(),
                    std::to_underlying(p_header.flags_));
}

inline void EncodeSocket(std::span<std::byte, kSocketSize> p_buffer,
                         const Socket& p_socket)
{
  using wire::WriteLittleEndian;
  std::ranges::fill(p_buffer, std::byte{0});
  p_buffer[0] = static_cast<std::byte>(p_socket.kind_);
  p_buffer[1] = static_cast<std::byte>(p_socket.state_);
  WriteLittleEndian(p_buffer.subspan<2, 2>(), p_socket.flags_);
  WriteLittleEndian(p_buffer.subspan<4, 4>(), p_socket.fd_);
  WriteLittleEndian(p_buffer.subspan<8, 8>(), p_socket.inode_);
  if (IsUnix(p_socket.kind_))
  {
    std::memcpy(p_buffer.data() + 16, p_socket.unix_path_.data(), 32);
  }
  else
  {
    std::memcpy(p_buffer.data() + 16, p_socket.local_address_.data(), 16);
    std::memcpy(p_buffer.data() + 32, p_socket.remote_address_.data(), 16);
  }
  WriteLittleEndian(p_buffer.subspan<48, 2>(), p_socket.local_port_);
  WriteLittleEndian(p_buffer.subspan<50, 2>(), p_socket.remote_port_);
  const std::array<std::uint32_t, 15> quads{
      p_socket.rx_queue_,  p_socket.tx_queue_,      p_socket.rmem_alloc_,
      p_socket.rcvbuf_,    p_socket.wmem_alloc_,    p_socket.wmem_queued_,
      p_socket.sndbuf_,    p_socket.drops_,         p_socket.rtt_us_,
      p_socket.rttvar_us_, p_socket.total_retrans_, p_socket.unacked_,
      p_socket.lost_,      p_socket.notsent_bytes_, p_socket.peer_window_};
  for (std::size_t index = 0; index < quads.size(); ++index)
  {
    WriteLittleEndian(
        std::span<std::byte, 4>{p_buffer.data() + 52 + index * 4, 4},
        quads[index]);
  }
  p_buffer[112] = static_cast<std::byte>(p_socket.retransmits_);
  p_buffer[113] = static_cast<std::byte>(p_socket.probes_);
  p_buffer[114] = static_cast<std::byte>(p_socket.backoff_);
  p_buffer[115] = static_cast<std::byte>(p_socket.ca_state_);
  WriteLittleEndian(p_buffer.subspan<116, 4>(), p_socket.last_data_recv_ms_);
  WriteLittleEndian(p_buffer.subspan<120, 4>(), p_socket.last_data_sent_ms_);
  WriteLittleEndian(p_buffer.subspan<128, 8>(), p_socket.busy_us_);
  WriteLittleEndian(p_buffer.subspan<136, 8>(), p_socket.rwnd_limited_us_);
  WriteLittleEndian(p_buffer.subspan<144, 8>(), p_socket.sndbuf_limited_us_);
}

// Encodes the summary part into p_buffer and returns its length.
[[nodiscard]] inline std::size_t EncodeSummary(
    std::span<std::byte, kMaxPartSize> p_buffer, Header p_header,
    const SummaryValues& p_summary, std::string_view p_cgroup)
{
  p_header.kind_ = PartKind::Summary;
  p_header.part_ = 0;
  p_header.count_ = static_cast<std::uint16_t>(p_summary.size());
  EncodeHeader(p_buffer.first<kHeaderSize>(), p_header);
  for (std::size_t index = 0; index < p_summary.size(); ++index)
  {
    wire::WriteLittleEndian(
        std::span<std::byte, 8>{p_buffer.data() + kHeaderSize + index * 8, 8},
        p_summary[index]);
  }
  auto cgroup =
      p_buffer.subspan(kHeaderSize + p_summary.size() * 8, kCgroupSize);
  std::ranges::fill(cgroup, std::byte{0});
  std::memcpy(cgroup.data(), p_cgroup.data(),
              std::min(p_cgroup.size(), kCgroupSize - 1));
  return kSummaryPartSize;
}

// Encodes sockets part p_part (1-based) of p_sockets and returns its length.
[[nodiscard]] inline std::size_t EncodeSockets(
    std::span<std::byte, kMaxPartSize> p_buffer, Header p_header,
    std::span<const Socket> p_sockets, std::uint8_t p_part)
{
  const auto first = (p_part - std::size_t{1}) * kSocketsPerPart;
  const auto rows = std::min(kSocketsPerPart, p_sockets.size() - first);
  p_header.kind_ = PartKind::Sockets;
  p_header.part_ = p_part;
  p_header.count_ = static_cast<std::uint16_t>(rows);
  EncodeHeader(p_buffer.first<kHeaderSize>(), p_header);
  for (std::size_t row = 0; row < rows; ++row)
  {
    EncodeSocket(
        std::span<std::byte, kSocketSize>{
            p_buffer.data() + kHeaderSize + row * kSocketSize, kSocketSize},
        p_sockets[first + row]);
  }
  return kHeaderSize + rows * kSocketSize;
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

[[nodiscard]] inline bool AllZero(std::span<const std::byte> p_bytes) noexcept
{
  return std::ranges::all_of(p_bytes,
                             [](std::byte p_byte)
                             {
                               return p_byte == std::byte{0};
                             });
}

[[nodiscard]] inline std::expected<Socket, std::string_view> DecodeSocket(
    std::span<const std::byte, kSocketSize> p_buffer)
{
  using wire::ReadLittleEndian;
  Socket socket;
  const auto kind = std::to_integer<std::uint8_t>(p_buffer[0]);
  socket.flags_ = ReadLittleEndian<std::uint16_t>(p_buffer, 2);
  if (kind == 0 || kind > kMaxSocketKind ||
      (socket.flags_ & ~kKnownSocketFlags) != 0 ||
      !AllZero(p_buffer.subspan<124, 4>()) ||
      !AllZero(p_buffer.subspan<152, 8>()))
  {
    return std::unexpected("invalid socket row");
  }
  socket.kind_ = static_cast<SocketKind>(kind);
  socket.state_ = std::to_integer<std::uint8_t>(p_buffer[1]);
  socket.fd_ = ReadLittleEndian<std::uint32_t>(p_buffer, 4);
  socket.inode_ = ReadLittleEndian<std::uint64_t>(p_buffer, 8);
  if (IsUnix(socket.kind_))
  {
    std::memcpy(socket.unix_path_.data(), p_buffer.data() + 16, 32);
  }
  else
  {
    std::memcpy(socket.local_address_.data(), p_buffer.data() + 16, 16);
    std::memcpy(socket.remote_address_.data(), p_buffer.data() + 32, 16);
  }
  socket.local_port_ = ReadLittleEndian<std::uint16_t>(p_buffer, 48);
  socket.remote_port_ = ReadLittleEndian<std::uint16_t>(p_buffer, 50);
  const auto quad = [&](std::size_t p_index)
  {
    return ReadLittleEndian<std::uint32_t>(p_buffer, 52 + p_index * 4);
  };
  socket.rx_queue_ = quad(0);
  socket.tx_queue_ = quad(1);
  socket.rmem_alloc_ = quad(2);
  socket.rcvbuf_ = quad(3);
  socket.wmem_alloc_ = quad(4);
  socket.wmem_queued_ = quad(5);
  socket.sndbuf_ = quad(6);
  socket.drops_ = quad(7);
  socket.rtt_us_ = quad(8);
  socket.rttvar_us_ = quad(9);
  socket.total_retrans_ = quad(10);
  socket.unacked_ = quad(11);
  socket.lost_ = quad(12);
  socket.notsent_bytes_ = quad(13);
  socket.peer_window_ = quad(14);
  socket.retransmits_ = std::to_integer<std::uint8_t>(p_buffer[112]);
  socket.probes_ = std::to_integer<std::uint8_t>(p_buffer[113]);
  socket.backoff_ = std::to_integer<std::uint8_t>(p_buffer[114]);
  socket.ca_state_ = std::to_integer<std::uint8_t>(p_buffer[115]);
  socket.last_data_recv_ms_ = ReadLittleEndian<std::uint32_t>(p_buffer, 116);
  socket.last_data_sent_ms_ = ReadLittleEndian<std::uint32_t>(p_buffer, 120);
  socket.busy_us_ = ReadLittleEndian<std::uint64_t>(p_buffer, 128);
  socket.rwnd_limited_us_ = ReadLittleEndian<std::uint64_t>(p_buffer, 136);
  socket.sndbuf_limited_us_ = ReadLittleEndian<std::uint64_t>(p_buffer, 144);
  return socket;
}

// Checks the format (length, magic, version, part numbering, reserved
// bytes) and that the identities and clocks are set. Whether the values
// make sense is up to the reader.
[[nodiscard]] inline std::expected<Part, std::string_view> Decode(
    std::span<const std::byte> p_data)
{
  using wire::ReadLittleEndian;
  if (p_data.size() < kHeaderSize || std::memcmp(p_data.data(), "TRES", 4) != 0)
  {
    return std::unexpected("not a resource datagram");
  }
  if (std::to_integer<std::uint8_t>(p_data[4]) != kVersion)
  {
    return std::unexpected("unsupported resource protocol");
  }
  Part part;
  auto& header = part.header_;
  const auto kind = std::to_integer<std::uint8_t>(p_data[5]);
  header.part_ = std::to_integer<std::uint8_t>(p_data[6]);
  header.parts_ = std::to_integer<std::uint8_t>(p_data[7]);
  header.session_ = ReadLittleEndian<std::uint64_t>(p_data, 8);
  header.sequence_ = ReadLittleEndian<std::uint32_t>(p_data, 16);
  header.count_ = ReadLittleEndian<std::uint16_t>(p_data, 20);
  header.monotonic_ns_ = ReadLittleEndian<std::uint64_t>(p_data, 24);
  header.wall_ns_ = ReadLittleEndian<std::uint64_t>(p_data, 32);
  header.interval_ms_ = ReadLittleEndian<std::uint32_t>(p_data, 40);
  header.pid_ = ReadLittleEndian<std::uint32_t>(p_data, 44);
  header.process_start_ = ReadLittleEndian<std::uint64_t>(p_data, 48);
  const auto flags = ReadLittleEndian<std::uint32_t>(p_data, 56);
  header.flags_ = static_cast<Flags>(flags);
  if ((flags & ~kKnownFlags) != 0 || !AllZero(p_data.subspan(22, 2)) ||
      !AllZero(p_data.subspan(60, 4)) || header.parts_ == 0 ||
      header.parts_ > kMaxParts || header.part_ >= header.parts_)
  {
    return std::unexpected("invalid resource header");
  }
  if (header.pid_ == 0 || header.monotonic_ns_ == 0 || header.wall_ns_ == 0 ||
      header.interval_ms_ < 1000 || header.interval_ms_ > 60000)
  {
    return std::unexpected("invalid resource sample identity or clock");
  }
  if (kind == std::to_underlying(PartKind::Summary))
  {
    header.kind_ = PartKind::Summary;
    if (header.part_ != 0 || header.count_ != kSummaryFields.size() ||
        p_data.size() != kSummaryPartSize)
    {
      return std::unexpected("invalid resource summary");
    }
    for (std::size_t index = 0; index < part.values_.size(); ++index)
    {
      part.values_[index] =
          ReadLittleEndian<std::uint64_t>(p_data, kHeaderSize + index * 8);
    }
    const auto cgroup =
        p_data.subspan(kHeaderSize + part.values_.size() * 8, kCgroupSize);
    std::memcpy(part.cgroup_.data(), cgroup.data(), kCgroupSize);
    if (part.cgroup_.back() != '\0')
    {
      return std::unexpected("invalid resource summary");
    }
    return part;
  }
  if (kind != std::to_underlying(PartKind::Sockets) || header.part_ == 0 ||
      header.count_ == 0 || header.count_ > kSocketsPerPart ||
      p_data.size() != kHeaderSize + header.count_ * kSocketSize)
  {
    return std::unexpected("invalid resource socket part");
  }
  header.kind_ = PartKind::Sockets;
  for (std::size_t row = 0; row < header.count_; ++row)
  {
    auto socket = DecodeSocket(std::span<const std::byte, kSocketSize>{
        p_data.data() + kHeaderSize + row * kSocketSize, kSocketSize});
    if (!socket)
    {
      return std::unexpected(socket.error());
    }
    part.sockets_[part.socket_count_++] = *socket;
  }
  return part;
}

}  // namespace triangulator::resource_wire
