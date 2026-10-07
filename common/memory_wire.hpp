#pragma once

// The memory-map formats, shared by the sampler and the collector:
//
// - "TVMA" datagrams go from the sampler's memory-map thread to the
//   collector. One cycle is up to kMaxParts datagrams that share a header:
//   part 0 is the summary, the next header_.layout_parts_ parts hold the VMA
//   list (only when the layout changed or a keyframe is due), and the last
//   parts hold the detail of the selected VMA (only while one is selected).
// - "TVMQ" requests go from the collector to the sampler's control socket.
//   They are signed with HMAC-SHA256 and a shared token.
//
// See docs/process-memory-map-design.md, sections 6 and 7. Like
// resource_wire.hpp, the structs below are the bytes on the wire (see
// wire.hpp). This header depends only on the standard library.

#include <algorithm>
#include <array>
#include <cassert>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <limits>
#include <span>
#include <string_view>
#include <utility>

#include "sha256.hpp"
#include "wire.hpp"

namespace triangulator::memory_wire
{

inline constexpr std::uint8_t kVersion = 1;
inline constexpr std::size_t kHeaderSize = 64;
inline constexpr std::size_t kVmaSize = 96;
inline constexpr std::size_t kNameSize = 48;
inline constexpr std::size_t kVmasPerPart = 13;
// The largest memory_map_max_vmas. The collector sizes its buffers for it.
inline constexpr std::size_t kMaxVmas = 65536;
inline constexpr std::size_t kMaxLayoutParts =
    (kMaxVmas + kVmasPerPart - 1) / kVmasPerPart;
inline constexpr std::size_t kDetailSize = 80;
inline constexpr std::size_t kCellsPerPart = 256;
inline constexpr std::size_t kMaxCells = 512;
inline constexpr std::size_t kMaxDetailParts = kMaxCells / kCellsPerPart;
inline constexpr std::size_t kMaxParts = 1 + kMaxLayoutParts + kMaxDetailParts;
static_assert(kMaxParts <= std::numeric_limits<std::uint16_t>::max());
// A cell value: the fraction of the cell's pages in a state, in 1/254
// steps. kNotMeasured in all three bytes means the cell was not read yet.
inline constexpr std::uint8_t kCellScale = 254;
inline constexpr std::uint8_t kNotMeasured = 255;
inline constexpr std::uint64_t kUnavailable =
    std::numeric_limits<std::uint64_t>::max();

// Summary values, in wire order. Each is a u64; kUnavailable when unknown.
// Sizes are bytes; /proc/PID/status values are converted from kB.
inline constexpr std::array<std::string_view, 46> kSummaryFields{
    // /proc/PID/status.
    "vm_size_bytes", "vm_peak_bytes", "vm_rss_bytes", "vm_hwm_bytes",
    "rss_anon_bytes", "rss_file_bytes", "rss_shmem_bytes", "vm_swap_bytes",
    "vm_data_bytes", "vm_stack_bytes", "vm_exe_bytes", "vm_lib_bytes",
    "vm_pte_bytes", "vm_locked_bytes",
    // /proc/PID/stat: process-wide counters; the main stack's start.
    "minor_faults", "major_faults", "start_stack",
    // /proc/PID/limits (soft limits), vm.max_map_count and the host.
    "rlimit_as_bytes", "rlimit_stack_bytes", "rlimit_memlock_bytes",
    "max_map_count", "cpu_count", "page_size_bytes",
    // From /proc/PID/maps. vma_count counts every VMA, vmas_sent the ones
    // in the list (the largest, when the list is truncated).
    "vma_count", "vmas_sent", "mapped_bytes", "anonymous_bytes", "file_bytes",
    "writable_bytes", "executable_bytes", "heap_start", "heap_end",
    "stack_start", "stack_end", "vmas_new", "vmas_removed", "vmas_resized",
    // The cost of this cycle, measured by the thread itself.
    "read_ns_total", "read_ns_max", "reads", "slow_reads", "backoff_us",
    "cpu_ns", "cycle_ns",
    // The request that the thread works on.
    "lease_remaining_ms", "detail_start"};

using SummaryValues = std::array<std::uint64_t, kSummaryFields.size()>;

// Index of a summary field. consteval, so a misspelt name fails to compile.
consteval std::size_t Field(std::string_view p_name)
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
  Vmas = 2,
  Detail = 3
};

