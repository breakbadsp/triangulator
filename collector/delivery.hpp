#pragma once

#include <curl/curl.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <format>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

#include "config.hpp"
#include "json.hpp"
#include "log.hpp"
#include "storage.hpp"

namespace triangulator::collector
{

struct CurlCleanup
{
  void operator()(CURL* p_handle) const noexcept
  {
    ::curl_easy_cleanup(p_handle);
  }
};
using CurlHandle = std::unique_ptr<CURL, CurlCleanup>;

struct CurlListCleanup
{
  void operator()(curl_slist* p_list) const noexcept
  {
    ::curl_slist_free_all(p_list);
  }
};
using CurlList = std::unique_ptr<curl_slist, CurlListCleanup>;

class DeliveryError : public std::runtime_error
{
 public:
  using std::runtime_error::runtime_error;
};

// Sends alert events to the webhook on a background thread, with three
// attempts per event. Events that cannot be queued
// are counted as dropped; they are still in SQLite.
class Delivery
{
 public:
  explicit Delivery(const Config& p_config) : config_(p_config)
  {
    thread_ = std::thread(
        [this]
        {
          Run();
        });
  }
  ~Delivery()
  {
    Close();
  }
  Delivery(const Delivery&) = delete;
  Delivery& operator=(const Delivery&) = delete;

  void Submit(const AlertEvent& p_event)
  {
    {
      std::lock_guard lock{mutex_};
      if (queue_.size() < kQueueLimit)
      {
        queue_.push_back(p_event);
        changed_.notify_one();
        return;
      }
    }
    ++dropped_;
    Log(LogLevel::Error, "Alert delivery queue full; event retained in SQLite");
  }

  [[nodiscard]] std::int64_t Failures() const noexcept
  {
    return failures_;
  }
  [[nodiscard]] std::int64_t Dropped() const noexcept
  {
    return dropped_;
  }
  [[nodiscard]] std::int64_t Queued()
  {
    std::lock_guard lock{mutex_};
    return static_cast<std::int64_t>(queue_.size());
  }

  void Close()
  {
    {
      std::lock_guard lock{mutex_};
      stopped_ = true;
      changed_.notify_all();
    }
    if (thread_.joinable())
    {
      thread_.join();
    }
  }

 private:
  static constexpr std::size_t kQueueLimit = 1000;

  const Config& config_;
  std::mutex mutex_;
  std::condition_variable changed_;
  std::deque<AlertEvent> queue_;
  bool stopped_ = false;
  std::atomic<std::int64_t> failures_ = 0;
  std::atomic<std::int64_t> dropped_ = 0;
  std::thread thread_;

  // Waits up to p_timeout; returns true if the service is stopping.
  bool WaitStopped(std::chrono::milliseconds p_timeout)
  {
    std::unique_lock lock{mutex_};
    return changed_.wait_for(lock, p_timeout,
                             [this]
                             {
                               return stopped_;
                             });
  }

  static void Perform(CURL* p_handle)
  {
    std::array<char, CURL_ERROR_SIZE> error{};
    ::curl_easy_setopt(p_handle, CURLOPT_ERRORBUFFER, error.data());
    ::curl_easy_setopt(p_handle, CURLOPT_NOSIGNAL, 1L);
    ::curl_easy_setopt(p_handle, CURLOPT_TIMEOUT_MS, 5000L);
    const auto result = ::curl_easy_perform(p_handle);
    if (result != CURLE_OK)
    {
      throw DeliveryError(error[0] != '\0' ? error.data()
                                           : ::curl_easy_strerror(result));
    }
  }

  static std::size_t Discard(char*, std::size_t p_size, std::size_t p_count,
                             void*)
  {
    return p_size * p_count;
  }

  // POSTs the event as JSON, or GETs the URL when there is no event (the
  // dead-man heartbeat). HTTP errors count as failures.
  static void Post(const std::string& p_url, const AlertEvent* p_event)
  {
    CurlHandle handle{::curl_easy_init()};
    if (!handle)
    {
      throw DeliveryError("curl_easy_init failed");
    }
    CurlList headers{
        ::curl_slist_append(nullptr, "Content-Type: application/json")};
    const std::string body =
        p_event != nullptr ? DumpJson(EventJson(*p_event)) : std::string{};
    ::curl_easy_setopt(handle.get(), CURLOPT_URL, p_url.c_str());
    ::curl_easy_setopt(handle.get(), CURLOPT_HTTPHEADER, headers.get());
    ::curl_easy_setopt(handle.get(), CURLOPT_FAILONERROR, 1L);
    ::curl_easy_setopt(handle.get(), CURLOPT_WRITEFUNCTION, &Discard);
    if (p_event != nullptr)
    {
      ::curl_easy_setopt(handle.get(), CURLOPT_POSTFIELDS, body.c_str());
      ::curl_easy_setopt(handle.get(), CURLOPT_POSTFIELDSIZE,
                         static_cast<long>(body.size()));
    }
    Perform(handle.get());
  }

  void Run()
  {
    auto next_ping = std::chrono::steady_clock::time_point{};
    while (true)
    {
      if (config_.deadman_url_ && std::chrono::steady_clock::now() >= next_ping)
      {
        try
        {
          Post(*config_.deadman_url_, nullptr);
        }
        catch (const DeliveryError& error)
        {
          ++failures_;
          Log(LogLevel::Error,
              std::format("Dead-man heartbeat failed: {}", error.what()));
        }
        next_ping = std::chrono::steady_clock::now() + std::chrono::seconds{60};
      }
      std::optional<AlertEvent> event;
      {
        std::unique_lock lock{mutex_};
        changed_.wait_for(lock, std::chrono::milliseconds{500},
                          [this]
                          {
                            return stopped_ || !queue_.empty();
                          });
        if (stopped_)
        {
          return;
        }
        if (queue_.empty())
        {
          continue;
        }
        event = std::move(queue_.front());
        queue_.pop_front();
      }
      if (config_.webhook_url_.empty())
      {
        continue;
      }
      for (int attempt = 0; attempt < 3; ++attempt)
      {
        try
        {
          Post(config_.webhook_url_, &*event);
          break;
        }
        catch (const DeliveryError& error)
        {
          ++failures_;
          Log(LogLevel::Error,
              std::format("Alert delivery failed (attempt {}/3): {}",
                          attempt + 1, error.what()));
          if (WaitStopped(std::chrono::seconds{std::min(1 << attempt, 4)}))
          {
            break;
          }
        }
      }
    }
  }
};

}  // namespace triangulator::collector
