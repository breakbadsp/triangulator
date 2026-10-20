#pragma once

#include <cstdint>
#include <optional>

#include "engine.hpp"
#include "exits.hpp"
#include "memory.hpp"
#include "process.hpp"
#include "replay.hpp"
#include "resources.hpp"
#include "shared_state.hpp"

namespace triangulator::collector
{

// Owns the state of one target. Storage and its sink remain shared.
struct TargetSlot
{
  TargetSlot(const Config& p_config, double p_now, StorageSink& p_sink)
      : monitor_(p_config, p_now, p_sink),
        resources_(p_sink),
        recorder_(p_config.data_dir_, p_config.retention_days_,
                  p_config.replay_interval_s_)
  {
  }

  Monitor monitor_;
  ResourceMonitor resources_;
  MemoryMonitor memory_;
  ExitMonitor exits_;
  ProcessMonitor process_;
  SnapshotRecorder recorder_;
  SharedState state_;
  std::optional<Json> last_target_;
  std::uint64_t published_layout_ = 0;
};

}  // namespace triangulator::collector