enum class Flags : std::uint16_t
{
  None = 0,
  // The process has more VMAs than memory_map_max_vmas; the list holds the
  // largest ones.
  Truncated = 1,
  // No target process now. The summary has no values.
  TargetAbsent = 2,
  // /proc/PID/maps could not be read (another user, a process that is not
  // dumpable, or one that exited during the read).
  MapsUnreadable = 4,
  // /proc/PID/status could not be read.
  StatusUnreadable = 8
};
inline constexpr std::uint16_t kKnownFlags = 15;

[[nodiscard]] constexpr Flags operator|(Flags p_left, Flags p_right) noexcept
{
  return static_cast<Flags>(std::to_underlying(p_left) |
                            std::to_underlying(p_right));
}
[[nodiscard]] constexpr bool HasFlag(Flags p_flags, Flags p_flag) noexcept
{
  return (std::to_underlying(p_flags) & std::to_underlying(p_flag)) != 0;
}

// What a VMA holds, from its name. The dashboard groups and colors by it.
enum class VmaKind : std::uint8_t
{
  Anonymous = 1,  // no name
  File = 2,
  Heap = 3,            // [heap]: the brk heap
  Stack = 4,           // [stack]: the main thread's stack
  Kernel = 5,          // [vdso], [vvar], [vsyscall] and similar
  NamedAnonymous = 6,  // [anon:NAME], named with prctl(PR_SET_VMA)
  Other = 7            // another [...] name, such as [uprobes]
};
inline constexpr std::uint8_t kMaxVmaKind = 7;

// How a VMA changed since the previous cycle.
enum class Changes : std::uint8_t
{
  None = 0,
  New = 1,
  StartMoved = 2,  // the main stack grows down
  EndMoved = 4     // the heap grows up
};
inline constexpr std::uint8_t kKnownChanges = 7;

enum class VmaFlags : std::uint8_t
{
  None = 0,
  Deleted = 1,       // the file was removed: " (deleted)"
  NameTruncated = 2  // name_ holds the end of a longer name
};
inline constexpr std::uint8_t kKnownVmaFlags = 3;

// One VMA. permissions_ uses the sampler's Permissions bits (read 1, write
// 2, execute 4, shared 8). name_ is NUL-padded; a name of exactly
// kNameSize bytes has no NUL.
struct Vma
{
  std::uint64_t start_{};
  std::uint64_t end_{};
  std::uint64_t offset_{};
  std::uint64_t inode_{};
  std::uint32_t device_major_{};
  std::uint32_t device_minor_{};
  std::uint8_t permissions_{};
  VmaKind kind_{};
  std::uint8_t changes_{};
  std::uint8_t flags_{};
  std::array<std::uint8_t, 4> reserved_{};  // zero
  std::array<char, kNameSize> name_{};

  [[nodiscard]] std::uint64_t Size() const noexcept
  {
    return end_ - start_;
  }
  [[nodiscard]] std::string_view Name() const noexcept
  {
    const auto length = std::ranges::find(name_, '\0') - name_.begin();
    return {name_.data(), static_cast<std::size_t>(length)};
  }
  // Keeps the end of p_name: for a long path the file name matters most.
  void SetName(std::string_view p_name) noexcept
  {
    name_ = {};
    if (p_name.size() > kNameSize)
    {
      p_name = p_name.substr(p_name.size() - kNameSize);
      flags_ = static_cast<std::uint8_t>(
          flags_ | std::to_underlying(VmaFlags::NameTruncated));
    }
    std::ranges::copy(p_name, name_.begin());
  }

  bool operator==(const Vma&) const = default;
};
static_assert(wire::WireStruct<Vma> && sizeof(Vma) == kVmaSize);
static_assert(offsetof(Vma, device_major_) == 32 &&
              offsetof(Vma, permissions_) == 40 && offsetof(Vma, name_) == 48);

