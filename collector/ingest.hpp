#pragma once

// What the collector does with one received datagram: tells the six
// datagram kinds apart by their magic (thread ticks, resource parts,
// memory-map parts, exit reports, process info and socket observations),
// checks the sender, and passes the datagram to the Monitor, the
// ResourceMonitor, the MemoryMonitor, the ExitMonitor, the ProcessMonitor or
// Storage. The main loop calls Handle() for
// each datagram. Handle() allocates nothing, except in the one-time log message
// when it pins the sampler's address.

#include <arpa/inet.h>
#include <sys/socket.h>

#include <cstddef>
#include <cstring>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

#include "../common/exit_wire.hpp"
#include "../common/memory_wire.hpp"
#include "../common/process_wire.hpp"
#include "../common/resource_wire.hpp"
#include "bounded.hpp"
#include "engine.hpp"
#include "exits.hpp"
#include "log.hpp"
#include "memory.hpp"
#include "process.hpp"
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
  // p_sampler_ip is the configured sender address; without one, the sender
  // is pinned to the first valid datagram.
  Ingest(const std::optional<std::string>& p_sampler_ip, Monitor& p_monitor,
         ResourceMonitor& p_resources, MemoryMonitor& p_memory,
         ExitMonitor& p_exits, ProcessMonitor& p_process, Storage& p_storage,
         const StorageSink& p_sink)
      : monitor_(p_monitor),
        resources_(p_resources),
        memory_(p_memory),
        exits_(p_exits),
        process_(p_process),
        storage_(p_storage),
        sink_(p_sink)
  {
    if (p_sampler_ip)
    {
      sampler_ip_ = PeerText{*p_sampler_ip};
    }
  }

  Ingest(const std::vector<std::string>& p_sampler_ips, Monitor& p_monitor,
         ResourceMonitor& p_resources, MemoryMonitor& p_memory,
         ExitMonitor& p_exits, ProcessMonitor& p_process, Storage& p_storage,
         const StorageSink& p_sink)
      : Ingest(std::nullopt, p_monitor, p_resources, p_memory, p_exits,
               p_process, p_storage, p_sink)
  {
    for (const auto& sender : p_sampler_ips)
    {
      allowed_senders_.emplace_back(sender);
    }
    if (allowed_senders_.size() == 1)
    {
      sampler_ip_ = allowed_senders_.front();
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
    if (p_data.size() >= 4 && std::memcmp(p_data.data(), "TRES", 4) == 0)
    {
      if (Allowed(p_peer, sampler_ip_))
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
    else if (p_data.size() >= 4 &&
             std::memcmp(p_data.data(), memory_wire::kMagic.data(), 4) == 0)
    {
      if (Allowed(p_peer, sampler_ip_))
      {
        if (const auto part = memory_wire::Decode(p_data))
        {
          Pin(p_peer);
          memory_.Accept(*part, p_now);
        }
        else
        {
          ++memory_.bad_parts_;
        }
      }
    }
    else if (p_data.size() >= 4 &&
             std::memcmp(p_data.data(), exit_wire::kMagic.data(), 4) == 0)
    {
      if (Allowed(p_peer, sampler_ip_))
      {
        if (const auto report = exit_wire::Decode(p_data))
        {
          Pin(p_peer);
          if (exits_.Accept(*report))
          {
            if (auto stored = storage_.Exit(*report); !stored)
            {
              return stored;
            }
          }
        }
        else
        {
          ++monitor_.bad_packets_;
        }
      }
    }
    else if (p_data.size() >= 4 &&
             std::memcmp(p_data.data(), process_wire::kMagic.data(), 4) == 0)
    {
      if (Allowed(p_peer, sampler_ip_))
      {
        if (const auto info = process_wire::Decode(p_data))
        {
          Pin(p_peer);
          process_.Accept(*info);
        }
        else
        {
          ++monitor_.bad_packets_;
        }
      }
    }
    else if (Allowed(p_peer, sampler_ip_))
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
  MemoryMonitor& memory_;
  ExitMonitor& exits_;
  ProcessMonitor& process_;
  Storage& storage_;
  const StorageSink& sink_;
  std::optional<PeerText> sampler_ip_;

  std::vector<PeerText> allowed_senders_;

  [[nodiscard]] bool Allowed(const PeerText& p_peer,
                             const std::optional<PeerText>& p_pinned) const
  {
    if (!allowed_senders_.empty())
    {
      return std::ranges::find(allowed_senders_, p_peer) !=
             allowed_senders_.end();
    }
    return !p_pinned || p_peer == *p_pinned;
  }

  void Pin(const PeerText& p_peer)
  {
    // A sender list is the filter; there is nothing to pin.
    if (allowed_senders_.empty() && !sampler_ip_)
    {
      sampler_ip_ = p_peer;
      Log(LogLevel::Info,
          std::format("Pinned sampler source to {}", p_peer.View()));
    }
  }
};

}  // namespace triangulator::collector
