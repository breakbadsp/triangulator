#pragma once

#include <arpa/inet.h>
#include <sys/socket.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <expected>
#include <format>
#include <string>
#include <vector>

#include "../common/target_wire.hpp"
#include "io.hpp"
#include "parsing.hpp"

namespace triangulator
{

// Limits of the discovery lists. A rule or a process name has at most 15
// bytes, the Linux comm limit; longer text could never match.
inline constexpr std::size_t kMaxRules = target_wire::kMaxTargets;
inline constexpr std::size_t kMaxRuleBytes = 15;

struct Config
{
  // Discovery rules. Together they hold at least one entry.
  std::vector<std::string> process_names_;
  std::vector<std::string> process_patterns_;
  // Exact names from process_names. Their targets keep rate_hz when the CPU
  // budget throttles, up to critical_extra_budget_pct above the budget.
  std::vector<std::string> critical_names_;
  // Preallocated discovery slots. Each one costs about 0.5 MB of memory.
  std::size_t max_targets_ = 8;
  double rate_hz_ = 5.0;
  double cpu_budget_pct_ = 10.0;
  double critical_extra_budget_pct_ = 5.0;
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

// ASCII case folding. Process names are bytes, so locale rules do not apply.
[[nodiscard]] constexpr char FoldCase(char p_character) noexcept
{
  return p_character >= 'A' && p_character <= 'Z'
             ? static_cast<char>(p_character - 'A' + 'a')
             : p_character;
}

[[nodiscard]] constexpr bool EqualFoldCase(std::string_view p_left,
                                           std::string_view p_right) noexcept
{
  return std::ranges::equal(p_left, p_right, {}, FoldCase, FoldCase);
}

// '*' matches any bytes, '?' matches one byte, and every other byte matches
// itself with ASCII case ignored, so "T3*" matches "t3code". One backtrack
// point keeps the work at most name x pattern steps for these 15-byte strings,
// with no allocation.
[[nodiscard]] constexpr bool GlobMatch(std::string_view p_pattern,
                                       std::string_view p_name) noexcept
{
  std::size_t pattern = 0;
  std::size_t name = 0;
  std::size_t star = std::string_view::npos;
  std::size_t star_name = 0;
  while (name < p_name.size())
  {
    if (pattern < p_pattern.size() &&
        (p_pattern[pattern] == '?' ||
         FoldCase(p_pattern[pattern]) == FoldCase(p_name[name])))
    {
      ++pattern;
      ++name;
    }
    else if (pattern < p_pattern.size() && p_pattern[pattern] == '*')
    {
      star = pattern++;
      star_name = name;
    }
    else if (star != std::string_view::npos)
    {
      pattern = star + 1;
      name = ++star_name;
    }
    else
    {
      return false;
    }
  }
  while (pattern < p_pattern.size() && p_pattern[pattern] == '*')
  {
    ++pattern;
  }
  return pattern == p_pattern.size();
}

// Reads the quoted strings of a TOML array body, without its brackets. A
// comma inside quotes belongs to the string; a trailing comma is allowed.
[[nodiscard]] inline std::expected<std::vector<std::string>, std::string>
ParseStringArray(std::string_view p_key, std::string_view p_items)
{
  std::vector<std::string> items;
  std::size_t index = 0;
  while (index < p_items.size())
  {
    const char character = p_items[index];
    if (character == ' ' || character == '\t')
    {
      ++index;
      continue;
    }
    if (character != '"')
    {
      return std::unexpected(
          std::format("{} must be a list of quoted strings", p_key));
    }
    const auto end = p_items.find('"', index + 1);
    if (end == std::string_view::npos)
    {
      return std::unexpected(
          std::format("{} has an unterminated string", p_key));
    }
    items.emplace_back(p_items.substr(index + 1, end - index - 1));
    index = end + 1;
    while (index < p_items.size() &&
           (p_items[index] == ' ' || p_items[index] == '\t'))
    {
      ++index;
    }
    if (index < p_items.size())
    {
      if (p_items[index] != ',')
      {
        return std::unexpected(
            std::format("{} items must be separated by commas", p_key));
      }
      ++index;
    }
  }
  return items;
}

[[nodiscard]] inline std::expected<void, std::string> ValidateRules(
    const Config& p_config)
{
  if (p_config.process_names_.size() + p_config.process_patterns_.size() >
      kMaxRules)
  {
    return std::unexpected(std::format(
        "process_names and process_patterns permit at most {} entries",
        kMaxRules));
  }
  for (const auto& name : p_config.process_names_)
  {
    // A name is also its target ID, so it uses the ID bytes. Select other
    // names with a pattern, such as "Web?Content".
    if (!target_wire::ValidName(name, kMaxRuleBytes))
    {
      return std::unexpected(std::format(
          "process name \"{}\" must contain 1..15 letters, digits, dots, "
          "underscores, or hyphens (Linux keeps 15 bytes of a process name; "
          "use process_patterns for other names)",
          name));
    }
    if (std::ranges::count(p_config.process_names_, name) > 1)
    {
      return std::unexpected(
          std::format("process name \"{}\" is listed twice", name));
    }
  }
  for (const auto& name : p_config.critical_names_)
  {
    if (!std::ranges::contains(p_config.process_names_, name))
    {
      return std::unexpected(
          std::format("critical name \"{}\" is not in process_names", name));
    }
    if (std::ranges::count(p_config.critical_names_, name) > 1)
    {
      return std::unexpected(
          std::format("critical name \"{}\" is listed twice", name));
    }
  }
  for (const auto& pattern : p_config.process_patterns_)
  {
    if (pattern.empty() || pattern.size() > kMaxRuleBytes ||
        pattern.find_first_of(std::string_view{"[]\\\0", 4}) !=
            std::string::npos)
    {
      return std::unexpected(std::format(
          "process pattern \"{}\" must contain 1..15 bytes without [, ], "
          "or a backslash",
          pattern));
    }
    if (pattern.find_first_of("*?") == std::string::npos)
    {
      return std::unexpected(std::format(
          "process pattern \"{}\" has no * or ?; list it in process_names",
          pattern));
    }
    // Patterns that differ only in case select the same processes.
    if (std::ranges::count_if(p_config.process_patterns_,
                              [&pattern](const std::string& p_other)
                              {
                                return EqualFoldCase(p_other, pattern);
                              }) > 1)
    {
      return std::unexpected(
          std::format("process pattern \"{}\" is listed twice", pattern));
    }
  }
  return {};
}

[[nodiscard]] inline std::expected<Config, std::string> ParseConfig(
    std::string_view p_contents)
{
  Config config;
  std::array<std::string_view, 14> keys{};
  std::size_t key_count = 0;
  // A multi-line array: its key and the item text read so far.
  std::string_view array_key;
  std::string array_items;
  const auto finish_array =
      [&config](std::string_view p_key,
                std::string_view p_items) -> std::expected<void, std::string>
  {
    auto items = ParseStringArray(p_key, p_items);
    if (!items)
    {
      return std::unexpected(items.error());
    }
    (p_key == "process_names"    ? config.process_names_
     : p_key == "critical_names" ? config.critical_names_
                                 : config.process_patterns_) =
        std::move(*items);
    return {};
  };
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
    if (!array_key.empty())
    {
      const auto close = line.find(']');
      array_items += ' ';
      array_items += line.substr(0, close);
      if (close == std::string_view::npos)
      {
        continue;
      }
      if (!Trim(line.substr(close + 1)).empty())
      {
        return std::unexpected("unexpected text after ]");
      }
      if (auto finished = finish_array(array_key, array_items); !finished)
      {
        return std::unexpected(finished.error());
      }
      array_key = {};
      continue;
    }
    if (line == "[[target]]")
    {
      return std::unexpected(
          "[[target]] tables were removed; select processes by name: "
          "process_names = [\"name\", ...]");
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
    if (key == "process_names" || key == "process_patterns" ||
        key == "critical_names")
    {
      if (!value.starts_with('['))
      {
        return std::unexpected(std::format("{} must be a list", key));
      }
      const auto close = value.find(']');
      if (close == std::string_view::npos)
      {
        array_key = key;
        array_items = value.substr(1);
        continue;
      }
      if (!Trim(value.substr(close + 1)).empty())
      {
        return std::unexpected("unexpected text after ]");
      }
      if (auto finished = finish_array(key, value.substr(1, close - 1));
          !finished)
      {
        return std::unexpected(finished.error());
      }
      continue;
    }
    if (value.size() >= 2 && value.front() == '"' && value.back() == '"')
    {
      value = value.substr(1, value.size() - 2);
    }
    if (value.find('"') != std::string_view::npos)
    {
      return std::unexpected("embedded quotes are unsupported");
    }
    if (key == "target_process")
    {
      return std::unexpected(std::format(
          "target_process was removed; use process_names = [\"{}\"]", value));
    }
    if (key == "target_pid")
    {
      return std::unexpected(
          "target_pid was removed; select the process by name: "
          "process_names = [\"name\"]");
    }
    if (key == "rate_hz")
    {
      const auto rate = ParseNumber<double>(value);
      if (!rate || !std::isfinite(*rate) || *rate < 0.2 || *rate > 10.0)
      {
        return std::unexpected("rate_hz must be between 0.2 and 10");
      }
      config.rate_hz_ = *rate;
    }
    else if (key == "cpu_budget_pct")
    {
      const auto budget = ParseNumber<double>(value);
      if (!budget || !std::isfinite(*budget) || *budget < 0.01 || *budget > 100)
      {
        return std::unexpected("cpu_budget_pct must be 0.01..100");
      }
      config.cpu_budget_pct_ = *budget;
    }
    else if (key == "critical_extra_budget_pct")
    {
      const auto extra = ParseNumber<double>(value);
      if (!extra || !std::isfinite(*extra) || *extra < 0 || *extra > 50)
      {
        return std::unexpected("critical_extra_budget_pct must be 0..50");
      }
      config.critical_extra_budget_pct_ = *extra;
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
    else if (key == "max_targets")
    {
      const auto count = ParseNumber<std::size_t>(value);
      if (!count || *count < 1 || *count > target_wire::kMaxTargets)
      {
        return std::unexpected("max_targets must be 1..16");
      }
      config.max_targets_ = *count;
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
  if (!array_key.empty())
  {
    return std::unexpected(std::format("{} has no closing ]", array_key));
  }
  if (config.process_names_.empty() && config.process_patterns_.empty())
  {
    return std::unexpected(
        "no target: list at least one process name, such as "
        "process_names = [\"name\"], or a process pattern");
  }
  if (auto valid = ValidateRules(config); !valid)
  {
    return std::unexpected(valid.error());
  }
  if (config.collector_.empty())
  {
    return std::unexpected("collector is required");
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
  double effective_rate_hz_ = 0;
  std::uint64_t sampler_cpu_ns_ = 0;
  std::uint64_t sampler_elapsed_ns_ = 0;
  // Matching processes that discovery could not admit, for announcements.
  std::uint8_t excluded_ = 0;

  [[nodiscard]] Nanoseconds Interval() const noexcept
  {
    return std::chrono::duration_cast<Nanoseconds>(
        std::chrono::duration<double>{1.0 / (effective_rate_hz_ > 0
                                                 ? effective_rate_hz_
                                                 : settings_.rate_hz_)});
  }
  [[nodiscard]] std::uint32_t IntervalMs() const noexcept
  {
    return static_cast<std::uint32_t>(
        std::chrono::round<std::chrono::milliseconds>(Interval()).count());
  }
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
