#pragma once

#include <netdb.h>
#include <sys/socket.h>

#include <cmath>
#include <expected>
#include <format>
#include <string>
#include <variant>

#include "io.hpp"
#include "parsing.hpp"

namespace triangulator
{

struct TargetPid
{
  int value_;
};
struct TargetName
{
  std::string value_;
};
using TargetSelector = std::variant<TargetPid, TargetName>;

struct Config
{
  TargetSelector target_ = TargetPid{0};
  double rate_hz_ = 1.0;
  std::string collector_;
  bool status_fallback_ = false;

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
  std::array<std::string_view, 5> keys{};
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
    else
    {
      return std::unexpected(std::format("unknown configuration key: {}", key));
    }
  }
  if (!target_set || config.collector_.empty())
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

struct AddressInfoCloser
{
  void operator()(addrinfo* p_address) const noexcept
  {
    ::freeaddrinfo(p_address);
  }
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
  if (host.starts_with('['))
  {
    if (!host.ends_with(']'))
    {
      return std::unexpected("invalid bracketed IPv6 address");
    }
    host = host.substr(1, host.size() - 2);
  }
  addrinfo hints{};
  hints.ai_flags = AI_NUMERICHOST | AI_NUMERICSERV;
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_DGRAM;
  addrinfo* raw_address = nullptr;
  const auto error =
      ::getaddrinfo(std::string{host}.c_str(), std::string{port}.c_str(),
                    &hints, &raw_address);
  if (error != 0)
  {
    return std::unexpected(std::format("collector requires a numeric IP: {}",
                                       ::gai_strerror(error)));
  }
  const std::unique_ptr<addrinfo, AddressInfoCloser> address{raw_address};
  Endpoint endpoint;
  endpoint.socket_ = FileDescriptor{::socket(
      address->ai_family, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0)};
  if (!endpoint.socket_)
  {
    return std::unexpected(
        std::format("socket: {}", std::generic_category().message(errno)));
  }
  std::ranges::copy(
      std::span{reinterpret_cast<const std::byte*>(address->ai_addr),
                address->ai_addrlen},
      reinterpret_cast<std::byte*>(&endpoint.address_));
  endpoint.address_length_ = address->ai_addrlen;
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
