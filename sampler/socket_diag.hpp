#pragma once

// Socket queues and buffers from the kernel's sock_diag netlink interface,
// the source `ss -tmi` uses. Dumps need no privileges; they list every
// socket in the sampler's network namespace, and the caller keeps the
// target's by matching inodes from /proc/PID/fd.

#include <linux/inet_diag.h>
#include <linux/netlink.h>
#include <linux/sock_diag.h>
#include <linux/tcp.h>
#include <linux/unix_diag.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>

#include <algorithm>
#include <array>
#include <bit>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <span>
#include <utility>

#include "../common/fd.hpp"
#include "../common/resource_wire.hpp"

namespace triangulator
{

// Linux TCP_* socket states (include/net/tcp_states.h). Unix and UDP
// sockets report the same numbers.
enum class SocketState : std::uint8_t
{
  Established = 1,
  SynSent,
  SynRecv,
  FinWait1,
  FinWait2,
  TimeWait,
  Close,
  CloseWait,
  LastAck,
  Listen,
  Closing,
  NewSynRecv
};

[[nodiscard]] constexpr std::uint32_t StateBit(SocketState p_state) noexcept
{
  return std::uint32_t{1} << std::to_underlying(p_state);
}

class SocketDiag
{
 public:
  // Netlink messages are aligned to four bytes.
  [[nodiscard]] static constexpr std::size_t Align(
      std::size_t p_length) noexcept
  {
    return (p_length + 3) & ~std::size_t{3};
  }

  // Bounds one dump, so a namespace with a runaway number of sockets costs
  // a bounded amount of work per resource sample.
  static constexpr std::size_t kMaxSocketsPerDump = 1'000'000;

  // Opens the netlink socket. Replies are read into p_buffer, which the
  // caller allocates at startup and keeps alive. Large replies take fewer
  // recv calls; the kernel fills up to p_buffer.size(). Error: errno.
  [[nodiscard]] static std::expected<SocketDiag, int> Open(
      std::span<std::byte> p_buffer)
  {
    FileDescriptor socket{
        ::socket(AF_NETLINK, SOCK_DGRAM | SOCK_CLOEXEC, NETLINK_SOCK_DIAG)};
    if (!socket)
    {
      return std::unexpected(errno);
    }
    // A dump that stalls must not stall thread sampling for long.
    const timeval timeout{1, 0};
    ::setsockopt(socket.Get(), SOL_SOCKET, SO_RCVTIMEO, &timeout,
                 sizeof(timeout));
    return SocketDiag{std::move(socket), p_buffer};
  }

  // Calls p_visit(socket) for every TCP or UDP socket of p_family. TIME_WAIT
  // and pending SYN_RECV entries belong to no descriptor and are skipped.
  // Error: errno.
  template <typename TVisit>
  [[nodiscard]] std::expected<void, int> DumpInet(std::uint8_t p_family,
                                                  std::uint8_t p_protocol,
                                                  TVisit&& p_visit)
  {
    struct
    {
      nlmsghdr header_;
      inet_diag_req_v2 request_;
    } message{};
    message.header_.nlmsg_len = sizeof(message);
    message.header_.nlmsg_type = SOCK_DIAG_BY_FAMILY;
    message.header_.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
    message.header_.nlmsg_seq = ++sequence_;
    message.request_.sdiag_family = p_family;
    message.request_.sdiag_protocol = p_protocol;
    message.request_.idiag_ext = static_cast<std::uint8_t>(
        (1U << (INET_DIAG_INFO - 1)) | (1U << (INET_DIAG_SKMEMINFO - 1)));
    message.request_.idiag_states =
        ~(StateBit(SocketState::TimeWait) | StateBit(SocketState::SynRecv) |
          StateBit(SocketState::NewSynRecv));
    const bool tcp = p_protocol == IPPROTO_TCP;
    const bool ipv6 = p_family == AF_INET6;
    const auto kind = tcp ? (ipv6 ? resource_wire::SocketKind::Tcp6
                                  : resource_wire::SocketKind::Tcp4)
                          : (ipv6 ? resource_wire::SocketKind::Udp6
                                  : resource_wire::SocketKind::Udp4);
    return Dump(
        std::as_bytes(std::span{&message, 1}),
        [&](std::span<const std::byte> p_payload)
        {
          if (p_payload.size() < sizeof(inet_diag_msg))
          {
            return false;
          }
          inet_diag_msg header{};
          std::memcpy(&header, p_payload.data(), sizeof(header));
          resource_wire::Socket socket;
          socket.kind_ = kind;
          socket.state_ = header.idiag_state;
          socket.inode_ = header.idiag_inode;
          socket.rx_queue_ = header.idiag_rqueue;
          socket.tx_queue_ = header.idiag_wqueue;
          std::memcpy(socket.local_address_.data(), header.id.idiag_src,
                      ipv6 ? 16 : 4);
          std::memcpy(socket.remote_address_.data(), header.id.idiag_dst,
                      ipv6 ? 16 : 4);
          socket.local_port_ = FromNetwork(header.id.idiag_sport);
          socket.remote_port_ = FromNetwork(header.id.idiag_dport);
          ForEachAttribute(
              p_payload.subspan(Align(sizeof(inet_diag_msg))),
              [&](std::uint16_t p_type, std::span<const std::byte> p_value)
              {
                if (p_type == INET_DIAG_SKMEMINFO)
                {
                  ReadMemory(p_value, socket);
                }
                else if (p_type == INET_DIAG_INFO && tcp)
                {
                  ReadTcpInfo(p_value, socket);
                }
              });
          p_visit(socket);
          return true;
        });
  }

