#pragma once

#include <cstdint>
#include <optional>

#include "../common/target_wire.hpp"
#include "engine.hpp"
#include "exits.hpp"
#include "ingest.hpp"
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
  TargetSlot(const Config& p_config, double p_now, Storage& p_storage,
             StorageSink& p_sink)
      : config_(p_config),
        monitor_(config_, p_now, p_sink),
        resources_(p_sink),
        recorder_(p_config.data_dir_, p_config.retention_days_,
                  p_config.replay_interval_s_),
        ingest_(p_config.sampler_ips_, monitor_, resources_, memory_, exits_,
                process_, p_storage, p_sink)
  {
  }

  Config config_;
  Monitor monitor_;
  ResourceMonitor resources_;
  MemoryMonitor memory_;
  ExitMonitor exits_;
  ProcessMonitor process_;
  SnapshotRecorder recorder_;
  Ingest ingest_;
  SharedState state_;
  bool active_ = false;
  bool visible_ = false;
  bool dirty_ = true;
  bool reset_view_ = false;
  TargetSlot* previous_view_ = nullptr;
  PeerText peer_;
  FixedText<64> host_;
  FixedText<32> id_;
  std::uint64_t session_ = 0;
  target_wire::Packet announcement_{};
  bool announced_ = false;
  double first_seen_ = 0;
  double last_seen_ = 0;
  double next_health_ = 0;
  bool mapping_dirty_ = false;
  std::filesystem::path replay_root_;
  bool recorder_started_ = false;
  std::optional<Json> last_target_;
  std::uint64_t published_layout_ = 0;
};

}  // namespace triangulator::collector
