#pragma once

#include <array>
#include <memory>
#include <vector>

#include "target_slot.hpp"

namespace triangulator::collector
{

// Slots and retired-session keys are reserved at startup. Hidden sessions
// share this bound until their announcement arrives.
class TargetFleet final
{
 public:
  TargetFleet(const Config& p_config, double p_now, Storage& p_storage,
              StorageSink& p_sink)
      : config_(p_config), sink_(p_sink)
  {
    Config slot_config = p_config;
    slot_config.max_live_samples_ /= p_config.max_targets_;
    for (std::int64_t index = 0; index < p_config.max_targets_; ++index)
    {
      slots_.push_back(
          std::make_unique<TargetSlot>(slot_config, p_now, p_storage, p_sink));
    }
  }

  [[nodiscard]] auto& Slots() noexcept
  {
    return slots_;
  }

  [[nodiscard]] SqliteResult Handle(std::span<const std::byte> p_data,
                                    const PeerText& p_peer, double p_now)
  {
    if (!Allowed(p_peer) || p_data.size() < 4)
    {
      return {};
    }
    const std::string_view magic{reinterpret_cast<const char*>(p_data.data()),
                                 4};
    if (magic == "TSIO")
    {
      // The optional socket source has its own observer identity and remains
      // independent of sampler sessions.
      return slots_.front()->ingest_.Handle(p_data, p_peer, p_now);
    }
    std::uint64_t session = 0;
    std::optional<target_wire::Packet> announcement;
    if (magic == "TTGT")
    {
      const auto decoded = target_wire::Decode(p_data);
      if (!decoded)
      {
        ++bad_packets_;
        return {};
      }
      announcement = *decoded;
      session = decoded->session_;
    }
    else if (magic == "TMON")
    {
      const auto decoded = Decode(p_data);
      if (!decoded)
      {
        ++bad_packets_;
        return {};
      }
      session = decoded->session_;
    }
    else if (magic == "TRES")
    {
      const auto decoded = resource_wire::Decode(p_data);
      if (!decoded)
      {
        ++bad_packets_;
        return {};
      }
      session = decoded->header_.session_;
    }
    else if (magic == "TVMA")
    {
      const auto decoded = memory_wire::Decode(p_data);
      if (!decoded)
      {
        ++bad_packets_;
        return {};
      }
      session = decoded->header_.session_;
    }
    else if (magic == "TPIN")
    {
      const auto decoded = process_wire::Decode(p_data);
      if (!decoded)
      {
        ++bad_packets_;
        return {};
      }
      session = decoded->session_;
    }
    else if (magic == "TEND")
    {
      const auto decoded = exit_wire::Decode(p_data);
      if (!decoded)
      {
        ++bad_packets_;
        return {};
      }
      session = decoded->next_session_;
    }
    else
    {
      ++bad_packets_;
      return {};
    }
    if (IsRetired(p_peer, session))
    {
      return {};
    }
    if (!pinned_)
    {
      pinned_ = p_peer;
    }
    TargetSlot* slot = nullptr;
    for (auto& candidate : slots_)
    {
      if (candidate->active_ && candidate->peer_ == p_peer &&
          candidate->session_ == session)
      {
        slot = candidate.get();
        break;
      }
    }
    TargetSlot* known = nullptr;
    if (announcement)
    {
      for (auto& candidate : slots_)
      {
        if (candidate->active_ && candidate->visible_ &&
            candidate->host_.View() == target_wire::Text(announcement->host_) &&
            candidate->id_.View() == target_wire::Text(announcement->target_))
        {
          // A host name cannot move between allowed senders during a run.
          if (candidate->peer_ != p_peer)
          {
            ++bad_packets_;
            return {};
          }
          known = candidate.get();
          break;
        }
      }
      // The first TTGT can be lost before the collector binds its socket.
      // A later default announcement adopts the legacy sender key.
      if (!known && target_wire::Text(announcement->target_) == "default")
      {
        for (auto& candidate : slots_)
        {
          if (candidate->active_ && candidate->visible_ &&
              !candidate->announced_ && candidate->peer_ == p_peer)
          {
            known = candidate.get();
            break;
          }
        }
      }
      if (!slot && known)
      {
        slot = known;
      }
    }
    else if (!AnnouncedPeer(p_peer))
    {
      for (auto& candidate : slots_)
      {
        if (candidate->active_ && candidate->peer_ == p_peer &&
            !candidate->announced_ && candidate->visible_)
        {
          slot = candidate.get();
          break;
        }
      }
    }
    if (!slot)
    {
      for (auto& candidate : slots_)
      {
        if (!candidate->active_)
        {
          slot = candidate.get();
          break;
        }
      }
    }
    if (!slot)
    {
      ++capacity_drops_;
      return {};
    }
    if (slot->session_ != session)
    {
      if (slot->active_)
      {
        Retire(slot->peer_, slot->session_);
        slot->monitor_.Close();
        slot->resources_.Drain(p_now, true);
      }
      slot->reset_view_ = !slot->active_;
      if (!slot->active_)
      {
        slot->exits_.Clear();
      }
      static_cast<void>(slot->monitor_.PrepareSession(session, p_now));
      slot->resources_.PrepareSession(session, p_now);
      slot->memory_.PrepareSession(session);
      slot->process_.PrepareSession(session);
      slot->session_ = session;
      slot->peer_ = p_peer;
      slot->active_ = true;
      slot->first_seen_ = p_now;
      slot->mapping_dirty_ = true;
      if (!announcement)
      {
        slot->host_ = FixedText<64>{p_peer.View()};
        slot->id_ = FixedText<32>{"default"};
        slot->visible_ = !AnnouncedPeer(p_peer);
      }
    }
    if (announcement)
    {
      if (known && known != slot)
      {
        Retire(known->peer_, known->session_);
        known->monitor_.Close();
        known->resources_.Drain(p_now, true);
        slot->previous_view_ = known;
        known->active_ = false;
        known->visible_ = false;
      }
      slot->host_ = FixedText<64>{target_wire::Text(announcement->host_)};
      slot->id_ = FixedText<32>{target_wire::Text(announcement->target_)};
      slot->announcement_ = *announcement;
      slot->announced_ = true;
      slot->visible_ = true;
      slot->mapping_dirty_ = true;
      // An initial tick can arrive before the first announcement. Its
      // temporary legacy key must not remain a second visible target.
      for (auto& candidate : slots_)
      {
        if (candidate.get() != slot && candidate->active_ &&
            candidate->peer_ == p_peer && !candidate->announced_)
        {
          candidate->visible_ = false;
        }
      }
    }
    slot->last_seen_ = p_now;
    slot->dirty_ = true;
    if (!announcement)
    {
      return slot->ingest_.Handle(p_data, p_peer, p_now);
    }
    return sink_.Status();
  }

