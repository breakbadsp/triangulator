#pragma once

// The memory-map datagram format ("TVMA"), shared by the sampler and the
// collector. It describes the target's virtual address space: a summary from
// /proc/PID/status, stat and limits, and the layout from /proc/PID/maps. The
// sampler sends it at a slower rate than thread ticks ("TMON", wire.hpp) and
// resource samples ("TRES", resource_wire.hpp). Each format has its own
// magic, which tells the collector what the payload is, so the other formats
// do not change. This header depends only on the standard library.
//
// One sample is up to kMaxParts datagrams that share a header: part 0 holds
// the summary and parts 1.. hold up to kRegionsPerPart layout regions each.
// A sample has region parts only when the layout changed, or for a periodic
// refresh; otherwise the collector keeps the layout it has.

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <limits>
#include <span>
#include <string_view>
#include <utility>

#include "wire.hpp"

namespace triangulator::memory_wire
{

inline constexpr std::uint8_t kVersion = 1;
inline constexpr std::size_t kHeaderSize = 64;
inline constexpr std::size_t kRegionSize = 64;
inline constexpr std::size_t kRegionsPerPart = 20;
inline constexpr std::size_t kMaxRegions = 1000;
inline constexpr std::size_t kMaxParts = 1 + kMaxRegions / kRegionsPerPart;
static_assert(kMaxRegions % kRegionsPerPart == 0);
inline constexpr std::size_t kNameSize = 40;
// A value the sampler could not read, or a limit that is unlimited.
inline constexpr std::uint64_t kUnavailable =
    std::numeric_limits<std::uint64_t>::max();

// Summary values, in wire order. Each is a u64; kUnavailable when unknown.
// Resident memory is not here: the resource sample already has it.
inline constexpr std::array<std::string_view, 16> kSummaryFields{
    // /proc/PID/status, in bytes.
    "vm_size_bytes", "vm_peak_bytes", "vm_data_bytes", "vm_stack_bytes",
    "vm_exe_bytes", "vm_lib_bytes", "vm_pte_bytes", "vm_locked_bytes",
    // /proc/PID/stat: page faults since the process started.
    "minor_faults", "major_faults",
    // /proc/PID/limits (soft limits) and /proc/sys/vm/max_map_count.
    "address_space_limit_bytes", "stack_limit_bytes", "max_map_count",
    // /proc/PID/maps: mappings (VMAs) counted, and what reading them cost.
    // The read time shows how long the target's memory-map lock was shared
    // with the sampler.
    "vma_count", "maps_read_us", "maps_reads"};
using SummaryValues = std::array<std::uint64_t, kSummaryFields.size()>;

// The index of the summary field p_name. Only for names in kSummaryFields;
// an unknown name fails to compile in a constant expression.
[[nodiscard]] consteval std::size_t Field(std::string_view p_name)
{
  for (std::size_t index = 0; index < kSummaryFields.size(); ++index)
  {
    if (kSummaryFields[index] == p_name)
    {
      return index;
    }
  }
  throw "unknown memory summary field";
}

[[nodiscard]] inline SummaryValues EmptySummary() noexcept
{
  SummaryValues summary;
  summary.fill(kUnavailable);
  return summary;
}

enum class PartKind : std::uint8_t
{
  Summary = 1,
  Regions = 2
};

// Why the layout is missing or partial.
enum class Flags : std::uint16_t
{
  None = 0,
  // /proc/PID/maps could not be read (another user, or a process that is
  // not dumpable).
  MapsHidden = 1,
  // Reading /proc/PID/maps failed part way, for example because the target
  // exited.
  MapsPartial = 2,
  // The layout has more than kMaxRegions regions; only the first are sent.
  RegionsTruncated = 4
};
inline constexpr std::uint16_t kKnownFlags = 7;

[[nodiscard]] constexpr Flags operator|(Flags p_left, Flags p_right) noexcept
{
  return static_cast<Flags>(std::to_underlying(p_left) |
                            std::to_underlying(p_right));
}
[[nodiscard]] constexpr bool HasFlag(Flags p_flags, Flags p_flag) noexcept
{
  return (std::to_underlying(p_flags) & std::to_underlying(p_flag)) != 0;
}

// What a region holds, from the path column of /proc/PID/maps.
enum class RegionKind : std::uint8_t
{
  Anonymous = 1,  // no path, or a name such as [anon:...] or anon_inode:...
  File = 2,       // a mapped file: the program, libraries, shared memory
  Heap = 3,       // [heap], the brk heap
  Stack = 4,      // [stack], the main thread's stack
  Kernel = 5      // [vdso], [vvar], [vsyscall] and similar
};
inline constexpr std::uint8_t kMaxRegionKind = 5;

// Permission bits of a region: the union of its mappings' permissions.
enum class Permission : std::uint8_t
{
  None = 0,
  Read = 1,
  Write = 2,
  Execute = 4,
  Shared = 8
};
inline constexpr std::uint8_t kKnownPermissions = 15;

// Adjacent mappings with the same kind and name, joined. A library's code,
// data and read-only parts are one region, so the layout stays small.
struct Region
{
  std::uint64_t start_{};
  std::uint64_t end_{};
  std::uint32_t vma_count_{};
  RegionKind kind_{};
  std::uint8_t permissions_{};
  std::array<std::uint8_t, 2> reserved_{};  // zero
  // The end of the path or name, NUL-padded: a long path keeps its file
  // name.
  std::array<char, kNameSize> name_{};

