#pragma once

#include <fcntl.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
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
// 400), the editor was stale (HTTP 409), or a file operation failed (HTTP
// 500). SyncFailed means the rules changed, but the directory change could
// not be confirmed on disk.
enum class WatchErrorKind
{
  InvalidRules = 0,
  SaveFailed,
  SyncFailed,
  Conflict,
};

struct WatchError
{
  WatchErrorKind kind_ = WatchErrorKind::InvalidRules;
  std::string message_;
  // Keep retries tied to this operation if another editor changes the rules.
  std::optional<Json> applied_state_ = std::nullopt;
};

// Where the rules in force come from.
enum class WatchSource
{
  Config = 0,
  Dashboard,
};

// The rules in force, with their source. Immutable once published, so the
// main loop and the HTTP workers can share it without a lock.
struct WatchState
{
  std::vector<WatchRule> rules_;
  WatchSource source_ = WatchSource::Config;
  // Why the saved file was not used at startup, or nullopt.
  std::optional<std::string> saved_error_;
  std::string revision_ = {};
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

[[nodiscard]] inline std::expected<FileDescriptor, WatchError>
OpenWatchDirectory(const std::filesystem::path& p_path)
{
  const auto directory = p_path.has_parent_path() ? p_path.parent_path()
                                                  : std::filesystem::path{"."};
  FileDescriptor file{
      ::open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC)};
  if (!file)
  {
    const std::error_code error{errno, std::generic_category()};
    return std::unexpected(
        WatchError{WatchErrorKind::SaveFailed,
                   std::format("cannot open {}: {}", directory.string(),
                               error.message())});
  }
  return file;
}

// A rename or deletion is durable only after its directory is flushed.
// The file change has already happened if this operation fails.
[[nodiscard]] inline std::expected<void, WatchError> SyncWatchDirectory(
    int p_descriptor, const std::filesystem::path& p_path)
{
  while (::fsync(p_descriptor) != 0)
  {
    const std::error_code error{errno, std::generic_category()};
    if (error.value() == EINTR)
    {
      continue;
    }
    return std::unexpected(WatchError{
        WatchErrorKind::SyncFailed,
        std::format("rules were applied, but persistence could not be "
                    "confirmed for {}: {}",
                    p_path.string(), error.message())});
  }
  return {};
}