  void Close()
  {
    for (auto& slot : slots_)
    {
      slot->recorder_.Stop();
      if (slot->active_)
      {
        slot->monitor_.Close();
        slot->resources_.Drain(0, true);
      }
    }
  }

  std::uint64_t bad_packets_ = 0;
  std::uint64_t capacity_drops_ = 0;

 private:
  struct Retired
  {
    PeerText peer_;
    std::uint64_t session_ = 0;
  };
  const Config& config_;
  StorageSink& sink_;
  std::vector<std::unique_ptr<TargetSlot>> slots_;
  std::optional<PeerText> pinned_;
  std::array<Retired, 1024> retired_{};
  std::size_t retired_position_ = 0;

  [[nodiscard]] bool Allowed(const PeerText& p_peer) const
  {
    if (config_.sampler_ips_.empty())
    {
      return !pinned_ || p_peer == *pinned_;
    }
    return std::ranges::any_of(config_.sampler_ips_,
                               [&](const std::string& p_ip)
                               {
                                 return p_ip == p_peer.View();
                               });
  }
  [[nodiscard]] bool AnnouncedPeer(const PeerText& p_peer) const
  {
    return std::ranges::any_of(slots_,
                               [&](const auto& p_slot)
                               {
                                 return p_slot->active_ && p_slot->announced_ &&
                                        p_slot->peer_ == p_peer;
                               });
  }
  [[nodiscard]] bool IsRetired(const PeerText& p_peer,
                               std::uint64_t p_session) const
  {
    return std::ranges::any_of(retired_,
                               [&](const Retired& p_retired)
                               {
                                 return p_retired.session_ == p_session &&
                                        p_retired.peer_ == p_peer;
                               });
  }
  void Retire(const PeerText& p_peer, std::uint64_t p_session)
  {
    retired_[retired_position_++ % retired_.size()] = {p_peer, p_session};
  }
};

}  // namespace triangulator::collector
