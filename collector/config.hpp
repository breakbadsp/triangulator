#pragma once

#include <arpa/inet.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <expected>
#include <filesystem>
#include <format>
#include <fstream>
#include <optional>
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "json.hpp"
#include "toml.hpp"

namespace triangulator::collector
{

inline constexpr std::string_view kSettingsFile = "alert-settings.json";

// Alert rules the dashboard can switch on and off, with the settings each one
// uses. Every rule is evaluated by the collector; the sampler only reports
// data. The order matches the Python collector's RULES.
struct RuleInfo
{
  std::string_view rule_;
  std::string_view label_;
  std::array<std::string_view, 2> settings_;
  std::size_t setting_count_;
  std::string_view description_;
};

inline constexpr std::array kRules{
    RuleInfo{"cpu_warn",
             "High CPU (warning)",
             {"cpu_warn_pct", "cpu_sustain_secs"},
             2,
             "Thread CPU above the threshold continuously for the duration."},
    RuleInfo{"cpu_critical",
             "High CPU (critical)",
             {"cpu_crit_pct", "cpu_sustain_secs"},
             2,
             "Thread CPU above the threshold continuously for the duration."},
    RuleInfo{"starved",
             "Starved thread",
             {"starve_run_delay_pct", ""},
             1,
             "Thread waits to run (run delay) for this share of a window, for "
             "three windows."},
    RuleInfo{"kernel_wait",
             "Stuck in kernel (D)",
             {"kernel_wait_secs", ""},
             1,
             "Thread in uninterruptible state D for longer than this."},
    RuleInfo{"sampler_silent",
             "Sampler silent",
             {"sampler_silent_secs", ""},
             1,
             "No datagrams from the sampler for this long."},
    RuleInfo{"target_absent",
             "Target absent",
             {"target_absent_secs", ""},
             1,
             "Sampler reports that the target process is gone for this long."},
    RuleInfo{"packet_loss",
             "Packet loss",
             {"packet_loss_pct", ""},
             1,
             "Estimated datagram loss over the last minute above this."},
    RuleInfo{"access_lost",
             "Access lost",
             {"", ""},
             0,
             "Most threads report a hidden wait channel."},
};
inline constexpr std::size_t kRuleCount = kRules.size();

[[nodiscard]] inline std::optional<std::size_t> RuleIndex(
    std::string_view p_rule) noexcept
{
  for (std::size_t index = 0; index < kRuleCount; ++index)
  {
    if (kRules[index].rule_ == p_rule)
    {
      return index;
    }
  }
  return std::nullopt;
}

struct AlertSettings
{
  double window_s_ = 5;
  double sustain_windows_ = 3;
  double resolve_windows_ = 2;
  double cpu_warn_pct_ = 50;
  double cpu_crit_pct_ = 90;
  double starve_run_delay_pct_ = 20;
  double cpu_sustain_secs_ = 5;
  double kernel_wait_secs_ = 5;
  double sampler_silent_secs_ = 10;
  double target_absent_secs_ = 5;
  double packet_loss_pct_ = 20;
  double reminder_secs_ = 1800;
  std::array<bool, kRuleCount> enabled_{true, true, true, true,
                                        true, true, true, true};