  // Calls p_visit(socket) for every unix socket. Error: errno.
  template <typename TVisit>
  [[nodiscard]] std::expected<void, int> DumpUnix(TVisit&& p_visit)
  {
    struct
    {
      nlmsghdr header_;
      unix_diag_req request_;
    } message{};
    message.header_.nlmsg_len = sizeof(message);
    message.header_.nlmsg_type = SOCK_DIAG_BY_FAMILY;
    message.header_.nlmsg_flags = NLM_F_REQUEST | NLM_F_DUMP;
    message.header_.nlmsg_seq = ++sequence_;
    message.request_.sdiag_family = AF_UNIX;
    message.request_.udiag_states = ~0U;
    message.request_.udiag_show =
        UDIAG_SHOW_NAME | UDIAG_SHOW_RQLEN | UDIAG_SHOW_MEMINFO;
    return Dump(
        std::as_bytes(std::span{&message, 1}),
        [&](std::span<const std::byte> p_payload)
        {
          if (p_payload.size() < sizeof(unix_diag_msg))
          {
            return false;
          }
          unix_diag_msg header{};
          std::memcpy(&header, p_payload.data(), sizeof(header));
          resource_wire::Socket socket;
          switch (header.udiag_type)
          {
            case SOCK_STREAM:
              socket.kind_ = resource_wire::SocketKind::UnixStream;
              break;
            case SOCK_DGRAM:
              socket.kind_ = resource_wire::SocketKind::UnixDatagram;
              break;
            case SOCK_SEQPACKET:
              socket.kind_ = resource_wire::SocketKind::UnixSeqpacket;
              break;
            default:
              return true;
          }
          socket.state_ = header.udiag_state;
          socket.inode_ = header.udiag_ino;
          ForEachAttribute(
              p_payload.subspan(Align(sizeof(unix_diag_msg))),
              [&](std::uint16_t p_type, std::span<const std::byte> p_value)
              {
                if (p_type == UNIX_DIAG_NAME)
                {
                  ReadUnixName(p_value, socket);
                }
                else if (p_type == UNIX_DIAG_RQLEN &&
                         p_value.size() >= sizeof(unix_diag_rqlen))
                {
                  unix_diag_rqlen queues{};
                  std::memcpy(&queues, p_value.data(), sizeof(queues));
                  socket.rx_queue_ = queues.udiag_rqueue;
                  socket.tx_queue_ = queues.udiag_wqueue;
                }
                else if (p_type == UNIX_DIAG_MEMINFO)
                {
                  ReadMemory(p_value, socket);
                }
              });
          p_visit(socket);
          return true;
        });
  }

