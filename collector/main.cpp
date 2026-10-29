// Triangulator UDP collector and dashboard: the core collector. It decodes
// the sampler's datagrams, writes per-thread SQLite rollups and serves the
// dashboard and HTTP API. It does no alerting: alert rules and delivery
// belong in a separate program that reads the rollups or the HTTP API.

#include <poll.h>
#include <signal.h>
#include <sys/socket.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <exception>
#include <filesystem>
#include <format>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>

#include "config.hpp"
#include "engine.hpp"
#include "exits.hpp"
#include "http.hpp"
#include "ingest.hpp"
#include "json.hpp"
#include "log.hpp"
#include "protocol.hpp"
#include "replay.hpp"
#include "resources.hpp"
#include "storage.hpp"
#include "target_fleet.hpp"
#include "target_watches.hpp"
#include "watch.hpp"

namespace
{

using namespace triangulator::collector;

std::atomic<bool> g_stopped = false;

void HandleStopSignal(int)
{
  g_stopped = true;
}

[[noreturn]] void Usage(std::string_view p_message)
{
  std::fprintf(stderr,
               "usage: triangulator-collector [-h] [--check-config] config\n"
               "triangulator-collector: error: %.*s\n",
               static_cast<int>(p_message.size()), p_message.data());
  std::exit(2);
}

int Stopped(std::string_view p_reason)
{
  Log(LogLevel::Error, std::format("Collector stopped: {}", p_reason));
  return 1;
}

// Saves what was collected when an exception (a bug, or one from the
// standard library) leaves Run() on its way to main's last-resort handler.
// Without it the open transaction would roll back, losing the rows since
// the last flush and every unfinished window. A normal return shuts down
// explicitly instead, so storage errors can be reported; this does nothing
// then. Errors here are ignored: the exception is what gets reported.
class SaveOnUnwind
{
 public:
  SaveOnUnwind(DashboardServer& p_server, TargetFleet& p_fleet,
               Storage& p_storage) noexcept
      : server_(p_server), fleet_(p_fleet), storage_(p_storage)
  {
  }
  SaveOnUnwind(const SaveOnUnwind&) = delete;
  SaveOnUnwind& operator=(const SaveOnUnwind&) = delete;

  ~SaveOnUnwind()
  {
    if (std::uncaught_exceptions() <= exceptions_)
    {
      return;
    }
    server_.Stop();
    fleet_.Close();
    static_cast<void>(storage_.Close());
  }

