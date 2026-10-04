#pragma once

#include <cstdio>
#include <thread>
#include <vector>

#include "../sampler/config.hpp"
#include "protocol.hpp"

namespace triangulator::socket_metrics
{
// Spread the bounded snapshot over the sampling interval so the collector can
// drain its UDP queue while inserting rows. Never catch up with a send burst.
inline void SendSnapshot(
    Observation p_observation,
    const std::vector<std::pair<CounterKey, Counters>>& p_rows,
    const Endpoint& p_destination)
{
  p_observation.count_ = static_cast<U32>(p_rows.size() + 1);
  for (U32 index = 0; index < p_observation.count_; ++index)
  {
    if (index)
    {
      std::this_thread::sleep_for(std::chrono::microseconds{150});
    }
    p_observation.index_ = index;
    p_observation.key_ = index ? p_rows[index - 1].first : CounterKey{};
    p_observation.counters_ = index ? p_rows[index - 1].second : Counters{};
    const auto data = Encode(p_observation);
    if (::sendto(
            p_destination.socket_.Get(), data.data(), data.size(), MSG_DONTWAIT,
            reinterpret_cast<const sockaddr*>(&p_destination.address_),
            p_destination.address_length_) != static_cast<ssize_t>(data.size()))
    {
      std::fprintf(stderr, "socket snapshot datagram dropped: %s\n",
                   std::strerror(errno));
    }
  }
}
}  // namespace triangulator::socket_metrics