 private:
  SocketDiag(FileDescriptor p_socket, std::span<std::byte> p_buffer)
      : socket_(std::move(p_socket)), buffer_(p_buffer)
  {
  }

  [[nodiscard]] static std::uint16_t FromNetwork(std::uint16_t p_port) noexcept
  {
    const auto bytes = std::bit_cast<std::array<std::uint8_t, 2>>(p_port);
    return static_cast<std::uint16_t>((bytes[0] << 8) | bytes[1]);
  }

  // Calls p_visit(type, value) for each netlink attribute in p_data.
  template <typename TVisit>
  static void ForEachAttribute(std::span<const std::byte> p_data,
                               TVisit&& p_visit)
  {
    while (p_data.size() >= sizeof(nlattr))
    {
      nlattr attribute{};
      std::memcpy(&attribute, p_data.data(), sizeof(attribute));
      if (attribute.nla_len < sizeof(nlattr) ||
          attribute.nla_len > p_data.size())
      {
        return;
      }
      p_visit(
          static_cast<std::uint16_t>(attribute.nla_type & NLA_TYPE_MASK),
          p_data.subspan(sizeof(nlattr), attribute.nla_len - sizeof(nlattr)));
      p_data =
          p_data.subspan(std::min(p_data.size(), Align(attribute.nla_len)));
    }
  }

  // SK_MEMINFO_* values. Older kernels send fewer; the rest stay zero.
  static void ReadMemory(std::span<const std::byte> p_value,
                         resource_wire::Socket& p_socket)
  {
    std::array<std::uint32_t, SK_MEMINFO_VARS> memory{};
    std::memcpy(memory.data(), p_value.data(),
                std::min(p_value.size(), sizeof(memory)));
    p_socket.rmem_alloc_ = memory[SK_MEMINFO_RMEM_ALLOC];
    p_socket.rcvbuf_ = memory[SK_MEMINFO_RCVBUF];
    p_socket.wmem_alloc_ = memory[SK_MEMINFO_WMEM_ALLOC];
    p_socket.sndbuf_ = memory[SK_MEMINFO_SNDBUF];
    p_socket.wmem_queued_ = memory[SK_MEMINFO_WMEM_QUEUED];
    p_socket.drops_ = memory[SK_MEMINFO_DROPS];
    p_socket.flags_ |= std::to_underlying(resource_wire::SocketFlags::Memory);
  }

  // struct tcp_info grows with kernel versions; the kernel sends the size it
  // knows, so a field counts only when the reply reaches past it.
  static void ReadTcpInfo(std::span<const std::byte> p_value,
                          resource_wire::Socket& p_socket)
  {
    tcp_info info{};
    std::memcpy(&info, p_value.data(), std::min(p_value.size(), sizeof(info)));
    const auto has = [&](std::size_t p_end)
    {
      return p_value.size() >= p_end;
    };
    if (!has(offsetof(tcp_info, tcpi_total_retrans) +
             sizeof(info.tcpi_total_retrans)))
    {
      return;
    }
    using resource_wire::SocketFlags;
    p_socket.flags_ |= std::to_underlying(SocketFlags::TcpInfo);
    p_socket.rtt_us_ = info.tcpi_rtt;
    p_socket.rttvar_us_ = info.tcpi_rttvar;
    p_socket.total_retrans_ = info.tcpi_total_retrans;
    p_socket.unacked_ = info.tcpi_unacked;
    p_socket.lost_ = info.tcpi_lost;
    p_socket.retransmits_ = info.tcpi_retransmits;
    p_socket.probes_ = info.tcpi_probes;
    p_socket.backoff_ = info.tcpi_backoff;
    p_socket.ca_state_ = info.tcpi_ca_state;
    p_socket.last_data_recv_ms_ = info.tcpi_last_data_recv;
    p_socket.last_data_sent_ms_ = info.tcpi_last_data_sent;
    if (has(offsetof(tcp_info, tcpi_notsent_bytes) +
            sizeof(info.tcpi_notsent_bytes)))
    {
      p_socket.notsent_bytes_ = info.tcpi_notsent_bytes;
    }
    if (has(offsetof(tcp_info, tcpi_sndbuf_limited) +
            sizeof(info.tcpi_sndbuf_limited)))
    {
      p_socket.flags_ |= std::to_underlying(SocketFlags::TcpLimited);
      p_socket.busy_us_ = info.tcpi_busy_time;
      p_socket.rwnd_limited_us_ = info.tcpi_rwnd_limited;
      p_socket.sndbuf_limited_us_ = info.tcpi_sndbuf_limited;
    }
    if (has(offsetof(tcp_info, tcpi_snd_wnd) + sizeof(info.tcpi_snd_wnd)))
    {
      p_socket.flags_ |= std::to_underlying(SocketFlags::PeerWindow);
      p_socket.peer_window_ = info.tcpi_snd_wnd;
    }
  }