enum class DetailStatus : std::uint8_t
{
  Measuring = 1,  // the first pass over the VMA has not finished
  Complete = 2,   // every cell holds a value from the last full pass
  NotFound = 3,   // no VMA starts at the selected address now
  Unreadable = 4  // /proc/PID/pagemap could not be read
};
inline constexpr std::uint8_t kMaxDetailStatus = 4;

// The selected VMA, from /proc/PID/pagemap. Page counts cover the cells
// that hold a value.
struct Detail
{
  std::uint64_t vma_start_{};
  std::uint64_t vma_end_{};
  std::uint64_t pages_per_cell_{};
  std::uint64_t measured_pages_{};
  std::uint64_t resident_pages_{};
  std::uint64_t swapped_pages_{};
  std::uint64_t shared_pages_{};  // resident and not exclusive
  std::uint64_t scan_ns_{};       // time spent reading pagemap this cycle
  std::uint32_t cell_count_{};
  std::uint32_t first_cell_{};  // of this part's cells
  DetailStatus status_{};
  std::array<std::uint8_t, 7> reserved_{};  // zero

  bool operator==(const Detail&) const = default;
};
static_assert(wire::WireStruct<Detail> && sizeof(Detail) == kDetailSize);

struct Cell
{
  std::uint8_t resident_{};
  std::uint8_t swapped_{};
  std::uint8_t shared_{};

  bool operator==(const Cell&) const = default;
};
static_assert(wire::WireStruct<Cell> && sizeof(Cell) == 3);
inline constexpr Cell kUnmeasuredCell{kNotMeasured, kNotMeasured, kNotMeasured};

inline constexpr std::array<char, 4> kMagic{'T', 'V', 'M', 'A'};

struct Header
{
  std::array<char, 4> magic_ = kMagic;
  std::uint8_t version_ = kVersion;
  PartKind kind_{};
  std::uint16_t part_{};
  std::uint16_t parts_{};
  std::uint16_t count_{};  // values, VMAs or cells in this part
  std::uint32_t sequence_{};
  // The thread ticks' session, so the streams can be matched.
  std::uint64_t session_{};
  std::uint64_t monotonic_ns_{};
  std::uint64_t wall_ns_{};
  std::uint32_t pid_{};
  std::uint32_t interval_ms_{};
  std::uint64_t process_start_{};  // /proc/PID/stat starttime, clock ticks
  // Rises each time the sampler sees a VMA appear, disappear or change.
  std::uint32_t generation_{};
  Flags flags_{};
  std::uint16_t layout_parts_{};  // parts 1..layout_parts_ hold the VMAs

  // Every part of one cycle carries the same header apart from these.
  [[nodiscard]] bool SameCycle(const Header& p_other) const noexcept
  {
    return parts_ == p_other.parts_ && sequence_ == p_other.sequence_ &&
           session_ == p_other.session_ &&
           monotonic_ns_ == p_other.monotonic_ns_ &&
           wall_ns_ == p_other.wall_ns_ && pid_ == p_other.pid_ &&
           interval_ms_ == p_other.interval_ms_ &&
           process_start_ == p_other.process_start_ &&
           generation_ == p_other.generation_ && flags_ == p_other.flags_ &&
           layout_parts_ == p_other.layout_parts_;
  }
};
static_assert(wire::WireStruct<Header> && sizeof(Header) == kHeaderSize);
static_assert(offsetof(Header, sequence_) == 12 &&
              offsetof(Header, session_) == 16 &&
              offsetof(Header, pid_) == 40 &&
              offsetof(Header, generation_) == 56);

struct SummaryPart
{
  Header header_;
  SummaryValues values_{};
};
inline constexpr std::size_t kSummaryPartSize =
    kHeaderSize + kSummaryFields.size() * 8;
static_assert(wire::WireStruct<SummaryPart> &&
              sizeof(SummaryPart) == kSummaryPartSize);

struct VmasPart
{
  Header header_;
  std::array<Vma, kVmasPerPart> vmas_{};
};
static_assert(wire::WireStruct<VmasPart> &&
              sizeof(VmasPart) == kHeaderSize + kVmasPerPart * kVmaSize);

