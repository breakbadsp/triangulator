#pragma once

#include <fcntl.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <expected>
#include <filesystem>
#include <format>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#include "../common/fd.hpp"
#include "config.hpp"
#include "json.hpp"

namespace triangulator::collector
{

// The dashboard's saved rules, in the data directory.
inline constexpr std::string_view kWatchRulesFile = "watch-rules.json";

// Why a change to the watch rules failed: the request was invalid (HTTP
// 400), or the saved file could not be written or deleted (HTTP 500).
// Either way the rules in force did not change.
enum class WatchErrorKind
{
  InvalidRules = 0,
  SaveFailed,
};

struct WatchError
{
  WatchErrorKind kind_ = WatchErrorKind::InvalidRules;
  std::string message_;
};

// Where the rules in force come from.
enum class WatchSource
{
  Config = 0,
  Dashboard,
};

// The rules in force, with their source. Immutable once published, so the
// main loop and the HTTP thread can share it without a lock.
struct WatchState
{
  std::vector<WatchRule> rules_;
  WatchSource source_ = WatchSource::Config;
  // Why the saved file was not used at startup, or nullopt.
  std::optional<std::string> saved_error_;
};

// Reads a complete rule list in the form the dashboard sends and the saved
// file holds: {"rules":[{"prefix":"worker-","wake_ms":500}]}.
[[nodiscard]] inline std::expected<std::vector<WatchRule>, std::string>
ParseWatchList(std::string_view p_text)
{
  static constexpr std::string_view kShape =
      R"(expected JSON of the form {"rules":[{"prefix":"worker-","wake_ms":500}]})";
  const auto parsed = ParseJson(p_text);
  if (!parsed || !parsed->IsObject())
  {
    return std::unexpected(std::string{kShape});
  }
  for (const auto& [key, value] : parsed->AsObject())
  {
    if (key != "rules")
    {
      return std::unexpected(
          std::format("unknown key {}; {}", DumpJson(Json(key)), kShape));
    }
  }
  const auto* rules = parsed->Find("rules");
  if (rules == nullptr || !rules->IsArray())
  {
    return std::unexpected(std::string{kShape});
  }
  return ParseWatchRules(rules->AsArray());
}

// {"rules":[...]} for the saved file and the API.
[[nodiscard]] inline Json WatchRulesJson(const std::vector<WatchRule>& p_rules)
{
  JsonArray rules;
  for (const auto& rule : p_rules)
  {
    rules.emplace_back(
        JsonObject{{"prefix", rule.prefix_}, {"wake_ms", rule.wake_ms_}});
  }
  return JsonObject{{"rules", std::move(rules)}};
}

// Replaces p_path with p_text so that a reader, or a crash, sees the old
// file or the new one, never a mix: write a temporary file next to it,
// flush it to disk, then rename it over the old one.
[[nodiscard]] inline std::expected<void, std::string> WriteFileAtomically(
    const std::filesystem::path& p_path, std::string_view p_text)
{
  auto temporary = p_path;
  temporary += ".tmp";
  const auto failed = [&](std::string_view p_action)
  {
    const std::error_code error{errno, std::generic_category()};
    std::error_code ignored;
    std::filesystem::remove(temporary, ignored);
    return std::unexpected(std::format("cannot {} {}: {}", p_action,
                                       temporary.string(), error.message()));
  };
  FileDescriptor file{::open(temporary.c_str(),
                             O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644)};
  if (!file)
  {
    return failed("create");
  }
  while (!p_text.empty())
  {
    const auto written = ::write(file.Get(), p_text.data(), p_text.size());
    if (written < 0 && errno == EINTR)
    {
      continue;
    }
    if (written <= 0)
    {
      return failed("write");
    }
    p_text.remove_prefix(static_cast<std::size_t>(written));
  }
  if (::fsync(file.Get()) != 0)
  {
    return failed("write");
  }
  file.Reset();
  if (::rename(temporary.c_str(), p_path.c_str()) != 0)
  {
    return failed("rename");
  }
  return {};
}

// The watch rules in force: the [[watch]] rules from collector.toml, or the
// rules saved from the dashboard in <data_dir>/watch-rules.json. The saved
// file, when present, replaces the config rules completely; there is no
// merging, so one source is in force at a time. An unreadable or invalid
// saved file at startup is reported (SavedError, and saved_error in the
// API) and the config rules are used.
//
// The HTTP thread changes the rules (Replace, Reset) and the main loop reads
// them for each live view (Current). File I/O happens outside the lock the
// main loop takes, so a slow disk never delays receiving datagrams.
class WatchSettings
{
 public:
  WatchSettings(std::vector<WatchRule> p_config_rules,
                const std::filesystem::path& p_data_dir)
      : config_rules_(std::move(p_config_rules)),
        path_(p_data_dir / kWatchRulesFile),
        current_(Load())
  {
  }