  // A bound path, or an abstract name shown as '@name' with any other NULs
  // also shown as '@', as ss does. Unnamed sockets (most socketpair ends and
  // clients) have no name attribute.
  static void ReadUnixName(std::span<const std::byte> p_value,
                           resource_wire::Socket& p_socket)
  {
    auto& path = p_socket.unix_path_;
    auto length = std::min(p_value.size(), path.size() - 1);
    std::memcpy(path.data(), p_value.data(), length);
    if (length == 0)
    {
      return;
    }
    if (path[0] != '\0')
    {
      // A filesystem path ends at its terminating NUL.
      std::fill(std::find(path.begin(), path.end(), '\0'), path.end(), '\0');
      return;
    }
    std::replace(path.begin(), path.begin() + static_cast<long>(length), '\0',
                 '@');
  }

  // Sends p_request and passes each reply payload to p_visit until the
  // kernel ends the dump. p_visit returns false for a malformed payload.
  template <typename TVisit>
  [[nodiscard]] std::expected<void, int> Dump(
      std::span<const std::byte> p_request, TVisit&& p_visit)
  {
    sockaddr_nl kernel{};
    kernel.nl_family = AF_NETLINK;
    if (::sendto(socket_.Get(), p_request.data(), p_request.size(), 0,
                 reinterpret_cast<const sockaddr*>(&kernel),
                 sizeof(kernel)) < 0)
    {
      return std::unexpected(errno);
    }
    std::size_t sockets = 0;
    while (true)
    {
      ssize_t length;
      do
      {
        length = ::recv(socket_.Get(), buffer_.data(), buffer_.size(), 0);
      } while (length < 0 && errno == EINTR);
      if (length < 0)
      {
        return std::unexpected(errno);
      }
      std::span<const std::byte> data{buffer_.data(),
                                      static_cast<std::size_t>(length)};
      while (data.size() >= sizeof(nlmsghdr))
      {
        nlmsghdr header{};
        std::memcpy(&header, data.data(), sizeof(header));
        if (header.nlmsg_len < sizeof(nlmsghdr) ||
            header.nlmsg_len > data.size())
        {
          return std::unexpected(EPROTO);
        }
        const auto payload =
            data.subspan(Align(sizeof(nlmsghdr)),
                         header.nlmsg_len - Align(sizeof(nlmsghdr)));
        data = data.subspan(std::min(data.size(), Align(header.nlmsg_len)));
        if (header.nlmsg_seq != sequence_)
        {
          continue;  // a late reply to an earlier, abandoned dump
        }
        if (header.nlmsg_type == NLMSG_DONE)
        {
          return {};
        }
        if (header.nlmsg_type == NLMSG_ERROR)
        {
          nlmsgerr error{};
          std::memcpy(&error, payload.data(),
                      std::min(payload.size(), sizeof(error)));
          return std::unexpected(error.error ? -error.error : EPROTO);
        }
        if (!p_visit(payload))
        {
          return std::unexpected(EPROTO);
        }
        if (++sockets > kMaxSocketsPerDump)
        {
          return std::unexpected(E2BIG);
        }
      }
    }
  }

  FileDescriptor socket_;
  std::uint32_t sequence_ = 0;
  // Owned by the caller. Read with memcpy, so its alignment does not matter.
  std::span<std::byte> buffer_;
};

}  // namespace triangulator
