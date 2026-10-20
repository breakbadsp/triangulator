#pragma once

#include <arpa/inet.h>
#include <sys/socket.h>

#include <cmath>
#include <cstring>
#include <expected>
#include <format>
#include <string>
#include <variant>
#include <vector>

#include "../common/target_wire.hpp"
#include "io.hpp"
#include "parsing.hpp"

namespace triangulator
{

struct TargetPid
{
  int value_;
  bool operator==(const TargetPid&) const = default;
};
struct TargetName
{
  std::string value_;
  bool operator==(const TargetName&) const = default;
};
using TargetSelector = std::variant<TargetPid, TargetName>;

struct TargetConfig
{
  std::string id_;
  TargetSelector selector_ = TargetPid{0};
  bool operator==(const TargetConfig&) const = default;
};

struct Config
{
  TargetSelector target_ = TargetPid{0};
  std::vector<TargetConfig> targets_;
  double rate_hz_ = 5.0;
  std::string collector_;
  bool status_fallback_ = false;
  // Seconds between resource samples (pressure, descriptors, sockets); 0
  // turns them off.
  int resource_interval_s_ = 2;
  // Seconds between memory-map samples (/proc/PID/maps and the summary
  // files); 0 turns them off.
  int memory_interval_s_ = 30;

  [[nodiscard]] Nanoseconds Interval() const noexcept
  {
    return std::chrono::duration_cast<Nanoseconds>(
        std::chrono::duration<double>{1.0 / rate_hz_});
  }
  [[nodiscard]] std::uint32_t IntervalMs() const noexcept
  {
    return static_cast<std::uint32_t>(
        std::chrono::round<std::chrono::milliseconds>(Interval()).count());
  }
};

[[nodiscard]] inline std::expected<Config, std::string> ParseConfig(
    std::string_view p_contents)
{
  Config config;
  bool target_set = false;
  bool in_target = false;
  std::array<std::string_view, 7> keys{};
  std::size_t key_count = 0;
  while (!p_contents.empty())
  {
    const auto end = p_contents.find('\n');
    auto line = p_contents.substr(0, end);
    p_contents = end == std::string_view::npos ? std::string_view{}
                                               : p_contents.substr(end + 1);
    if (line.size() > 1023)
    {
      return std::unexpected("configuration line exceeds 1023 bytes");
    }
    bool quoted = false;
    for (std::size_t index = 0; index < line.size(); ++index)
    {
      if (line[index] == '"')
      {
        quoted = !quoted;
      }
      if (line[index] == '#' && !quoted)
      {
        line = line.substr(0, index);
        break;
      }
    }
    if (quoted)
    {
      return std::unexpected("unterminated quoted value");
    }
    line = Trim(line);
    if (line.empty())
    {
      continue;
    }
    if (line == "[[target]]")
    {
      if (target_set)
      {
        return std::unexpected(
            "use target tables or a top-level target, not both");
      }
      if (config.targets_.size() == target_wire::kMaxTargets)
      {
        return std::unexpected("at most 16 targets are permitted");
      }
      config.targets_.push_back({});
      in_target = true;
      keys = {};
      key_count = 0;
      continue;
    }
    const auto separator = line.find('=');
    if (separator == std::string_view::npos)
    {
      return std::unexpected("expected key = value");
    }
    const auto key = Trim(line.substr(0, separator));
    auto value = Trim(line.substr(separator + 1));
    if (std::ranges::find(keys, key) != keys.end())
    {
      return std::unexpected("duplicate or empty configuration key");
    }
    if (key_count == keys.size())
    {
      return std::unexpected("too many configuration keys");
    }
    keys[key_count++] = key;
    if (value.size() >= 2 && value.front() == '"' && value.back() == '"')
    {
      value = value.substr(1, value.size() - 2);
    }
    if (value.find('"') != std::string_view::npos)
    {
      return std::unexpected("embedded quotes are unsupported");
    }
    if (in_target)
    {
      auto& target = config.targets_.back();
      if (key == "id")
      {
        if (!target_wire::ValidName(value, 31))
        {
          return std::unexpected(
              "target id must contain 1..31 letters, digits, dots, "
              "underscores, or hyphens");
        }
        target.id_ = value;
      }
      else if (key == "pid" || key == "process")
      {
        if (std::get_if<TargetName>(&target.selector_) ||
            std::get<TargetPid>(target.selector_).value_ != 0)
        {
          return std::unexpected(
              "each target needs exactly one pid or process");
        }
        if (key == "pid")
        {
          const auto pid = ParseNumber<int>(value);
          if (!pid || *pid <= 0)
          {
            return std::unexpected("target pid must be positive");
          }
          target.selector_ = TargetPid{*pid};
        }
        else
        {
          if (value.empty() || value.size() > 15 ||
              value.find('\0') != std::string_view::npos)
          {
            return std::unexpected("target process must contain 1..15 bytes");
          }
          target.selector_ = TargetName{std::string{value}};
        }
      }
      else
      {
        return std::unexpected(std::format("unknown target key: {}", key));
      }
      continue;
    }
    if (key == "target_pid" || key == "target_process")
    {
      if (target_set)
      {
        return std::unexpected(
            "set exactly one of target_pid and target_process");
      }
      target_set = true;
      if (key == "target_pid")
      {
        const auto pid = ParseNumber<int>(value);
        if (!pid || *pid <= 0)
        {
          return std::unexpected("target_pid must be a positive integer");
        }
        config.target_ = TargetPid{*pid};
      }
      else
      {
        if (value.empty() || value.size() > 15)
        {
          return std::unexpected("target_process must contain 1..15 bytes");
        }
        config.target_ = TargetName{std::string{value}};
      }
    }
    else if (key == "rate_hz")
    {
      const auto rate = ParseNumber<double>(value);
      if (!rate || !std::isfinite(*rate) || *rate < 0.2 || *rate > 10.0)
      {
        return std::unexpected("rate_hz must be between 0.2 and 10");
      }
      config.rate_hz_ = *rate;
    }
    else if (key == "collector")
    {
      if (value.empty() || value.size() > 255)
      {
        return std::unexpected("invalid collector address length");
      }
      config.collector_ = value;
    }
    else if (key == "status_fallback")
    {
      if (value != "true" && value != "false")
      {
        return std::unexpected("status_fallback must be true or false");
      }
      config.status_fallback_ = value == "true";
    }
    else if (key == "resource_interval_s")
    {
      const auto seconds = ParseNumber<int>(value);
      if (!seconds || *seconds < 0 || *seconds > 60)
      {
        return std::unexpected(
            "resource_interval_s must be 0 (off) or 1..60 seconds");
      }
      config.resource_interval_s_ = *seconds;
    }
    else if (key == "memory_interval_s")
    {
      const auto seconds = ParseNumber<int>(value);
      if (!seconds || *seconds < 0 || *seconds > 3600)
      {
        return std::unexpected(
            "memory_interval_s must be 0 (off) or 1..3600 seconds");
      }
      config.memory_interval_s_ = *seconds;
    }
    else
    {
      return std::unexpected(std::format("unknown configuration key: {}", key));
    }
  }
  if (in_target)
  {
    for (std::size_t index = 0; index < config.targets_.size(); ++index)
    {
      const auto& target = config.targets_[index];
      const auto* pid = std::get_if<TargetPid>(&target.selector_);
      if (target.id_.empty() || (pid && pid->value_ == 0))
      {
        return std::unexpected("each target needs an id and a pid or process");
      }
      for (std::size_t previous = 0; previous < index; ++previous)
      {
        if (config.targets_[previous].id_ == target.id_)
        {
          return std::unexpected("target ids must be unique");
        }
      }
    }
    config.target_ = config.targets_.front().selector_;
  }
  else if (target_set)
  {
    config.targets_.push_back({"default", config.target_});
  }
  if (config.targets_.empty() || config.collector_.empty())
  {
    return std::unexpected("target and collector are required");
  }
  return config;
}

struct Endpoint
{
  FileDescriptor socket_;
  sockaddr_storage address_{};
  socklen_t address_length_{};
};

[[nodiscard]] inline std::expected<Endpoint, std::string> MakeEndpoint(
    std::string_view p_collector)
{
  const auto separator = p_collector.rfind(':');
  if (separator == std::string_view::npos)
  {
    return std::unexpected("collector must be numeric-IP:port");
  }
  auto host = p_collector.substr(0, separator);
  const auto port = p_collector.substr(separator + 1);
  const auto port_number = ParseNumber<unsigned>(port);
  if (!port_number || *port_number == 0 || *port_number > 65535)
  {
    return std::unexpected("collector port must be 1..65535");
  }
  const bool ipv6 = host.starts_with('[');
  if (ipv6)
  {
    if (!host.ends_with(']'))
    {
      return std::unexpected("invalid bracketed IPv6 address");
    }
    host = host.substr(1, host.size() - 2);
  }
  // Numeric addresses need no resolver or glibc NSS modules in a static build.
  Endpoint endpoint;
  const int family = ipv6 ? AF_INET6 : AF_INET;
  const auto host_text = std::string{host};
  int parsed = 0;
  if (ipv6)
  {
    sockaddr_in6 address{};
    address.sin6_family = AF_INET6;
    address.sin6_port = ::htons(static_cast<std::uint16_t>(*port_number));
    parsed = ::inet_pton(AF_INET6, host_text.c_str(), &address.sin6_addr);
    std::memcpy(&endpoint.address_, &address, sizeof(address));
    endpoint.address_length_ = sizeof(address);
  }
  else
  {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = ::htons(static_cast<std::uint16_t>(*port_number));
    parsed = ::inet_pton(AF_INET, host_text.c_str(), &address.sin_addr);
    std::memcpy(&endpoint.address_, &address, sizeof(address));
    endpoint.address_length_ = sizeof(address);
  }
  if (parsed != 1)
  {
    return std::unexpected(
        "collector requires a numeric IPv4 or [IPv6] address");
  }
  endpoint.socket_ = FileDescriptor{
      ::socket(family, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0)};
  if (!endpoint.socket_)
  {
    return std::unexpected(
        std::format("socket: {}", std::generic_category().message(errno)));
  }
  return endpoint;
}

struct RuntimeConfig
{
  Config settings_;
  Endpoint endpoint_;
};

[[nodiscard]] inline std::expected<RuntimeConfig, std::string> LoadConfig(
    const char* p_path)
{
  const auto descriptor = OpenReadonly(p_path);
  std::array<char, 16384> buffer{};
  const auto contents = ReadAtStart(descriptor, buffer);
  if (!contents)
  {
    return std::unexpected(
        "cannot read configuration (must be nonempty and smaller than 16 KiB)");
  }
  auto config = ParseConfig(*contents);
  if (!config)
  {
    return std::unexpected(config.error());
  }
  auto endpoint = MakeEndpoint(config->collector_);
  if (!endpoint)
  {
    return std::unexpected(endpoint.error());
  }
  return RuntimeConfig{std::move(*config), std::move(*endpoint)};
}

}  // namespace triangulator
