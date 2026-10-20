#pragma once

#include <memory>
#include <mutex>
#include <string>

namespace triangulator::collector
{

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

 private:
  std::mutex mutex_;
  std::shared_ptr<const std::string> live_ =
      std::make_shared<const std::string>("{}");
  std::shared_ptr<const std::string> last_target_ =
      std::make_shared<const std::string>(R"({"available":false})");
  std::shared_ptr<const std::string> memory_map_ =
      std::make_shared<const std::string>(R"({"available":false})");
};

}  // namespace triangulator::collector
