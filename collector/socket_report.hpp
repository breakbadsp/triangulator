#pragma once

#include <algorithm>
#include <array>
#include <chrono>
#include <condition_variable>
#include <expected>
#include <filesystem>
#include <format>
#include <map>
#include <mutex>
#include <string>
#include <system_error>
#include <thread>

#include "../common/fd.hpp"
#include "../sampler/parsing.hpp"
#include "json.hpp"
#include "log.hpp"
#include "report_process.hpp"

namespace triangulator::collector
{
inline std::optional<std::string> RunSocketReport(
    const std::filesystem::path& p_directory, std::uint32_t p_pid,
    std::string_view p_observer)
{
  const std::array<std::string, 3> arguments{
      p_directory.string(), std::to_string(p_pid), std::string{p_observer}};
  return RunReportHelper("triangulator-socket-report", arguments);
}
// Cache at most eight query identities. A request queues a refresh and returns
// immediately; the dedicated worker owns helper execution and failure handling.
class SocketReportBridge
{
 public:
  explicit SocketReportBridge(std::filesystem::path p_directory)
      : directory_(std::move(p_directory))
  {
  }
  ~SocketReportBridge()
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
  SocketReportBridge(const SocketReportBridge&) = delete;
  SocketReportBridge& operator=(const SocketReportBridge&) = delete;

  // Starts the worker that runs the helper. std::jthread reports failure by
  // throwing; it is caught here and returned.
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
          "cannot start the socket report thread: {}", error.what()));
    }
    return {};
  }

  std::shared_ptr<const std::string> Request(std::uint32_t p_pid,
                                             std::string_view p_observer)
  {
    const Key key{p_pid, std::string{p_observer}};
    const auto now = std::chrono::steady_clock::now();
    std::lock_guard lock{mutex_};
    if (!entries_.contains(key) && entries_.size() == 8)
    {
      const auto oldest =
          std::ranges::min_element(entries_, {},
                                   [](const auto& p_entry)
                                   {
                                     return p_entry.second.accessed_;
                                   });
      entries_.erase(oldest);
    }
    auto& entry = entries_[key];
    entry.accessed_ = now;
    if (!entry.pending_ && now >= entry.next_refresh_)
    {
      entry.pending_ = true;
      ready_.notify_one();
    }
    if (entry.response_)
    {
      return entry.response_;
    }
    static const auto kLoading = std::make_shared<const std::string>(
        R"({"available":false,"loading":true,"reason":"Starting socket report…"})");
    return kLoading;
  }

 private:
  using Key = std::pair<std::uint32_t, std::string>;
  struct Entry
  {
    std::shared_ptr<const std::string> response_;
    std::chrono::steady_clock::time_point accessed_{};
    std::chrono::steady_clock::time_point next_refresh_{};
    bool pending_ = false;
    bool running_ = false;
  };
  std::filesystem::path directory_;
  std::mutex mutex_;
  std::condition_variable ready_;
  std::map<Key, Entry> entries_;
  std::jthread worker_;

  void Work(std::stop_token p_stop)
  {
    while (!p_stop.stop_requested())
    {
      Key key;
      {
        std::unique_lock lock{mutex_};
        ready_.wait(lock,
                    [&]
                    {
                      return p_stop.stop_requested() ||
                             std::ranges::any_of(
                                 entries_,
                                 [](const auto& p_item)
                                 {
                                   return p_item.second.pending_ &&
                                          !p_item.second.running_;
                                 });
                    });
        if (p_stop.stop_requested())
        {
          return;
        }
        const auto found = std::ranges::find_if(
            entries_,
            [](const auto& p_item)
            {
              return p_item.second.pending_ && !p_item.second.running_;
            });
        key = found->first;
        found->second.running_ = true;
      }
      std::optional<std::string> report;
      try
      {
        report = RunSocketReport(directory_, key.first, key.second);
      }
      catch (const std::exception& error)
      {
        // Last resort for this unit of work (a bug or an exception from the
        // standard library): report the helper as unavailable.
        Log(LogLevel::Error,
            std::format("Socket report failed: {}", error.what()));
      }
      Json json = report ? ParseJson(*report).value_or(Json{}) : Json{};
      std::lock_guard lock{mutex_};
      const auto found = entries_.find(key);
      if (found == entries_.end())
      {
        continue;
      }
      auto& entry = found->second;
      if (!json.IsObject())
      {
        json = entry.response_ ? ParseJson(*entry.response_).value_or(Json{})
                               : Json{};
        if (!json.IsObject())
        {
          json =
              JsonObject{{"available", false},
                         {"reason",
                          "Socket report helper unavailable. Install "
                          "triangulator-socket-report next to the collector."}};
        }
        json.Set("refresh_error", true);
        json.Set("stale", true);
        // Remove live rates from stale cached data; retained totals/history
        // continue to describe the last successful report.
        if (auto* totals = json.Find("totals"); totals && totals->IsObject())
        {
          for (auto& [name, metric] : totals->AsObject())
          {
            metric.Set("current", Json{});
          }
        }
        if (auto* rows = json.Find("rows"); rows && rows->IsArray())
        {
          for (auto& row : rows->AsArray())
          {
            if (auto* metrics = row.Find("metrics");
                metrics && metrics->IsObject())
            {
              for (auto& [name, metric] : metrics->AsObject())
              {
                metric.Set("current", Json{});
              }
            }
          }
        }
      }
      entry.response_ = std::make_shared<const std::string>(DumpJson(json));
      entry.pending_ = false;
      entry.running_ = false;
      entry.next_refresh_ =
          std::chrono::steady_clock::now() + std::chrono::seconds{1};
    }
  }
};

}  // namespace triangulator::collector
