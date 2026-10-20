#pragma once

#include <arpa/inet.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <expected>
#include <filesystem>
#include <format>
#include <fstream>
#include <optional>
#include <span>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "json.hpp"
#include "toml.hpp"

namespace triangulator::collector
{

// The largest max_live_samples. The Monitor reserves about 280 bytes of
// address space for each live sample at startup, so this limit is about
// 2.8 GB. A larger value could make the reservation fail.
inline constexpr std::int64_t kMaxLiveSamplesLimit = 10'000'000;

struct GroupRule
{
  std::string name_;
  std::string prefix_;
};

// Limits of the watch rules. Linux thread names are at most 15 bytes, so a
// longer prefix could never match.
inline constexpr std::size_t kWatchPrefixMaxBytes = 15;
inline constexpr std::int64_t kWatchWakeMsMin = 10;
inline constexpr std::int64_t kWatchWakeMsMax = 3'600'000;
inline constexpr std::size_t kMaxWatchRules = 64;

// "Threads whose name starts with prefix_ wake up at least every wake_ms_
// milliseconds." The dashboard flags a matching thread that stops waking up
// or keeps a core busy; the collector only reports the numbers.
struct WatchRule
{
  std::string prefix_;
  std::int64_t wake_ms_{};

  friend bool operator==(const WatchRule&, const WatchRule&) = default;
};

// The wake_ms of the rule with the longest prefix that p_name starts with,
// or nullopt when no rule matches. Prefixes are unique, so at most one rule
// has the longest matching prefix and the order of the rules does not matter.
[[nodiscard]] inline std::optional<std::int64_t> WakeMsFor(
    std::span<const WatchRule> p_rules, std::string_view p_name) noexcept
{
  const WatchRule* best = nullptr;
  for (const auto& rule : p_rules)
  {
    if (p_name.starts_with(rule.prefix_) &&
        (best == nullptr || rule.prefix_.size() > best->prefix_.size()))
    {
      best = &rule;
    }
  }
  if (best == nullptr)
  {
    return std::nullopt;
  }
  return best->wake_ms_;
}

// Checks a complete list of watch rules, from [[watch]] tables in
// collector.toml or from the dashboard, and returns them in the same order.
// Each rule must have exactly the keys prefix and wake_ms, so a misspelt key
// is an error rather than a rule that silently does nothing. Errors name the
// rule by its position (from 1) and its prefix, and say what is allowed.
[[nodiscard]] inline std::expected<std::vector<WatchRule>, std::string>
ParseWatchRules(const JsonArray& p_rules)
{
  if (p_rules.size() > kMaxWatchRules)
  {
    return std::unexpected(
        std::format("too many watch rules ({}); at most {} are allowed",
                    p_rules.size(), kMaxWatchRules));
  }
  std::vector<WatchRule> rules;
  rules.reserve(p_rules.size());
  for (std::size_t index = 0; index < p_rules.size(); ++index)
  {
    const Json& item = p_rules[index];
    const auto number = index + 1;
    if (!item.IsObject())
    {
      return std::unexpected(std::format(
          "watch rule {} must have the keys prefix and wake_ms", number));
    }
    for (const auto& [key, value] : item.AsObject())
    {
      if (key != "prefix" && key != "wake_ms")
      {
        return std::unexpected(
            std::format("watch rule {}: unknown key {}; the allowed keys are "
                        "prefix and wake_ms",
                        number, DumpJson(Json(key))));
      }
    }
    const auto* prefix = item.Find("prefix");
    if (prefix == nullptr || !prefix->IsString() ||
        prefix->AsString().empty() ||
        prefix->AsString().size() > kWatchPrefixMaxBytes ||
        prefix->AsString().find('\0') != std::string::npos)
    {
      return std::unexpected(std::format(
          "watch rule {}: prefix must be text of 1 to {} bytes (Linux thread "
          "names are at most {} bytes)",
          number, kWatchPrefixMaxBytes, kWatchPrefixMaxBytes));
    }
    const auto& text = prefix->AsString();
    const auto* wake_ms = item.Find("wake_ms");
    if (wake_ms == nullptr || !wake_ms->IsInt() ||
        wake_ms->AsInt() < kWatchWakeMsMin ||
        wake_ms->AsInt() > kWatchWakeMsMax)
    {
      return std::unexpected(std::format(
          "watch rule {} (prefix {}): wake_ms must be a whole "
          "number of milliseconds from {} to {}",
          number, DumpJson(Json(text)), kWatchWakeMsMin, kWatchWakeMsMax));
    }
    const auto same = std::ranges::find(rules, text, &WatchRule::prefix_);
    if (same != rules.end())
    {
      return std::unexpected(std::format(
          "watch rule {} (prefix {}): rule {} has the same prefix; each "
          "prefix may appear only once",
          number, DumpJson(Json(text)), same - rules.begin() + 1));
    }
    rules.push_back({text, wake_ms->AsInt()});
  }
  return rules;
}

// The collector's settings. The same file holds the alerting module's
// settings, so alert keys may be present; the collector does no alerting and
// ignores them, apart from [alerts] window_s, which sets the rollup window.
struct Config
{
  std::int64_t clock_ticks_ = 100;
  std::int64_t retention_days_ = 7;
  bool store_raw_ = true;
  // Dashboard recording cadence; zero disables recording.
  double replay_interval_s_ = 1;
  std::string data_dir_ = "data";
  std::string udp_host_ = "0.0.0.0";
  std::int64_t udp_port_ = 9400;
  std::string http_host_ = "127.0.0.1";
  std::int64_t http_port_ = 9401;
  std::vector<GroupRule> groups_;
  // [[watch]] rules. Rules saved from the dashboard replace them (see
  // WatchSettings in watch.hpp).
  std::vector<WatchRule> watches_;
  std::int64_t max_live_samples_ = 1'000'000;
  std::int64_t max_targets_ = 16;
  std::optional<std::string> sampler_ip_;
  std::vector<std::string> sampler_ips_;
  // Length of one rollup window in seconds (5..10).
  double window_s_ = 5;
  // True when the file has alert thresholds or delivery settings, which
  // this collector ignores; main logs a warning.
  bool alerting_ignored_ = false;
};

[[nodiscard]] inline std::expected<std::string, std::string> ReadFile(
    const std::filesystem::path& p_path)
{
  std::ifstream file{p_path, std::ios::binary};
  if (!file)
  {
    return std::unexpected(std::format("cannot read {}", p_path.string()));
  }
  std::ostringstream contents;
  contents << file.rdbuf();
  return contents.str();
}

[[nodiscard]] inline std::optional<std::string> NormalizeIp(
    const std::string& p_text)
{
  std::array<unsigned char, 16> address{};
  std::array<char, INET6_ADDRSTRLEN> buffer{};
  for (const int family : {AF_INET, AF_INET6})
  {
    if (::inet_pton(family, p_text.c_str(), address.data()) == 1 &&
        ::inet_ntop(family, address.data(), buffer.data(),
                    static_cast<socklen_t>(buffer.size())) != nullptr)
    {
      return std::string{buffer.data()};
    }
  }
  return std::nullopt;
}

namespace detail
{

[[nodiscard]] inline std::expected<void, std::string> ReadPositiveInteger(
    const Json& p_root, std::string_view p_key, std::int64_t& p_out)
{
  if (const auto* value = p_root.Find(p_key))
  {
    if (!value->IsInt())
    {
      return std::unexpected(
          std::format("{} must be a positive integer", p_key));
    }
    p_out = value->AsInt();
  }
  if (p_out <= 0)
  {
    return std::unexpected(std::format("{} must be a positive integer", p_key));
  }
  return {};
}

[[nodiscard]] inline std::expected<void, std::string> ReadString(
    const Json& p_table, std::string_view p_key, std::string& p_out)
{
  if (const auto* value = p_table.Find(p_key))
  {
    if (!value->IsString())
    {
      return std::unexpected(std::format("{} must be a string", p_key));
    }
    p_out = value->AsString();
  }
  return {};
}

}  // namespace detail

// Parses and validates a collector TOML file. Unknown keys are ignored,
// except inside [[watch]] tables (see ParseWatchRules).
[[nodiscard]] inline std::expected<Config, std::string> ParseConfig(
    std::string_view p_text)
{
  auto parsed = ParseToml(p_text);
  if (!parsed)
  {
    return std::unexpected(parsed.error());
  }
  const Json& root = *parsed;
  Config config;
  for (const auto& [key, member] :
       {std::pair{"clock_ticks", &Config::clock_ticks_},
        std::pair{"retention_days", &Config::retention_days_},
        std::pair{"max_live_samples", &Config::max_live_samples_},
        std::pair{"max_targets", &Config::max_targets_},
        std::pair{"udp_port", &Config::udp_port_},
        std::pair{"http_port", &Config::http_port_}})
  {
    if (auto status = detail::ReadPositiveInteger(root, key, config.*member);
        !status)
    {
      return std::unexpected(status.error());
    }
  }
  for (const auto& [key, value] : {std::pair{"udp_port", config.udp_port_},
                                   std::pair{"http_port", config.http_port_}})
  {
    if (value > 65535)
    {
      return std::unexpected(std::format("invalid {}", key));
    }
  }
  if (config.max_live_samples_ > kMaxLiveSamplesLimit)
  {
    return std::unexpected(std::format("max_live_samples must be at most {}",
                                       kMaxLiveSamplesLimit));
  }
  if (config.max_targets_ > 64 ||
      config.max_live_samples_ < config.max_targets_)
  {
    return std::unexpected(
        "max_targets must be 1..64 and no greater than max_live_samples");
  }
  for (const auto& [key, member] :
       {std::pair{"data_dir", &Config::data_dir_},
        std::pair{"udp_host", &Config::udp_host_},
        std::pair{"http_host", &Config::http_host_}})
  {
    if (auto status = detail::ReadString(root, key, config.*member); !status)
    {
      return std::unexpected(status.error());
    }
  }
  if (const auto* store_raw = root.Find("store_raw"))
  {
    if (!store_raw->IsBool())
    {
      return std::unexpected("store_raw must be true or false");
    }
    config.store_raw_ = store_raw->AsBool();
  }

  if (const auto* interval = root.Find("replay_interval_s"))
  {
    if (!interval->IsNumber() || !std::isfinite(interval->AsNumber()) ||
        !(interval->AsNumber() == 0 ||
          (0.5 <= interval->AsNumber() && interval->AsNumber() <= 60)))
    {
      return std::unexpected("replay_interval_s must be 0 or 0.5..60");
    }
    config.replay_interval_s_ = interval->AsNumber();
  }

  if (const auto* alerts = root.Find("alerts"))
  {
    if (!alerts->IsObject())
    {
      return std::unexpected("alerts must be a table");
    }
    for (const auto& [key, value] : alerts->AsObject())
    {
      if (key != "window_s")
      {
        config.alerting_ignored_ = true;
        continue;
      }
      if (!value.IsNumber() ||
          !(5 <= value.AsNumber() && value.AsNumber() <= 10))
      {
        return std::unexpected("window_s must be 5..10");
      }
      config.window_s_ = value.AsNumber();
    }
  }
  if (root.Find("deadman_url") != nullptr)
  {
    config.alerting_ignored_ = true;
  }

  if (const auto* groups = root.Find("group"))
  {
    if (!groups->IsArray())
    {
      return std::unexpected("group must be an array of tables");
    }
    for (const auto& group : groups->AsArray())
    {
      const auto* name = group.Find("name");
      const auto* prefix = group.Find("prefix");
      if (name == nullptr || prefix == nullptr || !name->IsString() ||
          !prefix->IsString() || name->AsString().empty() ||
          prefix->AsString().empty() || prefix->AsString().size() > 15)
      {
        return std::unexpected(
            "each group needs a name and a prefix of at most 15 bytes");
      }
      const bool duplicate =
          std::ranges::any_of(config.groups_,
                              [&](const GroupRule& p_group)
                              {
                                return p_group.name_ == name->AsString();
                              });
      if (duplicate || name->AsString() == "ungrouped")
      {
        return std::unexpected(
            "group names must be unique; ungrouped is reserved");
      }
      config.groups_.push_back({name->AsString(), prefix->AsString()});
    }
  }
  if (const auto* watches = root.Find("watch"))
  {
    if (!watches->IsArray())
    {
      return std::unexpected(
          "watch must be written as [[watch]] tables, each with a prefix and "
          "wake_ms");
    }
    auto rules = ParseWatchRules(watches->AsArray());
    if (!rules)
    {
      return std::unexpected(rules.error());
    }
    config.watches_ = std::move(*rules);
  }
  if (const auto* sampler_ip = root.Find("sampler_ip");
      sampler_ip != nullptr &&
      !(sampler_ip->IsString() && sampler_ip->AsString().empty()))
  {
    if (!sampler_ip->IsString())
    {
      return std::unexpected("sampler_ip must be a string");
    }
    auto normalized = NormalizeIp(sampler_ip->AsString());
    if (!normalized)
    {
      return std::unexpected(
          std::format("'{}' does not appear to be an IPv4 or IPv6 address",
                      sampler_ip->AsString()));
    }
    config.sampler_ip_ = std::move(*normalized);
  }
  if (const auto* senders = root.Find("sampler_ips"))
  {
    if (root.Find("sampler_ip") != nullptr)
    {
      return std::unexpected("use sampler_ips or sampler_ip, not both");
    }
    if (!senders->IsArray() || senders->AsArray().empty() ||
        senders->AsArray().size() > 64)
    {
      return std::unexpected("sampler_ips must contain 1..64 IP addresses");
    }
    for (const auto& sender : senders->AsArray())
    {
      auto normalized =
          sender.IsString() ? NormalizeIp(sender.AsString()) : std::nullopt;
      if (!normalized || std::ranges::find(config.sampler_ips_, *normalized) !=
                             config.sampler_ips_.end())
      {
        return std::unexpected("sampler_ips must contain unique IP addresses");
      }
      config.sampler_ips_.push_back(std::move(*normalized));
    }
  }
  else if (config.sampler_ip_)
  {
    config.sampler_ips_.push_back(*config.sampler_ip_);
  }
  std::error_code error;
  auto data_dir = std::filesystem::absolute(config.data_dir_, error);
  config.data_dir_ = std::filesystem::weakly_canonical(data_dir, error)
                         .lexically_normal()
                         .string();
  return config;
}

[[nodiscard]] inline std::expected<Config, std::string> LoadConfig(
    const std::filesystem::path& p_path)
{
  auto contents = ReadFile(p_path);
  if (!contents)
  {
    return std::unexpected(contents.error());
  }
  return ParseConfig(*contents);
}

}  // namespace triangulator::collector