struct DetailPart
{
  Header header_;
  Detail detail_;
  std::array<Cell, kCellsPerPart> cells_{};
};
static_assert(wire::WireStruct<DetailPart> &&
              sizeof(DetailPart) ==
                  kHeaderSize + kDetailSize + kCellsPerPart * sizeof(Cell));

inline constexpr std::size_t kMaxPartSize =
    std::max({sizeof(SummaryPart), sizeof(VmasPart), sizeof(DetailPart)});
// Fits an unfragmented UDP datagram on a 1,500-byte Ethernet MTU, and the
// collector's receive buffer.
static_assert(kMaxPartSize <= 1400);

using PartBuffer = std::span<std::byte, kMaxPartSize>;

// Datagrams for a layout of p_vmas VMAs.
[[nodiscard]] constexpr std::size_t LayoutParts(std::size_t p_vmas) noexcept
{
  return (p_vmas + kVmasPerPart - 1) / kVmasPerPart;
}

// Datagrams for p_cells cells.
[[nodiscard]] constexpr std::size_t DetailParts(std::size_t p_cells) noexcept
{
  return std::max<std::size_t>(1,
                               (p_cells + kCellsPerPart - 1) / kCellsPerPart);
}

// The encoders take the cycle's header (with parts_ and layout_parts_ set)
// and write one part into p_buffer. They return its length.
[[nodiscard]] inline std::size_t EncodeSummary(PartBuffer p_buffer,
                                               Header p_header,
                                               const SummaryValues& p_values)
{
  p_header.kind_ = PartKind::Summary;
  p_header.part_ = 0;
  p_header.count_ = static_cast<std::uint16_t>(p_values.size());
  const SummaryPart part{.header_ = p_header, .values_ = p_values};
  std::ranges::copy(wire::AsBytes(part), p_buffer.begin());
  return sizeof(part);
}

// Layout part p_index (0-based) of p_vmas.
[[nodiscard]] inline std::size_t EncodeVmas(PartBuffer p_buffer,
                                            Header p_header,
                                            std::span<const Vma> p_vmas,
                                            std::size_t p_index)
{
  assert(p_index < p_header.layout_parts_);
  const auto first = p_index * kVmasPerPart;
  assert(first < p_vmas.size());
  const auto count = std::min(kVmasPerPart, p_vmas.size() - first);
  p_header.kind_ = PartKind::Vmas;
  p_header.part_ = static_cast<std::uint16_t>(1 + p_index);
  p_header.count_ = static_cast<std::uint16_t>(count);
  VmasPart part{.header_ = p_header};
  std::ranges::copy(p_vmas.subspan(first, count), part.vmas_.begin());
  const auto length = kHeaderSize + count * kVmaSize;
  std::ranges::copy(wire::AsBytes(part).first(length), p_buffer.begin());
  return length;
}

// Detail part p_index (0-based) with its slice of p_cells.
[[nodiscard]] inline std::size_t EncodeDetail(PartBuffer p_buffer,
                                              Header p_header, Detail p_detail,
                                              std::span<const Cell> p_cells,
                                              std::size_t p_index)
{
  assert(p_cells.size() <= kMaxCells);
  const auto first = p_index * kCellsPerPart;
  const auto count = first < p_cells.size()
                         ? std::min(kCellsPerPart, p_cells.size() - first)
                         : std::size_t{0};
  p_header.kind_ = PartKind::Detail;
  p_header.part_ =
      static_cast<std::uint16_t>(1 + p_header.layout_parts_ + p_index);
  p_header.count_ = static_cast<std::uint16_t>(count);
  p_detail.cell_count_ = static_cast<std::uint32_t>(p_cells.size());
  p_detail.first_cell_ = static_cast<std::uint32_t>(first);
  DetailPart part{.header_ = p_header, .detail_ = p_detail};
  if (count > 0)
  {
    std::ranges::copy(p_cells.subspan(first, count), part.cells_.begin());
  }
  const auto length = kHeaderSize + kDetailSize + count * sizeof(Cell);
  std::ranges::copy(wire::AsBytes(part).first(length), p_buffer.begin());
  return length;
}

