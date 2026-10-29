#pragma once

#include <arpa/inet.h>
#include <sys/socket.h>

#include <array>
#include <string_view>

#include "bounded.hpp"

namespace triangulator::collector
{

using PeerText = FixedText<INET6_ADDRSTRLEN>;

[[nodiscard]] inline PeerText PeerAddress(const sockaddr_storage& p_peer)
{
  std::array<char, INET6_ADDRSTRLEN> buffer{};
  const void* address =
      p_peer.ss_family == AF_INET6
          ? static_cast<const void*>(
                &reinterpret_cast<const sockaddr_in6&>(p_peer).sin6_addr)
          : static_cast<const void*>(
                &reinterpret_cast<const sockaddr_in&>(p_peer).sin_addr);
  ::inet_ntop(p_peer.ss_family, address, buffer.data(),
              static_cast<socklen_t>(buffer.size()));
  return PeerText{buffer.data()};
}

// True for a loopback source. The kernel reports a datagram's or a
// connection's source address, and Linux drops loopback sources that arrive
// on other interfaces, so a remote host cannot claim one.
[[nodiscard]] inline bool IsLoopback(std::string_view p_address) noexcept
{
  return p_address.starts_with("127.") || p_address == "::1" ||
         p_address.starts_with("::ffff:127.");
}

}  // namespace triangulator::collector