// Replaces p_path with p_text so that a reader, or a crash, sees the old
// file or the new one, never a mix: write a temporary file next to it,
// flush it to disk, rename it over the old one, then flush the directory.
[[nodiscard]] inline std::expected<void, WatchError> WriteFileAtomically(
    const std::filesystem::path& p_path, std::string_view p_text)
{
  auto directory = OpenWatchDirectory(p_path);
  if (!directory)
  {
    return std::unexpected(std::move(directory.error()));
  }
  auto temporary = p_path;
  temporary += ".tmp";
  const auto failed = [&](std::string_view p_action)
  {
    const std::error_code error{errno, std::generic_category()};
    std::error_code ignored;
    std::filesystem::remove(temporary, ignored);
    return std::unexpected(
        WatchError{WatchErrorKind::SaveFailed,
                   std::format("cannot {} {}: {}", p_action, temporary.string(),
                               error.message())});
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
  return SyncWatchDirectory(directory->Get(), p_path);
}

// The watch rules in force: the [[watch]] rules from collector.toml, or the
// rules saved from the dashboard in <data_dir>/watch-rules.json. The saved
// file, when present, replaces the config rules completely; there is no
// merging, so one source is in force at a time. An unreadable or invalid
// saved file at startup is reported (SavedError, and saved_error in the
// API) and the config rules are used.
//
// The HTTP workers change the rules (Replace, Reset) and the main loop reads
// them for each live view (Current). File I/O happens outside the lock the
// main loop takes, so a slow disk never delays receiving datagrams.
class WatchSettings
{
 public:
  WatchSettings(std::vector<WatchRule> p_config_rules,
                const std::filesystem::path& p_data_dir)
      : config_rules_(std::move(p_config_rules)),
        path_(p_data_dir / kWatchRulesFile),
        epoch_(std::format(
            "{}-{}", ::getpid(),
            std::chrono::steady_clock::now().time_since_epoch().count())),
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
    return Describe(*state);
  }

  // Checks the complete list in p_body ({"rules":[...]}), saves it and puts
  // it in force. Errors before rename leave the file and rules unchanged.
  // A directory flush failure reports that the new rules were applied.
  // Check the editor revision and publish under the same update lock.
  [[nodiscard]] std::expected<Json, WatchError> Replace(
      std::string_view p_body, std::string_view p_revision)
  {
    auto rules = ParseWatchList(p_body);
    if (!rules)
    {
      return std::unexpected(
          WatchError{WatchErrorKind::InvalidRules, std::move(rules.error())});
    }
    std::lock_guard update{update_mutex_};
    if (auto checked = CheckRevision(p_revision); !checked)
    {
      return std::unexpected(checked.error());
    }
    auto saved =
        WriteFileAtomically(path_, DumpJson(WatchRulesJson(*rules), 2));
    if (!saved && saved.error().kind_ != WatchErrorKind::SyncFailed)
    {
      return std::unexpected(saved.error());
    }
    auto result =
        Publish(WatchState{std::move(*rules), WatchSource::Dashboard, {}});
    if (!saved)
    {
      saved.error().applied_state_ = std::move(result);
      return std::unexpected(saved.error());
    }
    return result;
  }

  // Deletes the saved file and puts the config rules back in force.
  [[nodiscard]] std::expected<Json, WatchError> Reset(
      std::string_view p_revision)
  {
    std::lock_guard update{update_mutex_};
    if (auto checked = CheckRevision(p_revision); !checked)
    {
      return std::unexpected(checked.error());
    }
    auto directory = OpenWatchDirectory(path_);
    if (!directory)
    {
      return std::unexpected(std::move(directory.error()));
    }
    std::error_code error;
    std::filesystem::remove(path_, error);
    if (error)
    {
      return std::unexpected(
          WatchError{WatchErrorKind::SaveFailed,
                     std::format("cannot delete {}: {}", path_.string(),
                                 error.message())});
    }
    auto result = Publish(WatchState{config_rules_, WatchSource::Config, {}});
    // Flush even if the file was absent: this also confirms a retried reset
    // whose earlier directory flush failed after removing the file.
    if (auto saved = SyncWatchDirectory(directory->Get(), path_); !saved)
    {
      saved.error().applied_state_ = std::move(result);
      return std::unexpected(saved.error());
    }
    return result;
  }

 private:
  std::vector<WatchRule> config_rules_;
  std::filesystem::path path_;
  // A new collector instance rejects drafts loaded before a restart.
  std::string epoch_;
  std::uint64_t revision_ = 0;
  // Guards current_ only; held for a pointer copy.
  mutable std::mutex mutex_;
  std::shared_ptr<const WatchState> current_;
  // Serializes Replace and Reset, including their file I/O.
  std::mutex update_mutex_;

  [[nodiscard]] static Json Describe(const WatchState& p_state)
  {
    auto result = WatchRulesJson(p_state.rules_);
    result.Set("source", p_state.source_ == WatchSource::Dashboard ? "dashboard"
                                                                   : "config");
    result.Set("saved_error", Json(p_state.saved_error_));
    result.Set("revision", p_state.revision_);
    result.Set("limits", JsonObject{{"prefix_max_bytes", kWatchPrefixMaxBytes},
                                    {"wake_ms_min", kWatchWakeMsMin},
                                    {"wake_ms_max", kWatchWakeMsMax},
                                    {"max_rules", kMaxWatchRules}});
    return result;
  }

  [[nodiscard]] std::expected<void, WatchError> CheckRevision(
      std::string_view p_revision) const
  {
    if (p_revision != Current()->revision_)
    {
      return std::unexpected(
          WatchError{WatchErrorKind::Conflict,
                     "Another user changed the watched-thread rules, or the "
                     "collector restarted. "
                     "Your edits were kept. Reload the current rules before "
                     "saving or resetting."});
    }
    return {};
  }

  [[nodiscard]] Json Publish(WatchState p_state)
  {
    p_state.revision_ = std::format("{}-{}", epoch_, ++revision_);
    auto state = std::make_shared<const WatchState>(std::move(p_state));
    {
      std::lock_guard lock{mutex_};
      current_ = state;
    }
    return Describe(*state);
  }

  // The startup state: the saved rules if the file exists and is valid,
  // else the config rules, with the reason when the file was not usable.
  [[nodiscard]] std::shared_ptr<const WatchState> Load() const
  {
    std::error_code error;
    if (!std::filesystem::exists(path_, error) && !error)
    {
      return std::make_shared<const WatchState>(
          WatchState{config_rules_, WatchSource::Config, {}, epoch_ + "-0"});
    }
    const auto text = ReadFile(path_);
    if (!text)
    {
      return std::make_shared<const WatchState>(WatchState{
          config_rules_, WatchSource::Config, text.error(), epoch_ + "-0"});
    }
    auto rules = ParseWatchList(*text);
    if (!rules)
    {
      return std::make_shared<const WatchState>(WatchState{
          config_rules_, WatchSource::Config,
          std::format("{}: {}", path_.string(), rules.error()), epoch_ + "-0"});
    }
    return std::make_shared<const WatchState>(WatchState{
        std::move(*rules), WatchSource::Dashboard, {}, epoch_ + "-0"});
  }
};

}  // namespace triangulator::collector