  bool operator==(const Region&) const = default;
};
static_assert(wire::WireStruct<Region> && sizeof(Region) == kRegionSize);
static_assert(offsetof(Region, vma_count_) == 16 &&
              offsetof(Region, name_) == 24);

inline constexpr std::array<char, 4> kMagic{'T', 'V', 'M', 'A'};

struct Header
{
  std::array<char, 4> magic_ = kMagic;
  std::uint8_t version_ = kVersion;
  PartKind kind_{};
  std::uint8_t part_{};
  std::uint8_t parts_{};
  // The thread ticks' session, so the streams can be matched.
  std::uint64_t session_{};
  std::uint32_t sequence_{};
  std::uint16_t count_{};  // summary values or regions in this part
  std::array<std::uint8_t, 2> reserved_{};  // zero
  std::uint64_t monotonic_ns_{};
  std::uint64_t wall_ns_{};
  std::uint32_t interval_ms_{};
  std::uint32_t pid_{};
  std::uint64_t process_start_{};  // /proc/PID/stat starttime, clock ticks
  Flags flags_{};
  std::array<std::uint8_t, 6> reserved_end_{};  // zero

  // Every part of one sample carries the same header apart from these.
  [[nodiscard]] bool SameSample(const Header& p_other) const noexcept
  {
    return parts_ == p_other.parts_ && session_ == p_other.session_ &&
           sequence_ == p_other.sequence_ &&
           monotonic_ns_ == p_other.monotonic_ns_ &&
           wall_ns_ == p_other.wall_ns_ &&
           interval_ms_ == p_other.interval_ms_ && pid_ == p_other.pid_ &&
           process_start_ == p_other.process_start_ && flags_ == p_other.flags_;
  }
};
static_assert(wire::WireStruct<Header> && sizeof(Header) == kHeaderSize);
static_assert(offsetof(Header, session_) == 8 &&
              offsetof(Header, count_) == 20 &&
              offsetof(Header, monotonic_ns_) == 24 &&
              offsetof(Header, flags_) == 56);

// Part 0 of a sample.
struct SummaryPart
{
  Header header_;
  SummaryValues values_{};
};
static_assert(wire::WireStruct<SummaryPart>);
inline constexpr std::size_t kSummaryPartSize = sizeof(SummaryPart);

// Parts 1..: the header, then header_.count_ regions.
struct RegionsPart
{
  Header header_;
  std::array<Region, kRegionsPerPart> regions_{};
};
static_assert(wire::WireStruct<RegionsPart>);
inline constexpr std::size_t kMaxPartSize = sizeof(RegionsPart);
// Fits an unfragmented UDP datagram on a 1,500-byte Ethernet MTU, and is
// below the size of the collector's receive buffer.
static_assert(kMaxPartSize <= 1400 && kSummaryPartSize <= kMaxPartSize);

// Number of datagrams for a sample: the summary, plus the region parts when
// p_regions layout regions are sent.
[[nodiscard]] constexpr std::uint8_t PartCount(std::size_t p_regions) noexcept
{
  return static_cast<std::uint8_t>(
      1 + (std::min(p_regions, kMaxRegions) + kRegionsPerPart - 1) /
              kRegionsPerPart);
}

// Writes the summary part into p_buffer and returns its length.
[[nodiscard]] inline std::size_t EncodeSummary(
    std::span<std::byte, kMaxPartSize> p_buffer, Header p_header,
    const SummaryValues& p_summary)
{
  p_header.kind_ = PartKind::Summary;
  p_header.part_ = 0;
  p_header.count_ = static_cast<std::uint16_t>(p_summary.size());
  const SummaryPart part{.header_ = p_header, .values_ = p_summary};
  std::ranges::copy(wire::AsBytes(part), p_buffer.begin());
  return sizeof(part);
}

// Writes region part p_part (1-based) of p_regions into p_buffer and
// returns its length.
[[nodiscard]] inline std::size_t EncodeRegions(
    std::span<std::byte, kMaxPartSize> p_buffer, Header p_header,
    std::span<const Region> p_regions, std::uint8_t p_part)
{
  const auto first = (p_part - std::size_t{1}) * kRegionsPerPart;
  const auto rows = std::min(kRegionsPerPart, p_regions.size() - first);
  p_header.kind_ = PartKind::Regions;
  p_header.part_ = p_part;
  p_header.count_ = static_cast<std::uint16_t>(rows);
  RegionsPart part{.header_ = p_header};
  std::ranges::copy(p_regions.subspan(first, rows), part.regions_.begin());
  const auto length = kHeaderSize + rows * kRegionSize;
  std::ranges::copy(wire::AsBytes(part).first(length), p_buffer.begin());
  return length;
}

// One decoded datagram. values_ is set for the summary part, regions_ for
// the others.
struct Part
{
  Header header_;
  SummaryValues values_{};
  // The regions of this part: regions_[0 .. region_count_).
  std::array<Region, kRegionsPerPart> regions_{};
  std::size_t region_count_ = 0;

