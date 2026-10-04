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
#include <sstream>
#include <string>
#include <string_view>
#include <vector>

#include "json.hpp"
#include "toml.hpp"

namespace triangulator::collector
{

struct GroupRule
{
  std::string name_;
  std::string prefix_;
};

// The collector's settings. The same file holds the alerting module's
// settings, so alert keys may be present; the collector does no alerting and
// ignores them, apart from [alerts] window_s, which sets the rollup window.
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

// Parses and validates a collector TOML file, with the defaults the retired
// Python collector used. Unknown keys are ignored, as they were there.
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