// One decoded datagram. values_ is set for a summary, vmas_ for a layout
// part, detail_ and cells_ for a detail part.
struct Part
{
  Header header_;
  SummaryValues values_{};
  std::array<Vma, kVmasPerPart> vmas_{};
  Detail detail_{};
  std::array<Cell, kCellsPerPart> cells_{};

  [[nodiscard]] std::span<const Vma> Vmas() const noexcept
  {
    return std::span{vmas_}.first(
        header_.kind_ == PartKind::Vmas ? header_.count_ : 0);
  }
  [[nodiscard]] std::span<const Cell> Cells() const noexcept
  {
    return std::span{cells_}.first(
        header_.kind_ == PartKind::Detail ? header_.count_ : 0);
  }
};

[[nodiscard]] inline bool ValidVma(const Vma& p_vma) noexcept
{
  const auto kind = std::to_underlying(p_vma.kind_);
  return p_vma.end_ > p_vma.start_ && kind >= 1 && kind <= kMaxVmaKind &&
         p_vma.permissions_ < 16 && (p_vma.changes_ & ~kKnownChanges) == 0 &&
         (p_vma.flags_ & ~kKnownVmaFlags) == 0 &&
         p_vma.reserved_ == decltype(p_vma.reserved_){};
}

[[nodiscard]] inline bool ValidCell(const Cell& p_cell) noexcept
{
  if (p_cell == kUnmeasuredCell)
  {
    return true;
  }
  return p_cell.resident_ <= kCellScale && p_cell.swapped_ <= kCellScale &&
         p_cell.shared_ <= kCellScale;
}

// Checks the format: length, magic, version, part numbering, reserved bytes
// and value ranges. Whether the values make sense is up to the reader.
[[nodiscard]] inline std::expected<Part, std::string_view> Decode(
    std::span<const std::byte> p_data)
{
  if (p_data.size() < kHeaderSize || std::memcmp(p_data.data(), "TVMA", 4) != 0)
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
      header.parts_ == 0 || header.parts_ > kMaxParts ||
      header.part_ >= header.parts_ || header.layout_parts_ > kMaxLayoutParts ||
      header.layout_parts_ >= header.parts_ ||
      header.parts_ - 1U - header.layout_parts_ > kMaxDetailParts)
  {
    return std::unexpected("invalid memory-map header");
  }
  if (header.monotonic_ns_ == 0 || header.wall_ns_ == 0 ||
      header.interval_ms_ < 1000 || header.interval_ms_ > 60000)
  {
    return std::unexpected("invalid memory-map clock");
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
  if (header.kind_ == PartKind::Vmas)
  {
    if (header.part_ == 0 || header.part_ > header.layout_parts_ ||
        header.count_ == 0 || header.count_ > kVmasPerPart ||
        p_data.size() != kHeaderSize + header.count_ * kVmaSize)
    {
      return std::unexpected("invalid memory-map layout part");
    }
    for (std::size_t index = 0; index < header.count_; ++index)
    {
      part.vmas_[index] =
          wire::FromBytes<Vma>(p_data.subspan(kHeaderSize + index * kVmaSize));
      if (!ValidVma(part.vmas_[index]))
      {
        return std::unexpected("invalid VMA");
      }
    }
    return part;
  }
  if (header.kind_ != PartKind::Detail ||
      header.part_ <= header.layout_parts_ || header.count_ > kCellsPerPart ||
      p_data.size() != kHeaderSize + kDetailSize + header.count_ * sizeof(Cell))
  {
    return std::unexpected("invalid memory-map detail part");
  }
  auto& detail = part.detail_;
  detail = wire::FromBytes<Detail>(p_data.subspan(kHeaderSize));
  const auto status = std::to_underlying(detail.status_);
  const auto index = header.part_ - 1U - header.layout_parts_;
  if (status == 0 || status > kMaxDetailStatus ||
      detail.reserved_ != decltype(detail.reserved_){} ||
      detail.cell_count_ > kMaxCells ||
      detail.first_cell_ != index * kCellsPerPart ||
      detail.first_cell_ + header.count_ > detail.cell_count_ ||
      (detail.cell_count_ > 0 && detail.vma_end_ <= detail.vma_start_))
  {
    return std::unexpected("invalid memory-map detail");
  }
  for (std::size_t cell = 0; cell < header.count_; ++cell)
  {
    part.cells_[cell] = wire::FromBytes<Cell>(
        p_data.subspan(kHeaderSize + kDetailSize + cell * sizeof(Cell)));
    if (!ValidCell(part.cells_[cell]))
    {
      return std::unexpected("invalid memory-map cell");
    }
  }
  return part;
}

