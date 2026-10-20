#pragma once

#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <format>
#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>

#include "config.hpp"
#include "log.hpp"
#include "replay.hpp"
#include "watch.hpp"

namespace triangulator::collector
{

// Load saved files at startup. A newly discovered target can then obtain its
// settings during a snapshot refresh without file I/O in the collector loop.
class TargetWatches final
{
 public:
  TargetWatches(const Config& p_config,
                std::shared_ptr<WatchSettings> p_default)
      : config_(p_config), default_(std::move(p_default))
  {
    const auto directory =
        std::filesystem::path{p_config.data_dir_} / "watch-rules";
    std::error_code error;
    std::filesystem::create_directories(directory, error);
    if (error)
    {
      Log(LogLevel::Warning, std::format("Cannot create {}: {}",
                                         directory.string(), error.message()));
      return;
    }
    std::filesystem::directory_iterator entry{directory, error};
    std::size_t count = 0;
    for (; !error && entry != std::filesystem::directory_iterator{} &&
           count < kMaxFiles;
         entry.increment(error), ++count)
    {
      const auto filename = entry->path().filename().string();
      const auto stem = entry->path().stem().string();
      if (!filename.ends_with(".json") || stem.empty() || stem.size() > 190 ||
          !std::ranges::all_of(
              stem,
              [](char p_character)
              {
                return (p_character >= '0' && p_character <= '9') ||
                       (p_character >= 'a' && p_character <= 'f');
              }))
      {
        continue;
      }
      settings_.emplace(filename, std::make_shared<WatchSettings>(
                                      p_config.watches_, directory, filename));
    }
    if (entry != std::filesystem::directory_iterator{})
    {
      ++limit_hits_;
    }
  }

  [[nodiscard]] std::shared_ptr<WatchSettings> Get(std::string_view p_key,
                                                   std::string_view p_id,
                                                   std::string_view p_peer)
  {
    // The first configured sender owns the legacy default file. With source
    // pinning there is only one sampler host, so the old path stays stable.
    if (p_id == "default" && (config_.sampler_ips_.empty() ||
                              config_.sampler_ips_.front() == p_peer))
    {
      return default_;
    }
    const auto filename =
        TargetDataRoot(config_.data_dir_, p_key).filename().string() + ".json";
    if (const auto found = settings_.find(filename); found != settings_.end())
    {
      return found->second;
    }
    if (settings_.size() == kMaxFiles)
    {
      ++limit_hits_;
      return {};
    }
    auto settings = std::make_shared<WatchSettings>(
        config_.watches_,
        std::filesystem::path{config_.data_dir_} / "watch-rules", filename,
        false);
    settings_.emplace(filename, settings);
    return settings;
  }

  std::uint64_t limit_hits_ = 0;

 private:
  static constexpr std::size_t kMaxFiles = 1024;
  const Config& config_;
  std::shared_ptr<WatchSettings> default_;
  std::map<std::string, std::shared_ptr<WatchSettings>> settings_;
};

}  // namespace triangulator::collector