  [[nodiscard]] std::span<const Region> Regions() const noexcept
  {
    return std::span{regions_}.first(region_count_);
  }
};

[[nodiscard]] inline bool ValidRegion(const Region& p_region) noexcept
{
  const auto kind = std::to_underlying(p_region.kind_);
  return kind != 0 && kind <= kMaxRegionKind &&
         (p_region.permissions_ & ~kKnownPermissions) == 0 &&
         p_region.reserved_ == decltype(p_region.reserved_){} &&
         p_region.start_ < p_region.end_ && p_region.vma_count_ != 0 &&
         p_region.name_.back() == '\0';
}

// Checks the format (length, magic, version, part numbering, reserved
// bytes) and that the identities and clocks are set. Whether the values
// make sense is up to the reader.
[[nodiscard]] inline std::expected<Part, std::string_view> Decode(
    std::span<const std::byte> p_data)
{
  if (p_data.size() < kHeaderSize ||
      std::memcmp(p_data.data(), kMagic.data(), kMagic.size()) != 0)
  {
    return std::unexpected("not a memory-map datagram");
  }
  Part part;
  auto& header = part.header_;
  header = wire::FromBytes<Header>(p_data);
  if (header.version_ != kVersion)
  {
    return std::unexpected("unsupported memory-map protocol");
  }
  if ((std::to_underlying(header.flags_) & ~kKnownFlags) != 0 ||
      header.reserved_ != decltype(header.reserved_){} ||
      header.reserved_end_ != decltype(header.reserved_end_){} ||
      header.parts_ == 0 || header.parts_ > kMaxParts ||
      header.part_ >= header.parts_)
  {
    return std::unexpected("invalid memory-map header");
  }
  if (header.pid_ == 0 || header.monotonic_ns_ == 0 || header.wall_ns_ == 0 ||
      header.interval_ms_ < 1000 || header.interval_ms_ > 3'600'000)
  {
    return std::unexpected("invalid memory-map sample identity or clock");
  }
  if (header.kind_ == PartKind::Summary)
  {
    if (header.part_ != 0 || header.count_ != kSummaryFields.size() ||
        p_data.size() != kSummaryPartSize)
    {
      return std::unexpected("invalid memory-map summary");
    }
    part.values_ = wire::FromBytes<SummaryPart>(p_data).values_;
    return part;
  }
  if (header.kind_ != PartKind::Regions || header.part_ == 0 ||
      header.count_ == 0 || header.count_ > kRegionsPerPart ||
      p_data.size() != kHeaderSize + header.count_ * kRegionSize)
  {
    return std::unexpected("invalid memory-map region part");
  }
  for (std::size_t row = 0; row < header.count_; ++row)
  {
    const auto region = wire::FromBytes<Region>(
        p_data.subspan(kHeaderSize + row * kRegionSize));
    if (!ValidRegion(region))
    {
      return std::unexpected("invalid memory-map region");
    }
    part.regions_[part.region_count_++] = region;
  }
  return part;
}

}  // namespace triangulator::memory_wire
