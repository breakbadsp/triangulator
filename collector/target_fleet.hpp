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
      : config_(p_config), storage_(p_storage), sink_(p_sink)
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
      if (const auto observation = socket_metrics::Decode(p_data))
      {
        auto binding = std::ranges::find_if(
            socket_bindings_,
            [&](const SocketBinding& p_binding)
            {
              return p_binding.active_ && p_binding.peer_ == p_peer &&
                     p_binding.pid_ == observation->pid_;
            });
        if (binding == socket_bindings_.end())
        {
          binding = std::ranges::find(socket_bindings_, false,
                                      &SocketBinding::active_);
          if (binding == socket_bindings_.end())
          {
            binding = socket_bindings_.begin() +
                      static_cast<std::ptrdiff_t>(socket_position_++ %
                                                  socket_bindings_.size());
            ++capacity_drops_;
          }
        }
        *binding = {true, p_peer, observation->pid_, observation->observer_,
                    p_now};
      }
      return slots_.front()->ingest_.Handle(p_data, p_peer, p_now);
    }
    std::uint64_t session = 0;
    std::optional<std::uint32_t> pid;
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
      pid = decoded->pid_;
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
      pid = decoded->header_.pid_;
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
      pid = decoded->header_.pid_;
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
      pid = decoded->pid_;
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
    const bool new_session = !slot->active_ || slot->session_ != session;
    if (new_session)
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
        slot->announced_ = false;
        slot->announcement_ = {};
        slot->last_body_.reset();
        slot->last_metadata_.reset();
        slot->previous_body_.reset();
        slot->previous_metadata_.reset();
      }
      slot->pid_ = 0;
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
        slot->visible_ = !AnnouncedPeer(p_peer);
        slot->id_ = FixedText<32>{slot->visible_ ? "default" : ""};
      }
    }
    if (announcement)
    {
      if (known && known != slot)
      {
        Retire(known->peer_, known->session_);
        known->monitor_.Close();
        known->resources_.Drain(p_now, true);
        slot->previous_body_ =
            known->last_body_ ? known->last_body_ : known->previous_body_;
        slot->previous_metadata_ = known->last_metadata_
                                       ? known->last_metadata_
                                       : known->previous_metadata_;
        known->active_ = false;
        known->visible_ = false;
      }
      if (slot->peer_ != p_peer)
      {
        Retire(slot->peer_, slot->session_);
        slot->peer_ = p_peer;
      }
      slot->host_ = FixedText<64>{target_wire::Text(announcement->host_)};
      slot->id_ = FixedText<32>{target_wire::Text(announcement->target_)};
      slot->announcement_ = *announcement;
      slot->pid_ = announcement->pid_;
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
    if (pid)
    {
      slot->pid_ = *pid;
    }
    if (new_session || announcement)
    {
      storage_.RememberTarget(session, slot->host_.View(), slot->id_.View(),
                              slot->pid_, slot->announcement_.process_start_,
                              slot->first_seen_);
    }
    slot->last_seen_ = p_now;
    slot->dirty_ = true;
    if (!announcement)
    {
      return slot->ingest_.Handle(p_data, p_peer, p_now);
    }
    return sink_.Status();
  }

  [[nodiscard]] std::optional<std::string> SocketObserver(
      const TargetSlot& p_slot) const
  {
    const SocketBinding* latest = nullptr;
    for (const auto& binding : socket_bindings_)
    {
      if (binding.active_ && binding.peer_ == p_slot.peer_ &&
          binding.pid_ == p_slot.pid_ && p_slot.pid_ != 0 &&
          binding.received_ >= p_slot.first_seen_ &&
          (!latest || binding.received_ > latest->received_))
      {
        latest = &binding;
      }
    }
    return latest ? std::optional{std::to_string(latest->observer_)}
                  : std::nullopt;
  }

  void Remove(std::string_view p_key)
  {
    const auto separator = p_key.rfind('/');
    if (separator == std::string_view::npos)
    {
      return;
    }
    for (auto& slot : slots_)
    {
      const bool legacy_local =
          !slot->announced_ &&
          (slot->peer_.View() == "127.0.0.1" || slot->peer_.View() == "::1");
      if (slot->active_ && slot->id_.View() == p_key.substr(separator + 1) &&
          (slot->host_.View() == p_key.substr(0, separator) || legacy_local))
      {
        Retire(slot->peer_, slot->session_);
        slot->monitor_.Close();
        slot->resources_.Drain(0, true);
        slot->active_ = false;
        slot->visible_ = false;
      }
    }
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
  struct SocketBinding
  {
    bool active_ = false;
    PeerText peer_;
    std::uint32_t pid_ = 0;
    std::uint64_t observer_ = 0;
    double received_ = 0;
  };
  std::array<SocketBinding, 128> socket_bindings_{};
  std::size_t socket_position_ = 0;
  const Config& config_;
  Storage& storage_;
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
