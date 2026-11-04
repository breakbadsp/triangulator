#pragma once

#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <limits>
#include <optional>
#include <string_view>
#include <type_traits>

namespace triangulator
{

[[nodiscard]] constexpr std::string_view Trim(std::string_view p_text)
{
  const auto first = p_text.find_first_not_of(" \t\r\n");
  if (first == std::string_view::npos)
  {
    return {};
  }
  return p_text.substr(first, p_text.find_last_not_of(" \t\r\n") - first + 1);
}

[[nodiscard]] constexpr std::string_view NextToken(std::string_view& p_text)
{
  p_text = Trim(p_text);
  const auto end = p_text.find_first_of(" \t\r\n");
  const auto token = p_text.substr(0, end);
  p_text =
      end == std::string_view::npos ? std::string_view{} : p_text.substr(end);
  return token;
}

template <typename Number>
[[nodiscard]] constexpr std::optional<Number> ParseNumber(
    std::string_view p_text)
{
  if (p_text.empty())
  {
    return std::nullopt;
  }
  if constexpr (std::is_same_v<Number, std::uint64_t>)
  {
    // Up to digits10 digits fit in uint64_t without an overflow check.
    if (p_text.size() <= std::numeric_limits<Number>::digits10)
    {
      Number value{};
      for (const char character : p_text)
      {
        const auto digit =
            static_cast<unsigned>(static_cast<unsigned char>(character)) -
            static_cast<unsigned>('0');
        if (digit > 9)
        {
          return std::nullopt;
        }
        value = value * 10 + digit;
      }
      return value;
    }
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

[[nodiscard]] constexpr std::optional<std::uint64_t> ParseHex(
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

[[nodiscard]] constexpr std::optional<ThreadStat> ParseStat(
    std::string_view p_text)
{
  const auto first = p_text.find('(');
  const auto last = p_text.rfind(')');
  if (first == std::string_view::npos || last == std::string_view::npos ||
      last <= first || last + 2 >= p_text.size() || p_text[last + 1] != ' ')
      [[unlikely]]
  {
    return std::nullopt;
  }
  ThreadStat result;
  std::ranges::copy(
      p_text.substr(first + 1, std::min(last - first - 1, std::size_t{15})),
      result.name_.begin());
  auto fields = p_text.substr(last + 2);
  constexpr std::string_view kWhitespace = " \t\r\n";
  // Trimming the entire remainder for every token rescans the same suffix.
  for (int field = 3; field <= 39; ++field)
  {
    const auto first_non_whitespace = fields.find_first_not_of(kWhitespace);
    if (first_non_whitespace == std::string_view::npos) [[unlikely]]
    {
      return std::nullopt;
    }
    fields.remove_prefix(first_non_whitespace);
    const auto end = fields.find_first_of(kWhitespace);
    const auto token = fields.substr(0, end);
    fields =
        end == std::string_view::npos ? std::string_view{} : fields.substr(end);
    if (field == 3)
    {
      if (token.size() != 1) [[unlikely]]
      {
        return std::nullopt;
      }
      result.state_ = token.front();
    }
    if (field == 12 || field == 14 || field == 15 || field == 22)
    {
      const auto value = ParseNumber<std::uint64_t>(token);
      if (!value) [[unlikely]]
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
      if (!value) [[unlikely]]
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

[[nodiscard]] constexpr WaitChannel ParseWchan(std::string_view p_text)
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
[[nodiscard]] constexpr std::optional<IoCounters> ParseIo(
    std::string_view p_text)
{
  std::optional<std::uint64_t> read;
  std::optional<std::uint64_t> written;
  while (!p_text.empty())
  {
    const auto end = p_text.find('\n');
    const auto line = p_text.substr(0, end);
    p_text = end == std::string_view::npos ? std::string_view{}
                                           : p_text.substr(end + 1);
    constexpr std::string_view kReadKey = "rchar:";
    constexpr std::string_view kWriteKey = "wchar:";
    if (line.starts_with(kReadKey))
    {
      read = ParseNumber<std::uint64_t>(Trim(line.substr(kReadKey.size())));
    }
    if (line.starts_with(kWriteKey))
    {
      written = ParseNumber<std::uint64_t>(Trim(line.substr(kWriteKey.size())));
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

[[nodiscard]] constexpr std::optional<SchedulerCounters> ParseSchedstat(
    std::string_view p_text)
{
  auto next = [&p_text]() -> std::string_view
  {
    constexpr std::string_view kWhitespace = " \t\r\n";
    const auto first = p_text.find_first_not_of(kWhitespace);
    if (first == std::string_view::npos)
    {
      p_text = {};
      return {};
    }
    p_text.remove_prefix(first);
    const auto end = p_text.find_first_of(kWhitespace);
    const auto token = p_text.substr(0, end);
    p_text.remove_prefix(token.size());
    return token;
  };
  const auto runtime = ParseNumber<std::uint64_t>(next());
  const auto delay = ParseNumber<std::uint64_t>(next());
  const auto slices = ParseNumber<std::uint64_t>(next());
  if (!runtime || !delay || !slices)
  {
    return std::nullopt;
  }
  return SchedulerCounters{*delay, *slices};
}

[[nodiscard]] constexpr std::optional<SchedulerCounters> ParseStatus(
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

// These helpers read /proc text and do no I/O. The checks below make the
// compiler run them on fixed input.
static_assert(Trim(" \t a b\n") == "a b" && Trim(" \n").empty());
static_assert(
    []
    {
      std::string_view text = " ab cd";
      return NextToken(text) == "ab" && text == " cd";
    }());
static_assert(ParseNumber<int>("-12") == -12 && !ParseNumber<int>("12x") &&
              !ParseNumber<std::uint64_t>("-1"));
static_assert(ParseHex("0x1F") == 0x1F && !ParseHex("0x") && !ParseHex("g"));
static_assert(
    []
    {
      const auto stat = ParseStat(
          "42 (a b) S 41 0 0 0 0 0 0 0 7 0 100 50 0 0 0 0 0 0 12345 0 0 0 0 0 "
          "0 0 0 0 0 0 0 0 0 0 0 3");
      return stat && std::string_view{stat->name_.data()} == "a b" &&
             stat->state_ == 'S' && stat->major_faults_ == 7 &&
             stat->utime_ == 100 && stat->stime_ == 50 &&
             stat->starttime_ == 12345 && stat->processor_ == 3;
    }());
static_assert(!ParseStat("42 (a) S 41"));
static_assert(std::string_view{ParseWchan(" do_wait.isra.0\n").data()} ==
                  "do_wait" &&
              ParseWchan("0")[0] == '\0');
static_assert(ParseIo("rchar: 5\nwchar: 7\n")->read_bytes_ == 5 &&
              ParseIo("rchar: 5\nwchar: 7\n")->write_bytes_ == 7 &&
              !ParseIo("rchar: 5\n"));
static_assert(ParseSchedstat("1 2 3\n")->run_delay_ == 2 &&
              ParseSchedstat("1 2 3\n")->timeslices_ == 3 &&
              !ParseSchedstat("1 2"));
static_assert(ParseStatus("voluntary_ctxt_switches:\t4\n"
                          "nonvoluntary_ctxt_switches:\t5\n")
                      ->run_delay_ == 5 &&
              !ParseStatus("voluntary_ctxt_switches:\t4\n"));

}  // namespace triangulator
