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
  std::uint32_t pid_ = 0;
  std::string peer_;
  std::uint8_t flags_ = 0;  // target_wire flags of the last announcement
  bool local_ = false;      // its packets come from a loopback address
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

  void PublishTargets(std::vector<PublishedTarget> p_targets,
                      Json p_description)
  {
    std::ranges::sort(p_targets, {}, &PublishedTarget::key_);
    std::lock_guard lock{mutex_};
    RetainReleased(p_targets);
    descriptions_ = p_description;
    for (const auto& archived : archived_)
    {
      p_description.Find("targets")->AsArray().push_back(archived.description_);
    }
    fleet_targets_json_ =
        std::make_shared<const std::string>(DumpJson(p_description));
    targets_ = std::move(p_targets);
    targets_json_ =
        std::make_shared<const std::string>(DumpJson(descriptions_));
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
    if (!p_key.empty())
    {
      for (const auto& archived : archived_)
      {
        if (archived.target_.key_ == p_key)
        {
          return archived.target_;
        }
      }
    }
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

  // The number of published targets, which hold the collector's slots.
  [[nodiscard]] std::size_t TargetCount()
  {
    std::lock_guard lock{mutex_};
    return targets_.size();
  }

  [[nodiscard]] std::shared_ptr<const std::string> Targets()
  {
    std::lock_guard lock{mutex_};
    return targets_json_;
  }

  // The target list and each target's live view from one publication, so
  // the fleet overview needs one request, not one for each target.
  struct FleetView
  {
    std::shared_ptr<const std::string> targets_;
    std::vector<std::pair<std::string, std::shared_ptr<const std::string>>>
        live_;
  };
  [[nodiscard]] FleetView Fleet()
  {
    std::lock_guard lock{mutex_};
    FleetView fleet{.targets_ = fleet_targets_json_, .live_ = {}};
    fleet.live_.reserve(targets_.size() + archived_.size());
    for (const auto& archived : archived_)
    {
      fleet.live_.emplace_back(archived.target_.key_, archived.target_.live_);
    }
    for (const auto& target : targets_)
    {
      fleet.live_.emplace_back(target.key_, target.live_);
    }
    return fleet;
  }

 private:
  struct ArchivedTarget
  {
    PublishedTarget target_;
    Json description_;
  };

  // Keep final views separately so process churn can release all live slots.
  // The oldest entries expire first; a returning key replaces its old view.
  void RetainReleased(const std::vector<PublishedTarget>& p_next)
  {
    constexpr std::size_t kMaxArchivedTargets = 64;
    const auto returning = [&](const PublishedTarget& p_target)
    {
      return std::ranges::find(p_next, p_target.key_, &PublishedTarget::key_) !=
             p_next.end();
    };
    std::erase_if(archived_,
                  [&](const ArchivedTarget& p_archived)
                  {
                    return returning(p_archived.target_);
                  });
    for (const auto& target : targets_)
    {
      if (returning(target))
      {
        continue;
      }
      for (const auto& description : descriptions_.Find("targets")->AsArray())
      {
        if (description.Find("key")->AsString() != target.key_)
        {
          continue;
        }
        auto archived = ArchivedTarget{target, description};
        archived.target_.local_ = false;
        archived.target_.watches_.reset();
        archived.description_.Set("archived", true);
        archived.description_.Set("local", false);
        archived.description_.Set("name_selected", false);
        archived.description_.Set("other_rule_selected", false);
        if (archived_.size() == kMaxArchivedTargets)
        {
          archived_.erase(archived_.begin());
        }
        archived_.push_back(std::move(archived));
        break;
      }
    }
  }

  std::mutex mutex_;
  std::vector<ArchivedTarget> archived_;
  Json descriptions_{JsonObject{{"targets", JsonArray{}}}};
  std::vector<PublishedTarget> targets_;
  std::shared_ptr<const std::string> fleet_targets_json_ =
      std::make_shared<const std::string>(R"({"targets":[]})");
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
