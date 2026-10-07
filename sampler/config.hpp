#pragma once

#include <arpa/inet.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cmath>
#include <cstring>
#include <expected>
#include <format>
#include <string>
#include <variant>
#include <vector>

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

struct Config
{
  TargetSelector target_ = TargetPid{0};
  double rate_hz_ = 1.0;
  std::string collector_;
  bool status_fallback_ = false;
  // Seconds between resource samples (pressure, descriptors, sockets); 0
  // turns them off.
  int resource_interval_s_ = 5;
  // The memory-map thread (docs/process-memory-map-design.md, section 14).
  // Off unless the configuration turns it on.
  bool memory_map_enabled_ = false;
  std::string memory_map_listen_ = "127.0.0.1:9402";
  std::string memory_map_token_file_;
  int memory_map_interval_s_ = 2;
  int memory_map_keyframe_s_ = 30;
  int memory_map_max_vmas_ = 8192;
  int memory_map_max_lease_s_ = 15;

  // True when p_other samples threads and resources the same way. A reload
  // that changes only memory_map_* keys keeps the session.
  [[nodiscard]] bool SameSampling(const Config& p_other) const
  {
    return target_ == p_other.target_ && rate_hz_ == p_other.rate_hz_ &&
           collector_ == p_other.collector_ &&
           status_fallback_ == p_other.status_fallback_ &&
           resource_interval_s_ == p_other.resource_interval_s_;
  }

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
  std::array<std::string_view, 13> keys{};
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
    else if (key == "memory_map_enabled")
    {
      if (value != "true" && value != "false")
      {
        return std::unexpected("memory_map_enabled must be true or false");
      }
      config.memory_map_enabled_ = value == "true";
    }
    else if (key == "memory_map_listen")
    {
      if (value.empty() || value.size() > 255)
      {
        return std::unexpected("invalid memory_map_listen address length");
      }
      config.memory_map_listen_ = value;
    }
    else if (key == "memory_map_token_file")
    {
      if (value.empty() || value.size() > 1023)
      {
        return std::unexpected("invalid memory_map_token_file path length");
      }
      config.memory_map_token_file_ = value;
    }
    else if (key.starts_with("memory_map_"))
    {
      // The numeric keys: name, member, lowest and highest value.
      struct Range
      {
        std::string_view key_;
        int Config::* member_;
        int lowest_;
        int highest_;
      };
      constexpr std::array<Range, 4> kRanges{
          Range{"memory_map_interval_s", &Config::memory_map_interval_s_, 1,
                60},
          Range{"memory_map_keyframe_s", &Config::memory_map_keyframe_s_, 5,
                300},
          Range{"memory_map_max_vmas", &Config::memory_map_max_vmas_, 256,
                65536},
          Range{"memory_map_max_lease_s", &Config::memory_map_max_lease_s_, 5,
                60}};
      const auto range = std::ranges::find(kRanges, key, &Range::key_);
      if (range == kRanges.end())
      {
        return std::unexpected(
            std::format("unknown configuration key: {}", key));
      }
      const auto number = ParseNumber<int>(value);
      if (!number || *number < range->lowest_ || *number > range->highest_)
      {
        return std::unexpected(std::format("{} must be {}..{}", key,
                                           range->lowest_, range->highest_));
      }
      config.*(range->member_) = *number;
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
  if (config.memory_map_keyframe_s_ < config.memory_map_interval_s_)
  {
    return std::unexpected(
        "memory_map_keyframe_s must not be less than memory_map_interval_s");
  }
  if (config.memory_map_enabled_ && config.memory_map_token_file_.empty())
  {
    return std::unexpected(
        "memory_map_enabled = true needs memory_map_token_file");
  }
  return config;
}

struct SocketAddress
{
  sockaddr_storage address_{};
  socklen_t length_{};

