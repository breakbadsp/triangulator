#pragma once

// Parsers for the files the memory-map thread reads: /proc/PID/maps,
// /proc/PID/stat (process-wide fault counters), /proc/PID/limits and the
// 64-bit entries of /proc/PID/pagemap. Like resource_parsing.hpp they take
// file contents and do no I/O, so tests can feed them text. See
// docs/process-memory-map-design.md.

#include <cstdint>
#include <limits>
#include <optional>
#include <string_view>

#include "parsing.hpp"
#include "resource_parsing.hpp"

namespace triangulator
{

// Permission bits of a mapping, as in the second column of maps.
enum class Permissions : std::uint8_t
{
  None = 0,
  Read = 1,
  Write = 2,
  Execute = 4,
  Shared = 8  // 's'; 'p' (private, copy-on-write) is the absence of this bit
};

[[nodiscard]] constexpr std::uint8_t operator|(std::uint8_t p_bits,
                                               Permissions p_bit) noexcept
{
  return static_cast<std::uint8_t>(p_bits | std::to_underlying(p_bit));
}

// One line of /proc/PID/maps:
// "55d0c1a00000-55d0c6e00000 rw-p 00000000 00:00 0      [heap]".
// The name views the line and is empty for an anonymous mapping. A name can
// contain spaces; the kernel adds " (deleted)" when the file was removed.
struct MapsLine
{
  std::uint64_t start_{};
  std::uint64_t end_{};
  std::uint8_t permissions_{};
  std::uint64_t offset_{};
  std::uint32_t device_major_{};
  std::uint32_t device_minor_{};
  std::uint64_t inode_{};
  std::string_view name_;
  bool deleted_ = false;
};

[[nodiscard]] inline std::optional<std::uint8_t> ParsePermissions(
    std::string_view p_text)
{
  if (p_text.size() != 4)
  {
    return std::nullopt;
  }
  std::uint8_t bits = 0;
  constexpr std::string_view kSet = "rwx";
  for (std::size_t index = 0; index < kSet.size(); ++index)
  {
    if (p_text[index] == kSet[index])
    {
      bits = static_cast<std::uint8_t>(bits | (1U << index));
    }
    else if (p_text[index] != '-')
    {
      return std::nullopt;
    }
  }
  if (p_text[3] == 's')
  {
    bits = bits | Permissions::Shared;
  }
  else if (p_text[3] != 'p')
  {
    return std::nullopt;
  }
  return bits;
}

[[nodiscard]] inline std::optional<MapsLine> ParseMapsLine(
    std::string_view p_line)
{
  auto rest = p_line;
  const auto range = NextToken(rest);
  const auto dash = range.find('-');
  if (dash == std::string_view::npos)
  {
    return std::nullopt;
  }
  MapsLine result;
  const auto start = ParseHex(range.substr(0, dash));
  const auto end = ParseHex(range.substr(dash + 1));
  const auto permissions = ParsePermissions(NextToken(rest));
  const auto offset = ParseHex(NextToken(rest));
  const auto device = NextToken(rest);
  const auto colon = device.find(':');
  const auto inode_text = NextToken(rest);
  const auto inode = ParseNumber<std::uint64_t>(inode_text);
  if (!start || !end || *end <= *start || !permissions || !offset ||
      colon == std::string_view::npos || !inode)
  {
    return std::nullopt;
  }
  const auto major = ParseHex(device.substr(0, colon));
  const auto minor = ParseHex(device.substr(colon + 1));
  if (!major || !minor || *major > std::numeric_limits<std::uint32_t>::max() ||
      *minor > std::numeric_limits<std::uint32_t>::max())
  {
    return std::nullopt;
  }
  result.start_ = *start;
  result.end_ = *end;
  result.permissions_ = *permissions;
  result.offset_ = *offset;
  result.device_major_ = static_cast<std::uint32_t>(*major);
  result.device_minor_ = static_cast<std::uint32_t>(*minor);
  result.inode_ = *inode;
  // The name starts after the padding that follows the inode. Trim only the
  // front: a file name may end in spaces.
  const auto first = rest.find_first_not_of(' ');
  auto name =
      first == std::string_view::npos ? std::string_view{} : rest.substr(first);
  if (name.ends_with('\n'))
  {
    name.remove_suffix(1);
  }
  constexpr std::string_view kDeleted = " (deleted)";
  if (name.ends_with(kDeleted))
  {
    name.remove_suffix(kDeleted.size());
    result.deleted_ = true;
  }
  result.name_ = name;
  return result;
}

// Process-wide counters from /proc/PID/stat. The kernel adds the counts of
// threads that exited to the process's own, so these never fall while the
// process lives.
struct ProcessStat
{
  std::uint64_t minor_faults_{};
  std::uint64_t major_faults_{};
  // The address where the main stack began (field 28). Zero when the
  // kernel hides it; it shows it to the same user.
  std::uint64_t start_stack_{};
};

[[nodiscard]] inline std::optional<ProcessStat> ParseProcessStat(
    std::string_view p_text)
{
  const auto last = p_text.rfind(')');
  if (last == std::string_view::npos || last + 2 >= p_text.size())
  {
    return std::nullopt;
  }
  auto fields = p_text.substr(last + 2);
  ProcessStat result;
  // Field 3 (the state) is the first after the name.
  for (int field = 3; field <= 28; ++field)
  {
    const auto token = NextToken(fields);
    if (token.empty())
    {
      return std::nullopt;
    }
    if (field != 10 && field != 12 && field != 28)
    {
      continue;
    }
    const auto value = ParseNumber<std::uint64_t>(token);
    if (!value)
    {
      return std::nullopt;
    }
    if (field == 10)
    {
      result.minor_faults_ = *value;
    }
    else if (field == 12)
    {
      result.major_faults_ = *value;
    }
    else
    {
      result.start_stack_ = *value;
    }
  }
  return result;
}

// The soft limit in one row of /proc/PID/limits, such as "Max stack size".
// "unlimited", or a row that is missing, is nullopt: there is no headroom to
// report.
[[nodiscard]] inline std::optional<std::uint64_t> ParseSoftLimit(
    std::string_view p_text, std::string_view p_row)
{
  std::optional<std::uint64_t> result;
  ForEachLine(p_text,
              [&](std::string_view p_line)
              {
                // The row names have different lengths and the columns are
                // padded, so the name must be followed by two spaces.
                if (result || !p_line.starts_with(p_row) ||
                    !p_line.substr(p_row.size()).starts_with("  "))
                {
                  return;
                }
                auto rest = p_line.substr(p_row.size());
                result = ParseNumber<std::uint64_t>(NextToken(rest));
              });
  return result;
}

// The bits of one /proc/PID/pagemap entry that an unprivileged reader gets.
// The kernel zeroes the frame number without CAP_SYS_ADMIN; it is not used.
// See Documentation/admin-guide/mm/pagemap.rst.
struct PageBits
{
  bool present_ = false;
  bool swapped_ = false;
  // Mapped by this process only. Since Linux 4.2; zero before.
  bool exclusive_ = false;
  // A page of a file, or shared anonymous memory.
  bool file_or_shared_ = false;
};

[[nodiscard]] constexpr PageBits DecodePagemapEntry(
    std::uint64_t p_entry) noexcept
{
  constexpr std::uint64_t kOne = 1;
  return PageBits{
      .present_ = (p_entry & (kOne << 63)) != 0,
      .swapped_ = (p_entry & (kOne << 62)) != 0,
      .exclusive_ = (p_entry & (kOne << 56)) != 0,
      .file_or_shared_ = (p_entry & (kOne << 61)) != 0,
  };
}

}  // namespace triangulator
