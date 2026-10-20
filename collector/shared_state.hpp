#pragma once

#include <algorithm>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "json.hpp"

namespace triangulator::collector
{

struct PublishedTarget
{
  std::string key_;
  std::string host_;
  std::string id_;
  std::filesystem::path replay_root_;
  std::shared_ptr<const std::string> live_;
  std::shared_ptr<const std::string> last_target_;
  std::shared_ptr<const std::string> memory_map_;
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

  // A removal names the target and the time the sampler confirmed it. The
  // collector retires only sessions first seen at or before that time, so a
  // target added again before the next refresh keeps its new session.
  struct Removal
  {
    std::string key_;
    double at_ = 0;
  };
  [[nodiscard]] bool QueueRemoval(std::string p_key, double p_at)
  {
    std::lock_guard lock{mutex_};
    if (removals_.size() >= 64)
    {
      return false;
    }
    removals_.push_back({std::move(p_key), p_at});
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