  [[nodiscard]] int Family() const noexcept
  {
    return address_.ss_family;
  }
  [[nodiscard]] const sockaddr* Get() const noexcept
  {
    return reinterpret_cast<const sockaddr*>(&address_);
  }
};

// Parses "numeric-IPv4:port" or "[numeric-IPv6]:port". p_what names the
// setting in error messages.
[[nodiscard]] inline std::expected<SocketAddress, std::string> ParseAddress(
    std::string_view p_text, std::string_view p_what)
{
  const auto separator = p_text.rfind(':');
  if (separator == std::string_view::npos)
  {
    return std::unexpected(std::format("{} must be numeric-IP:port", p_what));
  }
  auto host = p_text.substr(0, separator);
  const auto port = p_text.substr(separator + 1);
  const auto port_number = ParseNumber<unsigned>(port);
  if (!port_number || *port_number == 0 || *port_number > 65535)
  {
    return std::unexpected(std::format("{} port must be 1..65535", p_what));
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
  SocketAddress result;
  const auto host_text = std::string{host};
  int parsed = 0;
  if (ipv6)
  {
    sockaddr_in6 address{};
    address.sin6_family = AF_INET6;
    address.sin6_port = ::htons(static_cast<std::uint16_t>(*port_number));
    parsed = ::inet_pton(AF_INET6, host_text.c_str(), &address.sin6_addr);
    std::memcpy(&result.address_, &address, sizeof(address));
    result.length_ = sizeof(address);
  }
  else
  {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = ::htons(static_cast<std::uint16_t>(*port_number));
    parsed = ::inet_pton(AF_INET, host_text.c_str(), &address.sin_addr);
    std::memcpy(&result.address_, &address, sizeof(address));
    result.length_ = sizeof(address);
  }
  if (parsed != 1)
  {
    return std::unexpected(
        std::format("{} requires a numeric IPv4 or [IPv6] address", p_what));
  }
  return result;
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
  auto address = ParseAddress(p_collector, "collector");
  if (!address)
  {
    return std::unexpected(std::move(address.error()));
  }
  Endpoint endpoint;
  endpoint.address_ = address->address_;
  endpoint.address_length_ = address->length_;
  endpoint.socket_ = FileDescriptor{::socket(
      address->Family(), SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0)};
  if (!endpoint.socket_)
  {
    return std::unexpected(
        std::format("socket: {}", std::generic_category().message(errno)));
  }
  return endpoint;
}

// Reads the memory-map token. Other local users can send UDP to any port,
// so the token is the only proof that a request comes from the collector:
// the file must be a regular file of this user that no other user can
// read or write, and hold at least 32 characters on its first
// line.
[[nodiscard]] inline std::expected<std::vector<std::uint8_t>, std::string>
LoadToken(const std::string& p_path)
{
  const FileDescriptor descriptor{
      ::open(p_path.c_str(), O_RDONLY | O_CLOEXEC | O_NOFOLLOW)};
  if (!descriptor)
  {
    return std::unexpected(
        std::format("cannot open memory_map_token_file {}: {}", p_path,
                    std::generic_category().message(errno)));
  }
  struct stat status{};
  if (::fstat(descriptor.Get(), &status) != 0 || !S_ISREG(status.st_mode))
  {
    return std::unexpected("memory_map_token_file must be a regular file");
  }
  if (status.st_uid != ::geteuid() || (status.st_mode & 077) != 0)
  {
    return std::unexpected(
        "memory_map_token_file must belong to the sampler user and have mode "
        "0600 or 0400");
  }
  std::array<char, 4096> buffer{};
  const auto contents = ReadAtStart(descriptor, buffer);
  const auto line = contents ? Trim(contents->substr(0, contents->find('\n')))
                             : std::string_view{};
  if (line.size() < 32)
  {
    return std::unexpected(
        "memory_map_token_file must hold a token of at least 32 characters");
  }
  return std::vector<std::uint8_t>(line.begin(), line.end());
}

// The memory-map settings that need I/O to check: the listen address and
// the token. Empty when the feature is off.
struct MemoryMapRuntime
{
  SocketAddress listen_;
  std::vector<std::uint8_t> token_;
};

struct RuntimeConfig
{
  Config settings_;
  Endpoint endpoint_;
  std::optional<MemoryMapRuntime> memory_map_;
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
  std::optional<MemoryMapRuntime> memory_map;
  if (config->memory_map_enabled_)
  {
    auto listen = ParseAddress(config->memory_map_listen_, "memory_map_listen");
    if (!listen)
    {
      return std::unexpected(std::move(listen.error()));
    }
    auto token = LoadToken(config->memory_map_token_file_);
    if (!token)
    {
      return std::unexpected(std::move(token.error()));
    }
    memory_map = MemoryMapRuntime{*listen, std::move(*token)};
  }
  return RuntimeConfig{std::move(*config), std::move(*endpoint),
                       std::move(memory_map)};
}

}  // namespace triangulator
