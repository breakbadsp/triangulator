#pragma once

// The bridge to triangulator-memory-report (docs/process-memory-map-design.md,
// section 9). A request queues a refresh and returns the cached report at
// once; one worker thread runs the helper, so a slow or failed report cannot
// delay anything else. Like the socket report, it is never in the UDP loop.
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <expected>
#include <filesystem>
#include <format>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <system_error>
#include <thread>

#include "log.hpp"
#include "report_process.hpp"

namespace triangulator::collector
{
class MemoryReportBridge
{
 public:
  // The live report is renewed at most this often.
  static constexpr auto kLiveRefresh = std::chrono::seconds{5};
  static constexpr std::size_t kMaxEntries = 8;

  explicit MemoryReportBridge(std::filesystem::path p_directory)
      : directory_(std::move(p_directory))
  {
  }
  ~MemoryReportBridge()
  {
    if (!worker_.joinable())
    {
      return;
    }
    {
      std::lock_guard lock{mutex_};
      worker_.request_stop();
    }
    ready_.notify_all();
    worker_.join();
  }
  MemoryReportBridge(const MemoryReportBridge&) = delete;
  MemoryReportBridge& operator=(const MemoryReportBridge&) = delete;

  [[nodiscard]] std::expected<void, std::string> Start()
  {
    try
    {
      worker_ = std::jthread(
          [this](std::stop_token p_stop)
          {
            Work(p_stop);
          });
    }
    catch (const std::system_error& error)
    {
      return std::unexpected(std::format(
          "cannot start the memory report thread: {}", error.what()));
    }
    return {};
  }

  // The report for p_pid (0: the newest process) at whole second p_at (0:
  // now). A report about the past never changes, so it is made once.
  [[nodiscard]] std::shared_ptr<const std::string> Request(std::uint32_t p_pid,
                                                           std::uint64_t p_at)
  {
    const Key key{p_pid, p_at};
    const auto now = std::chrono::steady_clock::now();
    std::lock_guard lock{mutex_};
    if (!entries_.contains(key) && entries_.size() == kMaxEntries)
    {
      entries_.erase(std::ranges::min_element(entries_, {},
                                              [](const auto& p_entry)
                                              {
                                                return p_entry.second.accessed_;
                                              }));
    }
    auto& entry = entries_[key];
    entry.accessed_ = now;
    const bool done = entry.response_ && p_at != 0;
    if (!entry.pending_ && !done && now >= entry.next_refresh_)
    {
      entry.pending_ = true;
      ready_.notify_one();
    }
    if (entry.response_)
    {
      return entry.response_;
    }
    static const auto kLoading = std::make_shared<const std::string>(
        R"({"available":false,"loading":true,"reason":"Starting the memory report…"})");
    return kLoading;
  }

 private:
  using Key = std::pair<std::uint32_t, std::uint64_t>;
  struct Entry
  {
    std::shared_ptr<const std::string> response_;
    std::chrono::steady_clock::time_point accessed_{};
    std::chrono::steady_clock::time_point next_refresh_{};
    bool pending_ = false;
    bool running_ = false;
  };

  void Work(std::stop_token p_stop)
  {
    const auto waiting = [](const auto& p_item)
    {
      return p_item.second.pending_ && !p_item.second.running_;
    };
    while (!p_stop.stop_requested())
    {
      Key key;
      {
        std::unique_lock lock{mutex_};
        ready_.wait(lock,
                    [&]
                    {
                      return p_stop.stop_requested() ||
                             std::ranges::any_of(entries_, waiting);
                    });
        if (p_stop.stop_requested())
        {
          return;
        }
        const auto found = std::ranges::find_if(entries_, waiting);
        key = found->first;
        found->second.running_ = true;
      }
      std::optional<std::string> report;
      try
      {
        const std::array<std::string, 3> arguments{directory_.string(),
                                                   std::to_string(key.first),
                                                   std::to_string(key.second)};
        report = RunReportHelper("triangulator-memory-report", arguments);
      }
      catch (const std::exception& error)
      {
        // Last resort for this unit of work: report the helper as unavailable.
        Log(LogLevel::Error,
            std::format("Memory report failed: {}", error.what()));
      }
      std::lock_guard lock{mutex_};
      const auto found = entries_.find(key);
      if (found == entries_.end())
      {
        continue;
      }
      auto& entry = found->second;
      if (report)
      {
        entry.response_ =
            std::make_shared<const std::string>(*std::move(report));
      }
      else if (!entry.response_)
      {
        // Without any earlier report the tab hides its findings panel.
        entry.response_ = std::make_shared<const std::string>(
            R"({"available":false,"helper_missing":true,"reason":"Install triangulator-memory-report next to the collector to see findings."})");
      }
      entry.pending_ = false;
      entry.running_ = false;
      entry.next_refresh_ = std::chrono::steady_clock::now() + kLiveRefresh;
    }
  }

  std::filesystem::path directory_;
  std::mutex mutex_;
  std::condition_variable ready_;
  std::map<Key, Entry> entries_;
  std::jthread worker_;
};

}  // namespace triangulator::collector