  // The rules in force. Cheap: one lock and a reference count.
  [[nodiscard]] std::shared_ptr<const WatchState> Current() const
  {
    std::lock_guard lock{mutex_};
    return current_;
  }

  [[nodiscard]] const std::filesystem::path& Path() const noexcept
  {
    return path_;
  }

  // The GET /api/watches response.
  [[nodiscard]] Json Describe() const
  {
    const auto state = Current();
    auto result = WatchRulesJson(state->rules_);
    result.Set("source", state->source_ == WatchSource::Dashboard ? "dashboard"
                                                                  : "config");
    result.Set("saved_error", Json(state->saved_error_));
    result.Set("limits", JsonObject{{"prefix_max_bytes", kWatchPrefixMaxBytes},
                                    {"wake_ms_min", kWatchWakeMsMin},
                                    {"wake_ms_max", kWatchWakeMsMax},
                                    {"max_rules", kMaxWatchRules}});
    return result;
  }

  // Checks the complete list in p_body ({"rules":[...]}), saves it and puts
  // it in force. On any error nothing is saved or changed.
  [[nodiscard]] std::expected<void, WatchError> Replace(std::string_view p_body)
  {
    auto rules = ParseWatchList(p_body);
    if (!rules)
    {
      return std::unexpected(
          WatchError{WatchErrorKind::InvalidRules, std::move(rules.error())});
    }
    std::lock_guard update{update_mutex_};
    if (auto saved =
            WriteFileAtomically(path_, DumpJson(WatchRulesJson(*rules), 2));
        !saved)
    {
      return std::unexpected(
          WatchError{WatchErrorKind::SaveFailed, std::move(saved.error())});
    }
    Publish(WatchState{std::move(*rules), WatchSource::Dashboard, {}});
    return {};
  }

  // Deletes the saved file and puts the config rules back in force.
  [[nodiscard]] std::expected<void, WatchError> Reset()
  {
    std::lock_guard update{update_mutex_};
    std::error_code error;
    std::filesystem::remove(path_, error);
    if (error)
    {
      return std::unexpected(
          WatchError{WatchErrorKind::SaveFailed,
                     std::format("cannot delete {}: {}", path_.string(),
                                 error.message())});
    }
    Publish(WatchState{config_rules_, WatchSource::Config, {}});
    return {};
  }

 private:
  std::vector<WatchRule> config_rules_;
  std::filesystem::path path_;
  // Guards current_ only; held for a pointer copy.
  mutable std::mutex mutex_;
  std::shared_ptr<const WatchState> current_;
  // Serializes Replace and Reset, including their file I/O.
  std::mutex update_mutex_;

  void Publish(WatchState p_state)
  {
    auto state = std::make_shared<const WatchState>(std::move(p_state));
    std::lock_guard lock{mutex_};
    current_ = std::move(state);
  }

  // The startup state: the saved rules if the file exists and is valid,
  // else the config rules, with the reason when the file was not usable.
  [[nodiscard]] std::shared_ptr<const WatchState> Load() const
  {
    std::error_code error;
    if (!std::filesystem::exists(path_, error) && !error)
    {
      return std::make_shared<const WatchState>(
          WatchState{config_rules_, WatchSource::Config, {}});
    }
    const auto text = ReadFile(path_);
    if (!text)
    {
      return std::make_shared<const WatchState>(
          WatchState{config_rules_, WatchSource::Config, text.error()});
    }
    auto rules = ParseWatchList(*text);
    if (!rules)
    {
      return std::make_shared<const WatchState>(
          WatchState{config_rules_, WatchSource::Config,
                     std::format("{}: {}", path_.string(), rules.error())});
    }
    return std::make_shared<const WatchState>(
        WatchState{std::move(*rules), WatchSource::Dashboard, {}});
  }
};

}  // namespace triangulator::collector
