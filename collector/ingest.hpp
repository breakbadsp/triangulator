#pragma once

// What the collector does with one received datagram: tells the datagram
// kinds apart (thread ticks, resource parts, memory-map parts and socket
// observations), checks the sender, and passes the datagram to the Monitor,
// the ResourceMonitor, the MemoryMapMonitor or Storage. The main loop calls
// Handle() for each datagram. Handle() allocates nothing, except in the
// one-time log message when it pins the sampler's address.

#include <arpa/inet.h>
#include <sys/socket.h>

#include <cstddef>
#include <cstring>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>

#include "../common/memory_wire.hpp"
#include "../common/resource_wire.hpp"
#include "../socket_sampler/protocol.hpp"
#include "bounded.hpp"
#include "engine.hpp"
#include "log.hpp"
#include "memory_map.hpp"
#include "protocol.hpp"
#include "resources.hpp"
#include "storage.hpp"

namespace triangulator::collector
{

// A peer address as text, such as "10.0.0.1" or "::1".
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

class Ingest
{
 public:
  // p_sampler_ip and p_socket_sampler_ip are the configured sender
  // addresses; a sender that has none is pinned to the first valid datagram.
  // p_memory_map is null when the memory map is off; its datagrams are
  // then counted as bad packets, like any unknown datagram.
  Ingest(const std::optional<std::string>& p_sampler_ip, Monitor& p_monitor,
         ResourceMonitor& p_resources, Storage& p_storage,
         const StorageSink& p_sink, MemoryMapMonitor* p_memory_map = nullptr)
      : monitor_(p_monitor),
        resources_(p_resources),
        storage_(p_storage),
        sink_(p_sink),
        memory_map_(p_memory_map)
  {
    if (p_sampler_ip)
    {
      sampler_ip_ = PeerText{*p_sampler_ip};
      socket_sampler_ip_ = sampler_ip_;
    }
  }

  [[nodiscard]] const std::optional<PeerText>& SamplerIp() const noexcept
  {
    return sampler_ip_;
  }

  // Handles one datagram received at p_now. Returns the first storage error,
  // which stops the collector.
  [[nodiscard]] SqliteResult Handle(std::span<const std::byte> p_data,
                                    const PeerText& p_peer, double p_now)
  {
    if (p_data.size() >= 4 && std::memcmp(p_data.data(), "TSIO", 4) == 0)
    {
      if (!socket_sampler_ip_ || p_peer == *socket_sampler_ip_)
      {
        if (const auto observation = socket_metrics::Decode(p_data))
        {
          socket_sampler_ip_ = p_peer;
          if (auto stored = storage_.Socket(p_now, *observation, p_data);
              !stored)
          {
            return stored;
          }
        }
        else
        {
          ++monitor_.bad_packets_;
        }
      }
    }
    else if (p_data.size() >= 4 && std::memcmp(p_data.data(), "TRES", 4) == 0)
    {
      if (!sampler_ip_ || p_peer == *sampler_ip_)
      {
        if (const auto part = resource_wire::Decode(p_data))
        {
          Pin(p_peer);
          resources_.Accept(*part, p_now);
        }
        else
        {
          ++resources_.bad_parts_;
        }
      }
    }
    else if (memory_map_ != nullptr && p_data.size() >= 4 &&
             std::memcmp(p_data.data(), "TVMA", 4) == 0)
    {
      if (!sampler_ip_ || p_peer == *sampler_ip_)
      {
        if (const auto part = memory_wire::Decode(p_data))
        {
          Pin(p_peer);
          memory_map_->Accept(*part, p_now);
        }
        else
        {
          ++memory_map_->bad_parts_;
        }
      }
    }
    else if (!sampler_ip_ || p_peer == *sampler_ip_)
    {
      if (const auto packet = Decode(p_data))
      {
        Pin(p_peer);
        monitor_.Accept(*packet, p_now);
      }
      else
      {
        ++monitor_.bad_packets_;
      }
    }
    return sink_.Status();
  }

 private:
  Monitor& monitor_;
  ResourceMonitor& resources_;
  Storage& storage_;
  const StorageSink& sink_;
  MemoryMapMonitor* memory_map_;
  std::optional<PeerText> sampler_ip_;
  std::optional<PeerText> socket_sampler_ip_;

  void Pin(const PeerText& p_peer)
  {
    if (!sampler_ip_)
    {
      sampler_ip_ = p_peer;
      Log(LogLevel::Info,
          std::format("Pinned sampler source to {}", p_peer.View()));
    }
  }
};

}  // namespace triangulator::collector
