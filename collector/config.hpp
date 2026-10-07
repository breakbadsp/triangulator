#pragma once

#include <arpa/inet.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <charconv>
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

#include "../common/memory_wire.hpp"
#include "json.hpp"
#include "toml.hpp"

namespace triangulator::collector
{

// The largest max_live_samples. The Monitor reserves about 280 bytes of
// address space for each live sample at startup, so this limit is about
// 2.8 GB. A larger value could make the reservation fail.
inline constexpr std::int64_t kMaxLiveSamplesLimit = 10'000'000;

// [memory_map] (docs/process-memory-map-design.md, section 14). Present
// only when enabled = true.
struct MemoryMapConfig
{
  // The sampler's memory_map_listen address.
  std::string sampler_control_;
  sockaddr_storage address_{};
  socklen_t address_length_{};
  std::string token_file_;
  std::vector<std::uint8_t> token_;  // read by LoadConfig
  std::int64_t retention_days_ = 7;
};

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
  // Dashboard recording cadence; zero (the default) disables recording.
  double replay_interval_s_ = 0;
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
  std::optional<MemoryMapConfig> memory_map_;
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

// Parses "IPv4:port" or "[IPv6]:port", with numeric addresses only.
[[nodiscard]] inline std::optional<std::pair<sockaddr_storage, socklen_t>>
ParseSocketAddress(std::string_view p_text)
{
  const auto separator = p_text.rfind(':');
  if (separator == std::string_view::npos)
  {
    return std::nullopt;
  }
  auto host = p_text.substr(0, separator);
  unsigned port = 0;
  const auto port_text = p_text.substr(separator + 1);
  if (std::from_chars(port_text.data(), port_text.data() + port_text.size(),
                      port)
              .ptr != port_text.data() + port_text.size() ||
      port == 0 || port > 65535)
  {
    return std::nullopt;
  }
  sockaddr_storage address{};
  const bool ipv6 = host.starts_with('[') && host.ends_with(']');
  const std::string host_text{ipv6 ? host.substr(1, host.size() - 2) : host};
  if (ipv6)
  {
    auto& ipv6_address = reinterpret_cast<sockaddr_in6&>(address);
    ipv6_address.sin6_family = AF_INET6;
    ipv6_address.sin6_port = htons(static_cast<std::uint16_t>(port));
    if (::inet_pton(AF_INET6, host_text.c_str(), &ipv6_address.sin6_addr) != 1)
    {
      return std::nullopt;
    }
    return std::pair{address, socklen_t{sizeof(sockaddr_in6)}};
  }
  auto& ipv4_address = reinterpret_cast<sockaddr_in&>(address);
  ipv4_address.sin_family = AF_INET;
  ipv4_address.sin_port = htons(static_cast<std::uint16_t>(port));
  if (::inet_pton(AF_INET, host_text.c_str(), &ipv4_address.sin_addr) != 1)
  {
    return std::nullopt;
  }
  return std::pair{address, socklen_t{sizeof(sockaddr_in)}};
}

[[nodiscard]] inline std::expected<std::optional<MemoryMapConfig>, std::string>
ParseMemoryMap(const Json& p_root, std::int64_t p_retention_days)
{
  const auto* table = p_root.Find("memory_map");
  if (table == nullptr)
  {
    return std::nullopt;
  }
  if (!table->IsObject())
  {
    return std::unexpected("memory_map must be a table");
  }
  const auto* enabled = table->Find("enabled");
  if (enabled != nullptr && !enabled->IsBool())
  {
    return std::unexpected("memory_map enabled must be true or false");
  }
  if (enabled == nullptr || !enabled->AsBool())
  {
    return std::nullopt;
  }
  MemoryMapConfig config;
  const auto* control = table->Find("sampler_control");
  const auto* token = table->Find("token_file");
  if (control == nullptr || !control->IsString() || token == nullptr ||
      !token->IsString() || token->AsString().empty())
  {
    return std::unexpected(
        "memory_map needs sampler_control and token_file when enabled");
  }
  const auto address = ParseSocketAddress(control->AsString());
  if (!address)
  {
    return std::unexpected(
        "memory_map sampler_control must be numeric-IPv4:port or "
        "[numeric-IPv6]:port");
  }
  config.sampler_control_ = control->AsString();
  config.address_ = address->first;
  config.address_length_ = address->second;
  config.token_file_ = token->AsString();
  if (const auto* days = table->Find("retention_days"))
  {
    if (!days->IsInt() || days->AsInt() < 1 || days->AsInt() > 90)
    {
      return std::unexpected("memory_map retention_days must be 1..90");
    }
    config.retention_days_ = days->AsInt();
  }
  if (config.retention_days_ > p_retention_days)
  {
    return std::unexpected(
        "memory_map retention_days must not exceed retention_days");
  }
  return config;
}

}  // namespace detail

// Reads the memory-map token with the sampler's rules: a regular file of
// this user that no other user can read or write, whose first line has at
// least 32 characters.
[[nodiscard]] inline std::expected<std::vector<std::uint8_t>, std::string>
ReadMemoryMapToken(const std::string& p_path)
{
  struct stat status{};
  if (::lstat(p_path.c_str(), &status) != 0 || !S_ISREG(status.st_mode))
  {
    return std::unexpected(
        std::format("memory_map token_file {} must be a regular file", p_path));
  }
  if (status.st_uid != ::geteuid() || (status.st_mode & 077) != 0)
  {
    return std::unexpected(
        "memory_map token_file must belong to the collector user and have "
        "mode 0600 or 0400");
  }
  auto contents = ReadFile(p_path);
  if (!contents)
  {
    return std::unexpected(contents.error());
  }
  std::string_view line{*contents};
  line = line.substr(0, line.find('\n'));
  while (!line.empty() &&
         (line.back() == ' ' || line.back() == '\t' || line.back() == '\r'))
  {
    line.remove_suffix(1);
  }
  while (!line.empty() && (line.front() == ' ' || line.front() == '\t'))
  {
    line.remove_prefix(1);
  }
  if (line.size() < memory_wire::kMinTokenSize)
  {
    return std::unexpected(
        "memory_map token_file must hold a token of at least 32 characters");
  }
  return std::vector<std::uint8_t>(line.begin(), line.end());
}

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
  if (config.max_live_samples_ > kMaxLiveSamplesLimit)
  {
    return std::unexpected(std::format("max_live_samples must be at most {}",
                                       kMaxLiveSamplesLimit));
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
  auto memory_map = detail::ParseMemoryMap(root, config.retention_days_);
  if (!memory_map)
  {
    return std::unexpected(memory_map.error());
  }
  config.memory_map_ = std::move(*memory_map);
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
  auto config = ParseConfig(*contents);
  if (config && config->memory_map_)
  {
    auto token = ReadMemoryMapToken(config->memory_map_->token_file_);
    if (!token)
    {
      return std::unexpected(token.error());
    }
    config->memory_map_->token_ = std::move(*token);
  }
  return config;
}

}  // namespace triangulator::collector