 private:
  DashboardServer& server_;
  TargetFleet& fleet_;
  Storage& storage_;
  int exceptions_ = std::uncaught_exceptions();
};

int Run(const std::filesystem::path& p_config_path, bool p_check_config)
{
  auto loaded = LoadConfig(p_config_path);
  if (!loaded)
  {
    Usage(loaded.error());
  }
  const Config config = std::move(*loaded);
  if (p_check_config)
  {
    std::puts("Collector configuration is valid");
    return 0;
  }
  if (config.alerting_ignored_)
  {
    Log(LogLevel::Warning,
        "Alerting is not part of the C++ collector; alert thresholds, "
        "webhook_url, deadman_url and [alerts.smtp] are ignored");
  }

  // Bind the UDP socket first. The kernel then queues the datagrams that
  // arrive while storage and the target slots start, instead of dropping
  // them. A sampler sends an unchanged memory layout again only every ten
  // memory samples (at least once a minute), so a lost first layout leaves
  // /api/memory-map empty for that long.
  auto bound = BindSocket(config.udp_host_, config.udp_port_, SOCK_DGRAM);
  if (!bound)
  {
    return Stopped(bound.error());
  }
  const triangulator::FileDescriptor receiver = std::move(*bound);
  const int buffer_size = 4 * 1024 * 1024;
  ::setsockopt(receiver.Get(), SOL_SOCKET, SO_RCVBUF, &buffer_size,
               sizeof(buffer_size));
  auto created = Storage::Create(config.data_dir_, config.retention_days_);
  if (!created)
  {
    return Stopped(created.error());
  }
  Storage storage = std::move(*created);
  if (auto flushed = storage.Flush(WallNow()); !flushed)
  {
    return Stopped(flushed.error());
  }
  auto watches =
      std::make_shared<WatchSettings>(config.watches_, config.data_dir_);
  TargetWatches target_watches{config, watches};
  if (const auto startup = watches->Current(); startup->saved_error_)
  {
    Log(LogLevel::Warning,
        std::format("Ignoring the watch rules saved from the dashboard, so "
                    "the [[watch]] rules in the config file apply: {}",
                    *startup->saved_error_));
  }
  else if (startup->source_ == WatchSource::Dashboard)
  {
    Log(LogLevel::Info,
        std::format("Using the watch rules saved from the dashboard in {}; "
                    "the [[watch]] rules in the config file apply after a "
                    "reset",
                    watches->Path().string()));
  }
  StorageSink sink{storage};
  TargetFleet fleet{config, WallNow(), storage, sink};
  SharedState state;
  auto listener = Listen(config.http_host_, config.http_port_);
  if (!listener)
  {
    return Stopped(listener.error());
  }
  DashboardServer server{config, state, watches, std::move(*listener)};
  if (auto started = server.Start(); !started)
  {
    return Stopped(started.error());
  }

  struct sigaction action{};
  action.sa_handler = HandleStopSignal;
  ::sigaction(SIGINT, &action, nullptr);
  ::sigaction(SIGTERM, &action, nullptr);
  ::signal(SIGPIPE, SIG_IGN);

  auto next_refresh = std::chrono::steady_clock::time_point{};
  Log(LogLevel::Info,
      std::format("UDP {}:{}; dashboard http://{}:{}", config.udp_host_,
                  config.udp_port_, config.http_host_, config.http_port_));
  // One byte more than the largest datagram (resource_wire::kMaxPartSize,
  // 1400).
  std::array<std::byte, 1501> buffer{};
  const SaveOnUnwind save_on_unwind{server, fleet, storage};
  // The first storage failure. It stops the loop: rows that can't be saved
  // shouldn't be dropped silently.
  SqliteResult storage_ok;
  while (!g_stopped && storage_ok)
  {
    pollfd ready{receiver.Get(), POLLIN, 0};
    ssize_t length = -1;
    sockaddr_storage peer{};
    if (::poll(&ready, 1, 200) > 0)
    {
      socklen_t peer_length = sizeof(peer);
      length = ::recvfrom(receiver.Get(), buffer.data(), buffer.size(), 0,
                          reinterpret_cast<sockaddr*>(&peer), &peer_length);
    }
    const double now = WallNow();
    if (length >= 0)
    {
      storage_ok = fleet.Handle(
          std::span{buffer.data(), static_cast<std::size_t>(length)},
          PeerAddress(peer), now);
    }
    if (storage_ok && std::chrono::steady_clock::now() >= next_refresh)
    {
      for (const auto& removal : state.TakeRemovals())
      {
        fleet.Remove(removal.key_, removal.sessions_);
      }
      std::vector<PublishedTarget> published;
      JsonArray descriptions;
      fleet.ReleaseIdle(now);
      const TargetSlot* const legacy_owner = fleet.LegacyOwner();
      for (auto& owned : fleet.Slots())
      {
        auto& slot = *owned;
        if (!slot.active_ || !slot.visible_)
        {
          continue;
        }
        const auto key =
            std::format("{}/{}", slot.host_.View(), slot.id_.View());
        if (slot.reset_view_)
        {
          // The writer keeps running: SetRoot below moves it without a join.
          slot.recorder_started_ = false;
          slot.replay_root_.clear();
          slot.published_watches_.reset();
          slot.last_target_.reset();
          slot.last_body_.reset();
          slot.last_metadata_.reset();
          slot.published_layout_ = 0;
          slot.state_.SetLastTarget(
              std::make_shared<const std::string>(R"({"available":false})"));
          slot.state_.SetMemoryMap(
              std::make_shared<const std::string>(R"({"available":false})"));
          slot.reset_view_ = false;
        }
        if (slot.previous_body_ && slot.previous_metadata_)
        {
          slot.last_body_ = std::move(slot.previous_body_);
          slot.last_metadata_ = slot.previous_metadata_;
          const auto& metadata = *slot.previous_metadata_;
          slot.last_target_ =
              JsonObject{{"session", metadata.session_.View()},
                         {"pid", metadata.pid_},
                         {"recorded_at", metadata.recorded_at_}};
          slot.state_.SetLastTarget(slot.last_body_);
          slot.previous_metadata_.reset();
        }
        // One slot at most owns the data from before targets existed (see
        // TargetFleet::LegacyOwner): data_dir/replay, unmapped history, and
        // data_dir/watch-rules.json. Ownership, the recording root, and the
        // recording interval are checked on every refresh, so a TTGT that
        // renames a provisional slot moves its recorder and applies the new
        // identity's interval.
        const bool owns_legacy = &slot == legacy_owner;
        slot.legacy_replay_ = owns_legacy;
        slot.watches_ = target_watches.Get(key, owns_legacy);
        const auto watch_state =
            slot.watches_ ? slot.watches_->Current() : nullptr;
        if (watch_state != slot.published_watches_)
        {
          slot.dirty_ = true;
        }
        const auto root = owns_legacy ? std::filesystem::path{config.data_dir_}
                                      : TargetDataRoot(config.data_dir_, key);
        if (root != slot.replay_root_)
        {
          slot.recorder_.SetRoot(root);
          slot.replay_root_ = root;
        }
        const double interval_s =
            ReplayInterval(config, slot.host_.View(), slot.id_.View());
        if (!slot.recorder_started_ ||
            interval_s != slot.config_.replay_interval_s_)
        {
          // Start returns at once when the writer already runs or the
          // interval is zero. Nothing here stops or joins the writer.
          slot.config_.replay_interval_s_ = interval_s;
          slot.recorder_.SetInterval(interval_s);
          if (auto started = slot.recorder_.Start(); !started)
          {
            return Stopped(started.error());
          }
          slot.recorder_started_ = true;
          slot.dirty_ = true;
        }
        auto& monitor = slot.monitor_;
        auto& resources = slot.resources_;
        auto& memory = slot.memory_;
        auto& exits = slot.exits_;
        auto& process = slot.process_;
        auto& recorder = slot.recorder_;
        auto& state_view = slot.state_;
        auto& published_layout = slot.published_layout_;
        auto& last_target = slot.last_target_;
        auto health_summary = monitor.Health(now);
        const auto& announced = slot.announcement_;
        const bool throttled =
            slot.announced_ &&
            announced.effective_millihz_ < announced.configured_millihz_;
        const auto* silent = health_summary.Find("sampler_silent");
        const auto* absent_summary = health_summary.Find("target_absent");
        const std::string_view status = silent && silent->AsBool() ? "silent"
                                        : absent_summary &&
                                                absent_summary->IsBool() &&
                                                absent_summary->AsBool()
                                            ? "absent"
                                            : "live";
        const auto process_summary = process.Snapshot();
        const auto* process_start = process_summary.Find("process_start");
        storage.RememberTarget(
            slot.session_, slot.host_.View(), slot.id_.View(),
            slot.announced_ ? announced.pid_
                            : static_cast<std::uint32_t>(
                                  health_summary.Find("pid")->AsInt()),
            slot.announced_ ? announced.process_start_
            : process_start && process_start->IsNumber()
                ? static_cast<std::uint64_t>(process_start->AsInt())
                : 0,
            slot.first_seen_);
        descriptions.emplace_back(JsonObject{
            {"key", key},
            {"host", slot.host_.View()},
            {"id", slot.id_.View()},
            {"pid", *health_summary.Find("pid")},
            {"session", std::to_string(slot.session_)},
            {"process", process_summary},
            {"status", status},
            {"access",
             announced.access_ == triangulator::target_wire::Access::Limited
                 ? "limited"
                 : "full"},
            {"sampler_cpu_pct",
             announced.elapsed_ns_ == 0
                 ? Json()
                 : Json(100.0 * static_cast<double>(announced.cpu_ns_) /
                        static_cast<double>(announced.elapsed_ns_))},
            {"effective_rate_hz",
             static_cast<double>(announced.effective_millihz_) / 1000},
            {"configured_rate_hz",
             static_cast<double>(announced.configured_millihz_) / 1000},
            {"throttled", throttled},
            {"cpu_budget_pct",
             static_cast<double>(announced.budget_basis_points_) / 100},
            {"throttle_reason",
             throttled ? Json("Sampler CPU use exceeded its configured budget")
                       : Json()},
            {"local", IsLoopback(slot.peer_.View())},
            {"name_selected", (announced.flags_ &
                               triangulator::target_wire::kNameSelected) != 0},
            {"pattern_selected",
             (announced.flags_ & triangulator::target_wire::kPatternSelected) !=
                 0},
            {"rule",
             (announced.flags_ & triangulator::target_wire::kNameSelected) != 0
                 ? Json(std::string{triangulator::target_wire::RuleName(
                       slot.id_.View(), announced.flags_)})
                 : Json()},
            {"excluded", static_cast<std::int64_t>(announced.excluded_)}});
        // A timer refresh changes health at silence thresholds without
        // rebuilding every target snapshot on every collector refresh.
        if (slot.dirty_ || now >= slot.next_health_ ||
            now - slot.last_seen_ < 1.0)
        {
          auto health = monitor.Health(now);
          auto live = monitor.Snapshot(
              now, watch_state ? watch_state->rules_ : config.watches_);
          const auto* absent = health.Find("target_absent");
          // A view of the target needs its threads. When a new sampler session
          // starts, the Monitor drops the old threads at once but reports
          // target_absent only after the new session's first tick is processed,
          // so a view without threads can still say the target is present.
          const bool target_view = absent->IsBool() && !absent->AsBool() &&
                                   !live.Find("threads")->AsArray().empty();
          if (target_view)
          {
            slot.last_metadata_ = LastTargetMetadata{
                FixedText<24>{health.Find("session")->AsString()},
                static_cast<std::uint32_t>(health.Find("pid")->AsInt()), now};
            last_target = JsonObject{{"session", *health.Find("session")},
                                     {"pid", *health.Find("pid")},
                                     {"recorded_at", now}};
          }
          else if (absent->IsBool() && absent->AsBool() && last_target)
          {
            // Tells the dashboard which view /api/last-target holds.
            health.Set("last_target", *last_target);
          }
          health.Set("sampler_ip", slot.ingest_.SamplerIp()
                                       ? Json(slot.ingest_.SamplerIp()->View())
                                       : Json(nullptr));
          live.Set("health", std::move(health));
          resources.Drain(now);
          live.Set("resources", resources.Snapshot(now));
          live.Set("memory", memory.Snapshot(now));
          live.Set("exit", exits.Snapshot());
          live.Set("process", process.Snapshot());
          if (memory.LayoutVersion() != published_layout)
          {
            published_layout = memory.LayoutVersion();
            state_view.SetMemoryMap(
                std::make_shared<const std::string>(DumpJson(memory.Layout())));
          }
          live.Set("target", key);
          live.Set("recorded_at", now);
          live.Set("recording_interval_s", slot.config_.replay_interval_s_);
          auto body = std::make_shared<const std::string>(DumpJson(live));
          if (live.Find("health")->Find("session")->IsString())
          {
            recorder.Offer(now, body);
          }
          if (target_view)
          {
            slot.last_body_ = body;
            state_view.SetLastTarget(body);
          }
          state_view.SetLive(std::move(body));
          slot.published_watches_ = watch_state;
          slot.dirty_ = false;
          slot.next_health_ = now + 10;
        }
        published.push_back(
            {key, std::string{slot.host_.View()}, std::string{slot.id_.View()},
             slot.session_, slot.replay_root_, slot.state_.Live(),
             slot.state_.LastTarget(), slot.state_.MemoryMap(), slot.watches_,
             slot.config_.replay_interval_s_, slot.legacy_replay_, slot.pid_,
             std::string{slot.peer_.View()}, slot.announcement_.flags_,
             IsLoopback(slot.peer_.View())});
      }
      if (published.empty())
      {
        auto& idle = *fleet.Slots().front();
        auto health = idle.monitor_.Health(now);
        health.Set("bad_packets",
                   static_cast<std::int64_t>(fleet.bad_packets_) +
                       idle.monitor_.bad_packets_);
        health.Set("sampler_ip", idle.ingest_.SamplerIp()
                                     ? Json(idle.ingest_.SamplerIp()->View())
                                     : Json());
        auto live = idle.monitor_.Snapshot(now, watches->Current()->rules_);
        live.Set("health", std::move(health));
        live.Set("resources", idle.resources_.Snapshot(now));
        live.Set("memory", idle.memory_.Snapshot(now));
        live.Set("exit", idle.exits_.Snapshot());
        live.Set("process", idle.process_.Snapshot());
        live.Set("recorded_at", now);
        live.Set("recording_interval_s", config.replay_interval_s_);
        state.SetLive(std::make_shared<const std::string>(DumpJson(live)));
      }
      state.PublishTargets(std::move(published),
                           JsonObject{{"targets", std::move(descriptions)},
                                      {"bad_packets", fleet.bad_packets_},
                                      {"capacity_drops", fleet.capacity_drops_},
                                      {"max_targets", config.max_targets_},
                                      {"watch_settings_limit_hits",
                                       target_watches.limit_hits_}});
      storage_ok = sink.Status();
      if (storage_ok)
      {
        storage_ok = storage.Flush(now);
      }
      next_refresh =
          std::chrono::steady_clock::now() + std::chrono::milliseconds{500};
    }
  }
  server.Stop();
  fleet.Close();
  if (storage_ok)
  {
    storage_ok = sink.Status();
  }
  // Close even after a failure, so rows from other day files still commit.
  const auto closed = storage.Close();
  if (!storage_ok)
  {
    return Stopped(storage_ok.error());
  }
  if (!closed)
  {
    return Stopped(closed.error());
  }
  return 0;
}

}  // namespace

int main(int p_argc, char** p_argv)
{
  std::optional<std::filesystem::path> config_path;
  bool check_config = false;
  for (int index = 1; index < p_argc; ++index)
  {
    const std::string_view argument = p_argv[index];
    if (argument == "--check-config")
    {
      check_config = true;
    }
    else if (argument == "-h" || argument == "--help")
    {
      std::puts(
          "usage: triangulator-collector [-h] [--check-config] config\n\n"
          "Triangulator UDP collector and dashboard (C++)");
      return 0;
    }
    else if (argument.starts_with('-') || config_path)
    {
      Usage(std::format("unrecognized arguments: {}", argument));
    }
    else
    {
      config_path = argument;
    }
  }
  if (!config_path)
  {
    Usage("the following arguments are required: config");
  }
  try
  {
    return Run(*config_path, check_config);
  }
  catch (const std::exception& error)
  {
    // Last resort for a bug or an exception from the standard library.
    return Stopped(error.what());
  }
}