// ---- Requests: collector to sampler ----

inline constexpr std::array<char, 4> kRequestMagic{'T', 'V', 'M', 'Q'};
inline constexpr std::size_t kRequestSize = 64;
inline constexpr std::size_t kSignedBytes = 32;
// The token is at least this long, so it cannot be guessed.
inline constexpr std::size_t kMinTokenSize = 32;

enum class Action : std::uint8_t
{
  Watch = 1,
  Stop = 2
};

enum class Tier : std::uint8_t
{
  Layout = 1,  // tiers 0 and 1: status, stat, limits and maps
  Detail = 2   // also tier 2: pagemap for the VMA at vma_start_
};

struct Request
{
  std::array<char, 4> magic_ = kRequestMagic;
  std::uint8_t version_ = kVersion;
  Action action_{};
  Tier tier_{};
  std::uint8_t reserved_{};  // zero
  std::uint32_t lease_s_{};
  std::array<std::uint8_t, 4> reserved_end_{};  // zero
  // The collector's wall clock in nanoseconds. The sampler accepts only a
  // counter larger than the last one it accepted, so an old request cannot
  // be sent again, and a restarted collector continues with larger values.
  std::uint64_t counter_{};
  std::uint64_t vma_start_{};  // Tier::Detail only
  Sha256Digest mac_{};         // HMAC-SHA256 of the 32 bytes before it
};
static_assert(wire::WireStruct<Request> && sizeof(Request) == kRequestSize);
static_assert(offsetof(Request, mac_) == kSignedBytes);

[[nodiscard]] inline Sha256Digest RequestMac(
    const Request& p_request, std::span<const std::uint8_t> p_token) noexcept
{
  const auto bytes = wire::AsBytes(p_request).first<kSignedBytes>();
  std::array<std::uint8_t, kSignedBytes> message{};
  std::memcpy(message.data(), bytes.data(), message.size());
  return HmacSha256(p_token, message);
}

[[nodiscard]] inline Request Sign(Request p_request,
                                  std::span<const std::uint8_t> p_token)
{
  p_request.mac_ = RequestMac(p_request, p_token);
  return p_request;
}

// Checks the format and the MAC. The caller checks the counter, the sender
// and the rate.
[[nodiscard]] inline std::expected<Request, std::string_view> DecodeRequest(
    std::span<const std::byte> p_data, std::span<const std::uint8_t> p_token)
{
  if (p_data.size() != kRequestSize ||
      std::memcmp(p_data.data(), kRequestMagic.data(), 4) != 0)
  {
    return std::unexpected("not a memory-map request");
  }
  const auto request = wire::FromBytes<Request>(p_data);
  // The MAC first: an unsigned datagram gets no answer about its format.
  if (!EqualDigests(request.mac_, RequestMac(request, p_token)))
  {
    return std::unexpected("invalid request signature");
  }
  const auto action = std::to_underlying(request.action_);
  const auto tier = std::to_underlying(request.tier_);
  if (request.version_ != kVersion || action < 1 || action > 2 || tier < 1 ||
      tier > 2 || request.reserved_ != 0 ||
      request.reserved_end_ != decltype(request.reserved_end_){} ||
      request.counter_ == 0 ||
      (request.action_ == Action::Watch && request.lease_s_ == 0))
  {
    return std::unexpected("invalid request");
  }
  return request;
}

}  // namespace triangulator::memory_wire