  [[nodiscard]] bool Enabled(std::string_view p_rule) const noexcept
  {
    const auto index = RuleIndex(p_rule);
    return !index || enabled_[*index];
  }
};

struct NumericSetting
{
  std::string_view key_;
  double AlertSettings::* member_;
};

// Every numeric alert setting, in the Python collector's DEFAULT_ALERTS order.
inline constexpr std::array kNumericSettings{
    NumericSetting{"window_s", &AlertSettings::window_s_},
    NumericSetting{"sustain_windows", &AlertSettings::sustain_windows_},
    NumericSetting{"resolve_windows", &AlertSettings::resolve_windows_},
    NumericSetting{"cpu_warn_pct", &AlertSettings::cpu_warn_pct_},
    NumericSetting{"cpu_crit_pct", &AlertSettings::cpu_crit_pct_},
    NumericSetting{"starve_run_delay_pct",
                   &AlertSettings::starve_run_delay_pct_},
    NumericSetting{"cpu_sustain_secs", &AlertSettings::cpu_sustain_secs_},
    NumericSetting{"kernel_wait_secs", &AlertSettings::kernel_wait_secs_},
    NumericSetting{"sampler_silent_secs", &AlertSettings::sampler_silent_secs_},
    NumericSetting{"target_absent_secs", &AlertSettings::target_absent_secs_},
    NumericSetting{"packet_loss_pct", &AlertSettings::packet_loss_pct_},
    NumericSetting{"reminder_secs", &AlertSettings::reminder_secs_},
};

// Settings the dashboard may edit: label, unit and allowed range.
struct EditableSetting
{
  std::string_view key_;
  std::string_view label_;
  std::string_view unit_;
  double minimum_;
  double maximum_;
  double AlertSettings::* member_;
};

inline constexpr std::array kEditableSettings{
    EditableSetting{"cpu_warn_pct", "Warning threshold", "%", 1, 10000,
                    &AlertSettings::cpu_warn_pct_},
    EditableSetting{"cpu_crit_pct", "Critical threshold", "%", 1, 10000,
                    &AlertSettings::cpu_crit_pct_},
    EditableSetting{"cpu_sustain_secs", "Sustained for", "s", 1, 3600,
                    &AlertSettings::cpu_sustain_secs_},
    EditableSetting{"starve_run_delay_pct", "Run delay", "%", 1, 100,
                    &AlertSettings::starve_run_delay_pct_},
    EditableSetting{"kernel_wait_secs", "Longer than", "s", 1, 3600,
                    &AlertSettings::kernel_wait_secs_},
    EditableSetting{"sampler_silent_secs", "Silent for", "s", 2, 3600,
                    &AlertSettings::sampler_silent_secs_},
    EditableSetting{"target_absent_secs", "Absent for", "s", 1, 3600,
                    &AlertSettings::target_absent_secs_},
    EditableSetting{"packet_loss_pct", "Loss above", "%", 1, 100,
                    &AlertSettings::packet_loss_pct_},
    EditableSetting{"reminder_secs", "Remind open alerts every", "s", 60,
                    604800, &AlertSettings::reminder_secs_},
};

struct GroupRule
{
  std::string name_;
  std::string prefix_;
};

struct Config
{
  std::int64_t clock_ticks_ = 100;
  std::int64_t retention_days_ = 7;
  bool store_raw_ = false;
  std::string data_dir_ = "data";
  std::string udp_host_ = "0.0.0.0";
  std::int64_t udp_port_ = 9400;
  std::string http_host_ = "127.0.0.1";
  std::int64_t http_port_ = 9401;
  std::vector<GroupRule> groups_;
  std::int64_t max_live_samples_ = 1'000'000;
  std::optional<std::string> sampler_ip_;
  std::optional<std::string> deadman_url_;
  std::vector<std::string> http_allowed_hosts_;
  AlertSettings alerts_;
  // Delivery destinations are read at startup and never edited, so the
  // delivery thread can read them without locking.
  std::string webhook_url_;
  // Email delivery is not part of the core collector (see AGENTS.md); an
  // [alerts.smtp] table is ignored with a startup warning.
  bool smtp_ignored_ = false;
};

[[nodiscard]] inline std::string FormatLimit(double p_value)
{
  return DumpJson(NumberJson(p_value));
}

// Checks a complete alert configuration, like the Python validate_alerts.
[[nodiscard]] inline std::expected<void, std::string> ValidateAlerts(
    const AlertSettings& p_alerts)
{
  for (const auto& setting : kNumericSettings)
  {
    const double value = p_alerts.*setting.member_;
    if (!std::isfinite(value) || value <= 0)
    {
      return std::unexpected(
          std::format("alerts.{} must be positive and finite", setting.key_));
    }
  }
  for (const auto& setting : kEditableSettings)
  {
    const double value = p_alerts.*setting.member_;
    if (!(setting.minimum_ <= value && value <= setting.maximum_))
    {
      return std::unexpected(std::format(
          "{} ({}) must be between {} and {}", setting.label_, setting.key_,
          FormatLimit(setting.minimum_), FormatLimit(setting.maximum_)));
    }
  }
  if (!(5 <= p_alerts.window_s_ && p_alerts.window_s_ <= 10))
  {
    return std::unexpected("window_s must be 5..10");
  }
  if (p_alerts.cpu_warn_pct_ >= p_alerts.cpu_crit_pct_)
  {
    return std::unexpected(
        "CPU warning threshold must be below the critical threshold");
  }
  return {};
}

[[nodiscard]] inline std::string EnabledError()
{
  std::string names;
  for (const auto& rule : kRules)
  {
    names += names.empty() ? "" : ", ";
    names += rule.rule_;
  }
  return std::format("alerts.enabled maps rule names ({}) to true or false",
                     names);
}

// Applies numeric keys and an "enabled" table from p_values onto p_alerts.
// Keys not named in kNumericSettings are ignored.
[[nodiscard]] inline std::expected<void, std::string> ApplyAlertValues(
    AlertSettings& p_alerts, const Json& p_values)
{
  for (const auto& setting : kNumericSettings)
  {
    if (const auto* value = p_values.Find(setting.key_))
    {
      if (!value->IsNumber())
      {
        return std::unexpected(
            std::format("alerts.{} must be positive and finite", setting.key_));
      }
      p_alerts.*setting.member_ = value->AsNumber();
    }
  }
  if (const auto* enabled = p_values.Find("enabled"))
  {
    if (!enabled->IsObject())
    {
      return std::unexpected(EnabledError());
    }
    for (const auto& [rule, value] : enabled->AsObject())
    {
      const auto index = RuleIndex(rule);
      if (!index || !value.IsBool())
      {
        return std::unexpected(EnabledError());
      }
      p_alerts.enabled_[*index] = value.AsBool();
    }
  }
  return {};
}

// The part of the alert configuration the dashboard shows and may change.
[[nodiscard]] inline Json EditableJson(const AlertSettings& p_alerts)
{
  Json enabled{JsonObject{}};
  for (std::size_t index = 0; index < kRuleCount; ++index)
  {
    enabled.Set(kRules[index].rule_, p_alerts.enabled_[index]);
  }
  Json result{JsonObject{}};
  result.Set("enabled", std::move(enabled));
  for (const auto& setting : kEditableSettings)
  {
    result.Set(setting.key_, NumberJson(p_alerts.*setting.member_));
  }
  return result;
}

// Returns p_alerts with dashboard changes applied and validated.
[[nodiscard]] inline std::expected<AlertSettings, std::string> MergeSettings(
    const AlertSettings& p_alerts, const Json& p_changes)
{
  if (!p_changes.IsObject())
  {
    return std::unexpected("unknown alert setting");
  }
  for (const auto& [key, value] : p_changes.AsObject())
  {
    const bool known =
        key == "enabled" || std::ranges::any_of(kEditableSettings,
                                                [&](const auto& p_setting)
                                                {
                                                  return p_setting.key_ == key;
                                                });
    if (!known)
    {
      return std::unexpected("unknown alert setting");
    }
  }
  if (const auto* enabled = p_changes.Find("enabled");
      enabled != nullptr && !enabled->IsObject())
  {
    return std::unexpected("enabled must map rule names to true or false");
  }
  AlertSettings merged = p_alerts;
  if (auto status = ApplyAlertValues(merged, p_changes); !status)
  {
    return std::unexpected(status.error());
  }
  if (auto status = ValidateAlerts(merged); !status)
  {
    return std::unexpected(status.error());
  }
  return merged;
}

[[nodiscard]] inline std::filesystem::path SettingsPath(const Config& p_config)
{
  return std::filesystem::path{p_config.data_dir_} / kSettingsFile;
}

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

// Applies saved dashboard changes on top of the TOML alert configuration.
[[nodiscard]] inline std::expected<void, std::string> LoadSettings(
    Config& p_config)
{
  const auto path = SettingsPath(p_config);
  if (!std::filesystem::exists(path))
  {
    return {};
  }
  auto contents = ReadFile(path);
  if (!contents)
  {
    return std::unexpected(contents.error());
  }
  auto changes = ParseJson(*contents);
  if (!changes)
  {
    return std::unexpected(changes.error());
  }
  auto merged = MergeSettings(p_config.alerts_, *changes);
  if (!merged)
  {
    return std::unexpected(merged.error());
  }
  p_config.alerts_ = *merged;
  return {};
}

// Writes to a temporary file and renames it, so a crash never leaves a
// half-written settings file.
[[nodiscard]] inline std::expected<void, std::string> SaveSettings(
    const Config& p_config, const AlertSettings& p_alerts)
{
  std::error_code error;
  std::filesystem::create_directories(p_config.data_dir_, error);
  const auto path = SettingsPath(p_config);
  auto temporary = path;
  temporary += ".tmp";
  {
    std::ofstream file{temporary, std::ios::binary | std::ios::trunc};
    file << DumpJson(EditableJson(p_alerts), 2) << '\n';
    if (!file.flush())
    {
      return std::unexpected(
          std::format("cannot write {}", temporary.string()));
    }
  }
  std::filesystem::rename(temporary, path, error);
  if (error)
  {
    return std::unexpected(error.message());
  }
  return {};
}

inline void ClearSettings(const Config& p_config)
{
  std::error_code error;
  std::filesystem::remove(SettingsPath(p_config), error);
}

// Settings payload for the dashboard: rule metadata, current values and
// defaults.
[[nodiscard]] inline Json DescribeSettings(const AlertSettings& p_alerts,
                                           const AlertSettings& p_defaults,
                                           bool p_saved)
{
  JsonArray rules;
  for (const auto& rule : kRules)
  {
    JsonArray settings;
    for (std::size_t index = 0; index < rule.setting_count_; ++index)
    {
      settings.emplace_back(rule.settings_[index]);
    }
    rules.emplace_back(JsonObject{{"rule", rule.rule_},
                                  {"label", rule.label_},
                                  {"settings", std::move(settings)},
                                  {"description", rule.description_}});
  }
  Json settings{JsonObject{}};
  for (const auto& setting : kEditableSettings)
  {
    settings.Set(setting.key_,
                 JsonObject{{"label", setting.label_},
                            {"unit", setting.unit_},
                            {"min", NumberJson(setting.minimum_)},
                            {"max", NumberJson(setting.maximum_)}});
  }
  return JsonObject{{"rules", std::move(rules)},
                    {"settings", std::move(settings)},
                    {"values", EditableJson(p_alerts)},
                    {"defaults", EditableJson(p_defaults)},
                    {"saved", p_saved}};
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

[[nodiscard]] inline bool IsHttpUrl(std::string_view p_url)
{
  for (const std::string_view scheme : {"http://", "https://"})
  {
    if (p_url.starts_with(scheme))
    {
      const auto rest = p_url.substr(scheme.size());
      return !rest.empty() && rest.find_first_of("/?#") != 0;
    }
  }
  return false;
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

// Parses and validates a collector TOML file with the Python collector's
// defaults and rules. Unknown top-level keys are ignored, as in Python.
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

  const Json empty{JsonObject{}};
  const Json* alerts = root.Find("alerts");
  if (alerts == nullptr)
  {
    alerts = &empty;
  }
  if (!alerts->IsObject())
  {
    return std::unexpected("alerts must be a table");
  }
  if (auto status = ApplyAlertValues(config.alerts_, *alerts); !status)
  {
    return std::unexpected(status.error());
  }
  if (auto status = ValidateAlerts(config.alerts_); !status)
  {
    return std::unexpected(status.error());
  }
  if (auto status =
          detail::ReadString(*alerts, "webhook_url", config.webhook_url_);
      !status)
  {
    return std::unexpected(status.error());
  }
  std::string deadman_url;
  if (auto status = detail::ReadString(root, "deadman_url", deadman_url);
      !status)
  {
    return std::unexpected(status.error());
  }
  if (!deadman_url.empty())
  {
    config.deadman_url_ = deadman_url;
  }
  for (const auto& url : {config.webhook_url_, deadman_url})
  {
    if (!url.empty() && !IsHttpUrl(url))
    {
      return std::unexpected("delivery URLs must be HTTP(S)");
    }
  }
  if (const auto* smtp = alerts->Find("smtp");
      smtp != nullptr && !(smtp->IsObject() && smtp->AsObject().empty()))
  {
    config.smtp_ignored_ = true;
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
  std::error_code error;
  auto data_dir = std::filesystem::absolute(config.data_dir_, error);
  config.data_dir_ = std::filesystem::weakly_canonical(data_dir, error)
                         .lexically_normal()
                         .string();
  if (const auto* hosts = root.Find("http_allowed_hosts"))
  {
    if (!hosts->IsArray())
    {
      return std::unexpected("http_allowed_hosts must be a list of host names");
    }
    for (const auto& host : hosts->AsArray())
    {
      if (!host.IsString() || host.AsString().empty())
      {
        return std::unexpected(
            "http_allowed_hosts must be a list of host names");
      }
      std::string lowered = host.AsString();
      std::ranges::transform(lowered, lowered.begin(),
                             [](unsigned char p_c)
                             {
                               return static_cast<char>(std::tolower(p_c));
                             });
      config.http_allowed_hosts_.push_back(std::move(lowered));
    }
  }
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
