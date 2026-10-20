#pragma once

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "json.hpp"

namespace triangulator::collector
{

class WatchSettings;
struct WatchState;

struct PublishedTarget
{
  std::string key_;
  std::string host_;
  std::string id_;
  std::uint64_t session_ = 0;
  std::filesystem::path replay_root_;
  std::shared_ptr<const std::string> live_;
  std::shared_ptr<const std::string> last_target_;
  std::shared_ptr<const std::string> memory_map_;
  std::shared_ptr<WatchSettings> watches_;
  double replay_interval_s_ = 1;
  bool legacy_replay_ = false;
  std::optional<std::string> socket_observer_;
  std::uint32_t pid_ = 0;
  std::string peer_;
};

// The latest /api/live, /api/last-target and /api/memory-map payloads,
// written by the main loop and read by the dashboard thread.
class SharedState
{
 public:
  void SetLive(std::shared_ptr<const std::string> p_live)
  {
    std::lock_guard lock{mutex_};
    live_ = std::move(p_live);
  }
  [[nodiscard]] std::shared_ptr<const std::string> Live()
  {
    std::lock_guard lock{mutex_};
    return live_;
  }
  // The last live view in which the target was present with its threads.
  // It outlives the target, so the dashboard can show it after the target
  // exits.
  void SetLastTarget(std::shared_ptr<const std::string> p_view)
  {
    std::lock_guard lock{mutex_};
    last_target_ = std::move(p_view);
  }
  [[nodiscard]] std::shared_ptr<const std::string> LastTarget()
  {
    std::lock_guard lock{mutex_};
    return last_target_;
  }
  void SetMemoryMap(std::shared_ptr<const std::string> p_memory_map)
  {
    std::lock_guard lock{mutex_};
    memory_map_ = std::move(p_memory_map);
  }
  [[nodiscard]] std::shared_ptr<const std::string> MemoryMap()
  {
    std::lock_guard lock{mutex_};
    return memory_map_;
  }

  // The sessions currently published for a target ID, on any host. A removal
  // request takes them before it asks the sampler, so it names exactly the
  // sessions the operator saw.
  [[nodiscard]] std::vector<std::uint64_t> SessionsForId(std::string_view p_id)
  {
    std::lock_guard lock{mutex_};
    std::vector<std::uint64_t> sessions;
    for (const auto& target : targets_)
    {
      if (target.id_ == p_id)
      {
        sessions.push_back(target.session_);
      }
    }
    return sessions;
  }

  // True when a published target other than p_key has the PID p_pid. Stored
  // socket observations carry no sender, so they belong to one target only
  // when its PID is unique.
  [[nodiscard]] bool PidShared(std::string_view p_key, std::uint32_t p_pid)
  {
    std::lock_guard lock{mutex_};
    return std::ranges::any_of(targets_,
                               [&](const PublishedTarget& p_target)
                               {
                                 return p_target.key_ != p_key &&
                                        p_target.pid_ == p_pid;
                               });
  }

  // A removal names the target and the sessions that were published when the
  // operator asked. The collector retires only those sessions, so a target
  // added again with the same ID keeps its new session, however late the
  // refresh runs.
  struct Removal
  {
    std::string key_;
    std::vector<std::uint64_t> sessions_;
  };
  [[nodiscard]] bool QueueRemoval(std::string p_key,
                                  std::vector<std::uint64_t> p_sessions)
  {
    std::lock_guard lock{mutex_};
    if (removals_.size() >= 64)
    {
      return false;
    }
    removals_.push_back({std::move(p_key), std::move(p_sessions)});
    return true;
  }
  [[nodiscard]] std::vector<Removal> TakeRemovals()
  {
    std::lock_guard lock{mutex_};
    return std::exchange(removals_, {});
  }
  void PublishTargets(std::vector<PublishedTarget> p_targets,
                      Json p_description)
  {
    std::ranges::sort(p_targets, {}, &PublishedTarget::key_);
    std::lock_guard lock{mutex_};
    targets_ = std::move(p_targets);
    targets_json_ =
        std::make_shared<const std::string>(DumpJson(p_description));
    if (!targets_.empty())
    {
      auto selected =
          std::ranges::find(targets_, "default", &PublishedTarget::id_);
      const auto& target =
          selected == targets_.end() ? targets_.front() : *selected;
      live_ = target.live_;
      last_target_ = target.last_target_;
      memory_map_ = target.memory_map_;
    }
  }

  [[nodiscard]] std::optional<PublishedTarget> Select(std::string_view p_key)
  {
    std::lock_guard lock{mutex_};
    if (targets_.empty())
    {
      return std::nullopt;
    }
    if (p_key.empty())
    {
      auto found =
          std::ranges::find(targets_, "default", &PublishedTarget::id_);
      return found == targets_.end() ? targets_.front() : *found;
    }
    const auto found =
        std::ranges::find(targets_, p_key, &PublishedTarget::key_);
    return found == targets_.end() ? std::nullopt : std::optional{*found};
  }

  [[nodiscard]] std::shared_ptr<const std::string> Targets()
  {
    std::lock_guard lock{mutex_};
    return targets_json_;
  }

 private:
  std::mutex mutex_;
  std::vector<PublishedTarget> targets_;
  std::vector<Removal> removals_;
  std::shared_ptr<const std::string> targets_json_ =
      std::make_shared<const std::string>(R"({"targets":[]})");
  std::shared_ptr<const std::string> live_ =
      std::make_shared<const std::string>("{}");
  std::shared_ptr<const std::string> last_target_ =
      std::make_shared<const std::string>(R"({"available":false})");
  std::shared_ptr<const std::string> memory_map_ =
      std::make_shared<const std::string>(R"({"available":false})");
};

}  // namespace triangulator::collector
