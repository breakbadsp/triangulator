#pragma once

#include <algorithm>
#include <array>
#include <cstdint>
#include <memory>
#include <span>
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
    for (std::int64_t index = 0; index < p_config.max_targets_; ++index)
    {
      slots_.push_back(
          std::make_unique<TargetSlot>(p_config, p_now, p_storage, p_sink));
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
    if (announcement && (announcement->flags_ & target_wire::kReleased) != 0)
    {
      Release(p_peer, *announcement, p_now);
      return {};
    }
    // A recovered session lost the legacy sender key to another session of
    // the same sampler, as after a collector restart. That session still
    // holds the key, so the recovered one must not adopt it.
    bool recovered = false;
    if (IsRetired(p_peer, session))
    {
      recovered = announcement && Recover(p_peer, session);
      if (!recovered)
      {
        return {};
      }
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
      if (!known && !recovered &&
          target_wire::Text(announcement->target_) == "default")
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
        // Without TTGT, a second session from this sender replaces the first
        // as an old sampler would. If the sender is a new one that was
        // heard before its announcements, its TTGT recovers the session.
        // This also holds when a TTGT of another session adopts the slot:
        // the unannounced session can be a second target of that sampler.
        Retire(slot->peer_, slot->session_, !slot->announced_);
        slot->monitor_.Close();
        slot->resources_.Drain(p_now, true);
      }
      slot->reset_view_ = !slot->active_;
      if (!slot->active_)
      {
        slot->exits_.Clear();
        // A reused slot must not keep the identity or the views of its
        // previous target.
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
    // Cache the mapping now. The session can be replaced before the next
    // refresh, and its stored rows would otherwise belong to "default".
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

  // Retires the sessions of a target the operator removed. Only a slot whose
  // current session is in p_sessions is affected: a replacement with the same
  // ID is a new session and stays.
  void Remove(std::string_view p_key, std::span<const std::uint64_t> p_sessions)
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
      if (slot->active_ && std::ranges::contains(p_sessions, slot->session_) &&
          slot->id_.View() == p_key.substr(separator + 1) &&
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

  // A discovered target ended or no rule selects it any more. Its slot is
  // freed now: idle expiry would hold it for minutes during churn. Only
  // this session is freed; a delayed release cannot remove a replacement.
  void Release(const PeerText& p_peer, const target_wire::Packet& p_packet,
               double p_now)
  {
    for (auto& slot : slots_)
    {
      if (slot->active_ && slot->peer_ == p_peer &&
          slot->session_ == p_packet.session_)
      {
        Retire(slot->peer_, slot->session_);
        slot->monitor_.Close();
        slot->resources_.Drain(p_now, true);
        slot->active_ = false;
        slot->visible_ = false;
      }
    }
    // Later ticks of the released session must not take a slot again.
    if (!IsRetired(p_peer, p_packet.session_))
    {
      Retire(p_peer, p_packet.session_);
    }
  }

  // Frees every slot whose sampler has been silent for longer than
  // target_idle_expiry_s, so a replaced or removed target does not hold its
  // slot forever. The recorder is not stopped or joined: a reused slot moves
  // it with SetRoot, and an unused one waits idle. Called from the periodic
  // refresh, never from the datagram path.
  void ReleaseIdle(double p_now)
  {
    for (auto& slot : slots_)
    {
      if (slot->active_ &&
          p_now - slot->last_seen_ > config_.target_idle_expiry_s_)
      {
        slot->monitor_.Close();
        slot->resources_.Drain(p_now, true);
        slot->active_ = false;
        slot->visible_ = false;
      }
    }
  }

  // The one slot that records into data_dir/replay, or null. Recordings made
  // before targets existed live there and belong to the "default" target of
  // one fixed sender: the smallest address in sampler_ips, or the pinned
  // sender when the list is empty (no other sender is accepted). If several
  // hosts behind that address announce "default", the smallest host name wins.
  // Only the current identity counts, so it is recomputed when TTGT renames a
  // provisional slot and never depends on arrival order.
  [[nodiscard]] const TargetSlot* LegacyOwner() const
  {
    const std::string_view sender =
        config_.sampler_ips_.empty()
            ? (pinned_ ? pinned_->View() : std::string_view{})
            : std::string_view{*std::ranges::min_element(config_.sampler_ips_)};
    const TargetSlot* owner = nullptr;
    for (const auto& slot : slots_)
    {
      if (slot->active_ && slot->visible_ && slot->id_.View() == "default" &&
          slot->peer_.View() == sender &&
          (!owner || slot->host_.View() < owner->host_.View()))
      {
        owner = slot.get();
      }
    }
    return owner;
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
    // Set when a legacy sender's session was replaced by another session.
    bool inferred_ = false;
  };
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
  void Retire(const PeerText& p_peer, std::uint64_t p_session,
              bool p_inferred = false)
  {
    retired_[retired_position_++ % retired_.size()] = {p_peer, p_session,
                                                       p_inferred};
  }
  // A TTGT proves a session that legacy routing retired is a real target.
  [[nodiscard]] bool Recover(const PeerText& p_peer, std::uint64_t p_session)
  {
    const auto found = std::ranges::find_if(
        retired_,
        [&](const Retired& p_retired)
        {
          return p_retired.inferred_ && p_retired.session_ == p_session &&
                 p_retired.peer_ == p_peer;
        });
    if (found == retired_.end())
    {
      return false;
    }
    *found = {};
    return true;
  }
};

}  // namespace triangulator::collector
