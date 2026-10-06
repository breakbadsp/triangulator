#pragma once

// Parsers for the process-, cgroup- and namespace-wide files the resource
// probe reads. They take file contents and do no I/O, so tests can feed them
// text. Each returns nullopt (or kUnavailable) for a field it cannot find:
// fields come and go between kernel versions, and a missing one must stay
// unknown rather than become zero.

#include <cmath>
#include <cstdint>
#include <limits>
#include <optional>
#include <string_view>

#include "../common/resource_wire.hpp"
#include "parsing.hpp"

namespace triangulator
{

// Calls p_visit(line) for each line of p_text, without the newline.
template <typename TVisit>
void ForEachLine(std::string_view p_text, TVisit&& p_visit)
{
  while (!p_text.empty())
  {
    const auto end = p_text.find('\n');
    p_visit(p_text.substr(0, end));
    p_text = end == std::string_view::npos ? std::string_view{}
                                           : p_text.substr(end + 1);
  }
}

// One line of a pressure file: "some avg10=1.51 avg60=2.41 avg300=1.57
// total=520879556". avg10 is kept in hundredths of a percent.
struct PressureLine
{
  std::uint64_t avg10_hundredths_{};
  std::uint64_t total_us_{};
};

struct Pressure
{
  std::optional<PressureLine> some_;
  // Absent for CPU before Linux 5.13; host-wide CPU "full" is always zero.
  std::optional<PressureLine> full_;
};

[[nodiscard]] inline std::optional<std::uint64_t> ParseHundredths(
    std::string_view p_text)
{
  const auto value = ParseNumber<double>(p_text);
  if (!value || !std::isfinite(*value) || *value < 0 || *value > 100)
  {
    return std::nullopt;
  }
  return static_cast<std::uint64_t>(std::llround(*value * 100));
}

[[nodiscard]] inline Pressure ParsePressure(std::string_view p_text)
{
  Pressure result;
  ForEachLine(p_text,
              [&](std::string_view p_line)
              {
                auto rest = p_line;
                const auto kind = NextToken(rest);
                std::optional<std::uint64_t> avg10;
                std::optional<std::uint64_t> total;
                for (auto token = NextToken(rest); !token.empty();
                     token = NextToken(rest))
                {
                  if (token.starts_with("avg10="))
                  {
                    avg10 = ParseHundredths(token.substr(6));
                  }
                  else if (token.starts_with("total="))
                  {
                    total = ParseNumber<std::uint64_t>(token.substr(6));
                  }
                }
                if (!avg10 || !total)
                {
                  return;
                }
                if (kind == "some")
                {
                  result.some_ = PressureLine{*avg10, *total};
                }
                else if (kind == "full")
                {
                  result.full_ = PressureLine{*avg10, *total};
                }
              });
  return result;
}

struct DescriptorLimits
{
  std::uint64_t soft_ = resource_wire::kUnavailable;
  std::uint64_t hard_ = resource_wire::kUnavailable;
};

// The "Max open files" row of /proc/PID/limits. "unlimited" stays
// kUnavailable: there is no headroom to report.
[[nodiscard]] inline std::optional<DescriptorLimits> ParseDescriptorLimits(
    std::string_view p_text)
{
  constexpr std::string_view kRow = "Max open files";
  std::optional<DescriptorLimits> result;
  ForEachLine(p_text,
              [&](std::string_view p_line)
              {
                if (!p_line.starts_with(kRow))
                {
                  return;
                }
                auto rest = p_line.substr(kRow.size());
                const auto soft = NextToken(rest);
                const auto hard = NextToken(rest);
                if (soft.empty() || hard.empty())
                {
                  return;
                }
                result =
                    DescriptorLimits{ParseNumber<std::uint64_t>(soft).value_or(
                                         resource_wire::kUnavailable),
                                     ParseNumber<std::uint64_t>(hard).value_or(
                                         resource_wire::kUnavailable)};
              });
  return result;
}

// The value after p_key in "key: value" or "key value" lines (/proc/PID/io,
// /proc/net/snmp6), or nullopt when the key is missing or not a number.
[[nodiscard]] inline std::optional<std::uint64_t> FindKeyValue(
    std::string_view p_text, std::string_view p_key)
{
  std::optional<std::uint64_t> result;
  ForEachLine(p_text,
              [&](std::string_view p_line)
              {
                if (result || !p_line.starts_with(p_key) ||
                    p_line.size() == p_key.size())
                {
                  return;
                }
                auto rest = p_line.substr(p_key.size());
                if (rest.front() == ':')
                {
                  rest.remove_prefix(1);
                }
                else if (rest.front() != ' ' && rest.front() != '\t')
                {
                  return;  // a longer key that starts with p_key
                }
                result = ParseNumber<std::uint64_t>(Trim(rest));
              });
  return result;
}

// A "Key:   1234 kB" line of /proc/PID/status, in bytes.
[[nodiscard]] inline std::optional<std::uint64_t> FindKilobytes(
    std::string_view p_text, std::string_view p_key)
{
  std::optional<std::uint64_t> result;
  ForEachLine(
      p_text,
      [&](std::string_view p_line)
      {
        if (result || !p_line.starts_with(p_key) ||
            p_line.size() == p_key.size() || p_line[p_key.size()] != ':')
        {
          return;
        }
        auto rest = p_line.substr(p_key.size() + 1);
        const auto kilobytes = ParseNumber<std::uint64_t>(NextToken(rest));
        if (kilobytes && NextToken(rest) == "kB" &&
            *kilobytes <= std::numeric_limits<std::uint64_t>::max() / 1024)
        {
          result = *kilobytes * 1024;
        }
      });
  return result;
}

// A cgroup file holding one number or "max". "max" means no limit, which has
// no headroom to report, so it is nullopt like an unreadable file.
[[nodiscard]] inline std::optional<std::uint64_t> ParseCgroupNumber(
    std::string_view p_text)
{
  return ParseNumber<std::uint64_t>(Trim(p_text));
}

struct CpuMax
{
  std::optional<std::uint64_t> quota_us_;  // nullopt: no quota ("max")
  std::uint64_t period_us_{};
};

// cpu.max: "max 100000" or "50000 100000".
[[nodiscard]] inline std::optional<CpuMax> ParseCpuMax(std::string_view p_text)
{
  const auto quota = NextToken(p_text);
  const auto period = ParseNumber<std::uint64_t>(NextToken(p_text));
  if (!period || *period == 0 || quota.empty())
  {
    return std::nullopt;
  }
  return CpuMax{ParseNumber<std::uint64_t>(quota), *period};
}

struct InterfaceCounters
{
  std::uint64_t rx_errors_{};
  std::uint64_t rx_dropped_{};
  std::uint64_t tx_errors_{};
  std::uint64_t tx_dropped_{};
};

// /proc/PID/net/dev, summed over every interface but lo. nullopt when no
// interface line parses. Bridges and veth pairs are counted once each, so a
// packet dropped on a veth and on its bridge counts twice: read the sum as
// "this namespace is dropping", not as an exact packet count.
[[nodiscard]] inline std::optional<InterfaceCounters> ParseNetDev(
    std::string_view p_text)
{
  InterfaceCounters total;
  bool any = false;
  ForEachLine(p_text,
              [&](std::string_view p_line)
              {
                const auto colon = p_line.find(':');
                if (colon == std::string_view::npos)
                {
                  return;
                }
                if (Trim(p_line.substr(0, colon)) == "lo")
                {
                  return;
                }
                auto rest = p_line.substr(colon + 1);
                std::array<std::uint64_t, 16> values{};
                for (auto& value : values)
                {
                  const auto parsed =
                      ParseNumber<std::uint64_t>(NextToken(rest));
                  if (!parsed)
                  {
                    return;
                  }
                  value = *parsed;
                }
                // Receive: bytes packets errs drop ...; transmit starts at 8.
                total.rx_errors_ += values[2];
                total.rx_dropped_ += values[3];
                total.tx_errors_ += values[10];
                total.tx_dropped_ += values[11];
                any = true;
              });
  if (!any)
  {
    return std::nullopt;
  }
  return total;
}

// A counter from /proc/net/snmp or /proc/net/netstat, where each section is
// a line of names followed by a line of values with the same prefix:
//   TcpExt: SyncookiesSent ListenOverflows ...
//   TcpExt: 0 12 ...
[[nodiscard]] inline std::optional<std::uint64_t> FindTableCounter(
    std::string_view p_text, std::string_view p_section,
    std::string_view p_name)
{
  std::optional<std::string_view> names;
  std::optional<std::uint64_t> result;
  ForEachLine(p_text,
              [&](std::string_view p_line)
              {
                if (result || !p_line.starts_with(p_section) ||
                    p_line.size() <= p_section.size() ||
                    p_line[p_section.size()] != ':')
                {
                  return;
                }
                const auto fields = p_line.substr(p_section.size() + 1);
                if (!names)
                {
                  names = fields;
                  return;
                }
                auto name_tokens = *names;
                auto value_tokens = fields;
                for (auto name = NextToken(name_tokens); !name.empty();
                     name = NextToken(name_tokens))
                {
                  const auto value = NextToken(value_tokens);
                  if (name == p_name)
                  {
                    // Tcp MaxConn is -1; no counter we read is signed.
                    result = ParseNumber<std::uint64_t>(value);
                    return;
                  }
                }
                names.reset();
              });
  return result;
}

// A value from /proc/net/sockstat: "TCP: inuse 23 orphan 0 tw 773 ...".
[[nodiscard]] inline std::optional<std::uint64_t> FindSockstat(
    std::string_view p_text, std::string_view p_protocol,
    std::string_view p_name)
{
  std::optional<std::uint64_t> result;
  ForEachLine(p_text,
              [&](std::string_view p_line)
              {
                if (result || !p_line.starts_with(p_protocol) ||
                    p_line.size() <= p_protocol.size() ||
                    p_line[p_protocol.size()] != ':')
                {
                  return;
                }
                auto rest = p_line.substr(p_protocol.size() + 1);
                for (auto name = NextToken(rest); !name.empty();
                     name = NextToken(rest))
                {
                  const auto value = NextToken(rest);
                  if (name == p_name)
                  {
                    result = ParseNumber<std::uint64_t>(value);
                    return;
                  }
                }
              });
  return result;
}

// The cgroup v2 path from /proc/PID/cgroup ("0::/system.slice/x.service").
// nullopt on a cgroup v1-only host.
[[nodiscard]] inline std::optional<std::string_view> ParseCgroupPath(
    std::string_view p_text)
{
  std::optional<std::string_view> result;
  ForEachLine(p_text,
              [&](std::string_view p_line)
              {
                if (!result && p_line.starts_with("0::/"))
                {
                  result = p_line.substr(3);
                }
              });
  return result;
}

// Three numbers separated by blanks, as in net.ipv4.tcp_mem.
[[nodiscard]] inline std::optional<std::array<std::uint64_t, 3>> ParseTriple(
    std::string_view p_text)
{
  std::array<std::uint64_t, 3> result{};
  for (auto& value : result)
  {
    const auto parsed = ParseNumber<std::uint64_t>(NextToken(p_text));
    if (!parsed)
    {
      return std::nullopt;
    }
    value = *parsed;
  }
  return result;
}

}  // namespace triangulator
