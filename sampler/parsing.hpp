#pragma once

#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <optional>
#include <string_view>

namespace triangulator
{

[[nodiscard]] inline std::string_view Trim(std::string_view p_text)
{
  const auto first = p_text.find_first_not_of(" \t\r\n");
  if (first == std::string_view::npos)
  {
    return {};
  }
  return p_text.substr(first, p_text.find_last_not_of(" \t\r\n") - first + 1);
}

[[nodiscard]] inline std::string_view NextToken(std::string_view& p_text)
{
  p_text = Trim(p_text);
  const auto end = p_text.find_first_of(" \t\r\n");
  const auto token = p_text.substr(0, end);
  p_text =
      end == std::string_view::npos ? std::string_view{} : p_text.substr(end);
  return token;
}

template <typename Number>
[[nodiscard]] std::optional<Number> ParseNumber(std::string_view p_text)
{
  if (p_text.empty())
  {
    return std::nullopt;
  }
  Number value{};
  const auto [end, error] =
      std::from_chars(p_text.data(), p_text.data() + p_text.size(), value);
  if (error != std::errc{} || end != p_text.data() + p_text.size())
  {
    return std::nullopt;
  }
  return value;
}

[[nodiscard]] inline std::optional<std::uint64_t> ParseHex(
    std::string_view p_text)
{
  if (p_text.starts_with("0x") || p_text.starts_with("0X"))
  {
    p_text.remove_prefix(2);
  }
  if (p_text.empty())
  {
    return std::nullopt;
  }
  std::uint64_t value{};
  const auto [end, error] =
      std::from_chars(p_text.data(), p_text.data() + p_text.size(), value, 16);
  if (error != std::errc{} || end != p_text.data() + p_text.size())
  {
    return std::nullopt;
  }
  return value;
}

struct ThreadStat
{
  std::array<char, 16> name_{};
  char state_{};
  std::uint64_t major_faults_{};
  std::uint64_t utime_{};
  std::uint64_t stime_{};
  std::uint64_t starttime_{};
  std::uint16_t processor_{};
};

[[nodiscard]] inline std::optional<ThreadStat> ParseStat(
    std::string_view p_text)
{
  const auto first = p_text.find('(');
  const auto last = p_text.rfind(')');
  if (first == std::string_view::npos || last == std::string_view::npos ||
      last <= first || last + 2 >= p_text.size() || p_text[last + 1] != ' ')
  {
    return std::nullopt;
  }
  ThreadStat result;
  std::ranges::copy(
      p_text.substr(first + 1, std::min(last - first - 1, std::size_t{15})),
      result.name_.begin());
  auto fields = p_text.substr(last + 2);
  for (int field = 3; field <= 39; ++field)
  {
    const auto token = NextToken(fields);
    if (token.empty())
    {
      return std::nullopt;
    }
    if (field == 3)
    {
      if (token.size() != 1)
      {
        return std::nullopt;
      }
      result.state_ = token.front();
    }
    if (field == 12 || field == 14 || field == 15 || field == 22)
    {
      const auto value = ParseNumber<std::uint64_t>(token);
      if (!value)
      {
        return std::nullopt;
      }
      if (field == 12)
      {
        result.major_faults_ = *value;
      }
      if (field == 14)
      {
        result.utime_ = *value;
      }
      if (field == 15)
      {
        result.stime_ = *value;
      }
      if (field == 22)
      {
        result.starttime_ = *value;
      }
    }
    if (field == 39)
    {
      const auto value = ParseNumber<std::uint16_t>(token);
      if (!value)
      {
        return std::nullopt;
      }
      result.processor_ = *value;
    }
  }
  return result;
}

// Kernel function a sleeping thread waits in. "0" means running, or no access.
// Compiler suffixes such as ".constprop.0" or ".isra.0" are dropped.
using WaitChannel = std::array<char, 32>;

[[nodiscard]] inline WaitChannel ParseWchan(std::string_view p_text)
{
  WaitChannel result{};
  p_text = Trim(p_text);
  p_text = p_text.substr(0, p_text.find('.'));
  if (p_text == "0")
  {
    return result;
  }
  std::ranges::copy(p_text.substr(0, result.size()), result.begin());
  return result;
}

struct IoCounters
{
  std::uint64_t read_bytes_{};
  std::uint64_t write_bytes_{};
};

// rchar and wchar from /proc/<pid>/task/<tid>/io: bytes moved by read- and
// write-family syscalls, including sockets and pipes.
[[nodiscard]] inline std::optional<IoCounters> ParseIo(std::string_view p_text)
{
  std::optional<std::uint64_t> read;
  std::optional<std::uint64_t> written;
  while (!p_text.empty())
  {
    const auto end = p_text.find('\n');
    const auto line = p_text.substr(0, end);
    p_text = end == std::string_view::npos ? std::string_view{}
                                           : p_text.substr(end + 1);
    const auto separator = line.find(':');
    if (separator == std::string_view::npos)
    {
      continue;
    }
    const auto key = line.substr(0, separator);
    if (key == "rchar")
    {
      read = ParseNumber<std::uint64_t>(Trim(line.substr(separator + 1)));
    }
    if (key == "wchar")
    {
      written = ParseNumber<std::uint64_t>(Trim(line.substr(separator + 1)));
    }
  }
  if (!read || !written)
  {
    return std::nullopt;
  }
  return IoCounters{*read, *written};
}

struct SchedulerCounters
{
  std::uint64_t run_delay_{};
  std::uint64_t timeslices_{};
};

[[nodiscard]] inline std::optional<SchedulerCounters> ParseSchedstat(
    std::string_view p_text)
{
  const auto runtime = ParseNumber<std::uint64_t>(NextToken(p_text));
  const auto delay = ParseNumber<std::uint64_t>(NextToken(p_text));
  const auto slices = ParseNumber<std::uint64_t>(NextToken(p_text));
  if (!runtime || !delay || !slices)
  {
    return std::nullopt;
  }
  return SchedulerCounters{*delay, *slices};
}

[[nodiscard]] inline std::optional<SchedulerCounters> ParseStatus(
    std::string_view p_text)
{
  std::optional<std::uint64_t> voluntary;
  std::optional<std::uint64_t> nonvoluntary;
  while (!p_text.empty())
  {
    const auto end = p_text.find('\n');
    const auto line = p_text.substr(0, end);
    p_text = end == std::string_view::npos ? std::string_view{}
                                           : p_text.substr(end + 1);
    const auto separator = line.find(':');
    if (separator == std::string_view::npos)
    {
      continue;
    }
    const auto key = line.substr(0, separator);
    if (key == "voluntary_ctxt_switches")
    {
      voluntary = ParseNumber<std::uint64_t>(Trim(line.substr(separator + 1)));
    }
    if (key == "nonvoluntary_ctxt_switches")
    {
      nonvoluntary =
          ParseNumber<std::uint64_t>(Trim(line.substr(separator + 1)));
    }
  }
  if (!voluntary || !nonvoluntary)
  {
    return std::nullopt;
  }
  return SchedulerCounters{*nonvoluntary, *voluntary};
}

}  // namespace triangulator
