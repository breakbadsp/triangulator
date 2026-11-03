#pragma once

// The memory probe: the target's virtual address space. It reads, without
// privileges, /proc/PID/status, stat and limits for a summary, and
// /proc/PID/maps for the layout. The sampler runs it at a slow rate
// (memory_interval_s), on a thread tick after that tick's thread sample.
//
// Reading maps shares the target's memory-map lock (mmap_lock) with the
// target, so the target's mmap and munmap calls can wait for the read. The
// probe reads maps in small reads and stops at a time budget; the next tick
// continues from the same file position. One read() is one lock hold, so
// the reads are kept small. The whole read is not one atomic snapshot
// anyway: the kernel takes and drops the lock for each read() call.
//
// Reading maps is the expensive part, so samples alternate: a full sample
// reads the summary and maps, and the next one reads the summary only. The
// first sample of a session is full. A summary-only sample leaves the
// map-derived values unavailable and carries no layout, so the collector
// keeps its last complete layout and nothing looks fresh that is not.
//
// TODO(PR 37 review): measure how much reading maps delays the target's mmap
// and munmap calls on older kernels and on targets with tens of thousands of
// mappings. It has been measured only on Linux 7.2 with about 1,000 mappings.

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <bit>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>
#include <string_view>
#include <utility>

#include "../common/memory_wire.hpp"
#include "io.hpp"
#include "resource_parsing.hpp"

namespace triangulator
{

// One line of /proc/PID/maps, such as
// "7f12a000-7f12c000 r-xp 00000000 08:01 1234   /usr/lib/libc.so.6".
// name_ views the line.
struct MapsLine
{
  std::uint64_t start_{};
  std::uint64_t end_{};
  std::uint8_t permissions_{};
  memory_wire::RegionKind kind_{};
  std::string_view name_;
};

[[nodiscard]] constexpr memory_wire::RegionKind ClassifyMapping(
    std::string_view p_name)
{
  using memory_wire::RegionKind;
  if (p_name.empty())
  {
    return RegionKind::Anonymous;
  }
  if (p_name == "[heap]")
  {
    return RegionKind::Heap;
  }
  if (p_name == "[stack]")
  {
    return RegionKind::Stack;
  }
  if (p_name == "[vdso]" || p_name == "[vvar]" || p_name == "[vvar_vclock]" ||
      p_name == "[vsyscall]")
  {
    return RegionKind::Kernel;
  }
  // A path is a mapped file. Other names, such as [anon:glibc: malloc] or
  // anon_inode:i915.gem, are memory with a name but no file.
  return p_name.starts_with('/') ? RegionKind::File : RegionKind::Anonymous;
}

[[nodiscard]] constexpr std::optional<MapsLine> ParseMapsLine(
    std::string_view p_line)
{
  auto rest = p_line;
  const auto range = NextToken(rest);
  const auto permissions = NextToken(rest);
  const auto offset = NextToken(rest);
  const auto device = NextToken(rest);
  const auto inode = NextToken(rest);
  const auto dash = range.find('-');
  if (dash == std::string_view::npos || permissions.size() != 4 ||
      offset.empty() || device.empty() || inode.empty())
  {
    return std::nullopt;
  }
  const auto start = ParseHex(range.substr(0, dash));
  const auto end = ParseHex(range.substr(dash + 1));
  if (!start || !end || *start >= *end)
  {
    return std::nullopt;
  }
  using memory_wire::Permission;
  std::uint8_t bits = 0;
  const auto set = [&bits](bool p_on, Permission p_bit)
  {
    if (p_on)
    {
      bits |= std::to_underlying(p_bit);
    }
  };
  set(permissions[0] == 'r', Permission::Read);
  set(permissions[1] == 'w', Permission::Write);
  set(permissions[2] == 'x', Permission::Execute);
  set(permissions[3] == 's', Permission::Shared);
  // The path starts after the spaces that follow the inode. A path can
  // contain spaces, so the rest of the line is the name.
  const auto name =
      rest.substr(std::min(rest.find_first_not_of(' '), rest.size()));
  return MapsLine{*start, *end, bits, ClassifyMapping(name), name};
}

// FNV-1a over p_bytes.
[[nodiscard]] constexpr std::uint64_t Fnv1a(
    std::span<const std::byte> p_bytes) noexcept
{
  std::uint64_t hash = 14695981039346656037ull;
  for (const auto byte : p_bytes)
  {
    hash = (hash ^ std::to_integer<std::uint64_t>(byte)) * 1099511628211ull;
  }
  return hash;
}

// The layout: maps lines joined into regions, in address order. The
// storage is fixed at kMaxRegions; later regions are counted, not kept.
class LayoutBuilder
{
 public:
  void Clear() noexcept
  {
    size_ = 0;
    vma_count_ = 0;
    truncated_ = false;
    last_name_hash_ = 0;
  }

  void Add(const MapsLine& p_line)
  {
    ++vma_count_;
    // Joining compares the whole name: two paths with the same end are
    // different files.
    const auto name_hash = HashName(p_line.name_);
    const auto previous_hash = std::exchange(last_name_hash_, name_hash);
    if (size_ != 0)
    {
      auto& last = regions_[size_ - 1];
      if (last.end_ == p_line.start_ && last.kind_ == p_line.kind_ &&
          previous_hash == name_hash)
      {
        last.end_ = p_line.end_;
        ++last.vma_count_;
        last.permissions_ |= p_line.permissions_;
        return;
      }
    }
    if (size_ == regions_.size())
    {
      truncated_ = true;
      return;
    }
    auto& region = regions_[size_++];
    region = memory_wire::Region{.start_ = p_line.start_,
                                 .end_ = p_line.end_,
                                 .vma_count_ = 1,
                                 .kind_ = p_line.kind_,
                                 .permissions_ = p_line.permissions_};
    // Keep the end of a long path: the file name is the useful part.
    const auto kept = p_line.name_.substr(
        p_line.name_.size() -
        std::min(p_line.name_.size(), memory_wire::kNameSize - 1));
    std::ranges::copy(kept, region.name_.begin());
  }

  [[nodiscard]] std::span<const memory_wire::Region> Regions() const noexcept
  {
    return std::span{regions_}.first(size_);
  }
  [[nodiscard]] std::uint64_t VmaCount() const noexcept
  {
    return vma_count_;
  }
  [[nodiscard]] bool Truncated() const noexcept
  {
    return truncated_;
  }

 private:
  // Hashes p_name eight bytes at a time. Only the equality of the hashes of
  // two neighbouring names matters, so this need not be FNV-1a.
  [[nodiscard]] static std::uint64_t HashName(std::string_view p_name) noexcept
  {
    constexpr std::uint64_t kPrime = 0x9E3779B97F4A7C15ull;
    std::uint64_t hash = p_name.size();
    std::size_t offset = 0;
    for (; offset + sizeof(std::uint64_t) <= p_name.size();
         offset += sizeof(std::uint64_t))
    {
      std::uint64_t word{};
      std::memcpy(&word, p_name.data() + offset, sizeof(word));
      hash = std::rotl((hash ^ word) * kPrime, 29);
    }
    std::uint64_t tail{};
    if (offset < p_name.size())
    {
      std::memcpy(&tail, p_name.data() + offset, p_name.size() - offset);
    }
    return (hash ^ tail) * kPrime;
  }

  std::array<memory_wire::Region, memory_wire::kMaxRegions> regions_{};
  std::size_t size_ = 0;
  std::uint64_t vma_count_ = 0;
  bool truncated_ = false;
  // The full name of the last line added, hashed; regions_ keeps only its
  // end.
  std::uint64_t last_name_hash_ = 0;
};

// Field p_field (1-based, as in proc(5)) of /proc/PID/stat, as a number.
[[nodiscard]] constexpr std::optional<std::uint64_t> FindStatField(
    std::string_view p_text, int p_field)
{
  const auto last = p_text.rfind(')');
  if (last == std::string_view::npos || p_field < 3)
  {
    return std::nullopt;
  }
  auto fields = p_text.substr(last + 1);
  for (int field = 3; field < p_field; ++field)
  {
    if (NextToken(fields).empty())
    {
      return std::nullopt;
    }
  }
  return ParseNumber<std::uint64_t>(NextToken(fields));
}

// The soft limit in row p_row of /proc/PID/limits, such as "Max stack
// size". Unlimited, or a missing row, is kUnavailable.
[[nodiscard]] constexpr std::uint64_t FindSoftLimit(std::string_view p_text,
                                                    std::string_view p_row)
{
  std::uint64_t result = memory_wire::kUnavailable;
  ForEachLine(p_text,
              [&](std::string_view p_line)
              {
                if (!p_line.starts_with(p_row))
                {
                  return;
                }
                auto rest = p_line.substr(p_row.size());
                result = ParseNumber<std::uint64_t>(NextToken(rest))
                             .value_or(memory_wire::kUnavailable);
              });
  return result;
}

// The checks below make the compiler run the helpers on fixed input.
static_assert(ClassifyMapping("") == memory_wire::RegionKind::Anonymous &&
              ClassifyMapping("[heap]") == memory_wire::RegionKind::Heap &&
              ClassifyMapping("[vdso]") == memory_wire::RegionKind::Kernel &&
              ClassifyMapping("/lib/x.so") == memory_wire::RegionKind::File &&
              ClassifyMapping("[anon:x]") ==
                  memory_wire::RegionKind::Anonymous);
static_assert(
    []
    {
      const auto line =
          ParseMapsLine("7f00-7f10 r-xp 00001000 08:01 42   /usr/lib/a b.so");
      return line && line->start_ == 0x7f00 && line->end_ == 0x7f10 &&
             line->permissions_ ==
                 (std::to_underlying(memory_wire::Permission::Read) |
                  std::to_underlying(memory_wire::Permission::Execute)) &&
             line->kind_ == memory_wire::RegionKind::File &&
             line->name_ == "/usr/lib/a b.so" &&
             !ParseMapsLine("7f10-7f00 r-xp 0 08:01 42");
    }());
// FNV-1a test vectors: the empty input and "a".
static_assert(Fnv1a({}) == 14695981039346656037ull &&
              Fnv1a(std::array{std::byte{'a'}}) == 0xaf63dc4c8601ec8cull);
static_assert(FindStatField("1 (a) S 7 8", 4) == 7 &&
              !FindStatField("1 (a) S 7 8", 9) && !FindStatField("1 (a", 4));
static_assert(FindSoftLimit("Max stack size 8388608 unlimited bytes\n",
                            "Max stack size") == 8388608 &&
              FindSoftLimit("Max stack size unlimited unlimited bytes\n",
                            "Max stack size") == memory_wire::kUnavailable);

// A finished sample. A summary-only sample has its map-derived values
// (vma_count and maps_*) unavailable. regions_ views the probe's storage and
// stays valid until the probe's next Start(). It is empty when the layout is
// unchanged since the last sample that sent it, unless that sample asked for
// it.
struct MemorySample
{
  memory_wire::SummaryValues summary_ = memory_wire::EmptySummary();
  memory_wire::Flags flags_ = memory_wire::Flags::None;
  std::span<const memory_wire::Region> regions_;
};

class MemoryProbe
{
 public:
  static constexpr std::size_t kReadBytes = 4096;

  // Whether a sample is in progress: Continue() has more of maps to read.
  [[nodiscard]] bool Busy() const noexcept
  {
    return busy_;
  }

  // Whether the next Start() reads maps, not only the summary.
  [[nodiscard]] bool NextReadsMaps() const noexcept
  {
    return next_reads_maps_;
  }

  // Forgets the last layout and any sample in progress, for a new session.
  // The next sample reads maps.
  void Reset() noexcept
  {
    maps_ = FileDescriptor{};
    busy_ = false;
    last_layout_hash_.reset();
    next_reads_maps_ = true;
    maps_flags_ = memory_wire::Flags::None;
  }

  // Starts a sample of p_pid: reads the summary files, which take no
  // memory-map lock, and opens maps when this sample reads them. The sample
  // carries the layout when it changed, or when p_send_layout asks for it: a
  // periodic refresh for a collector that started later or lost a part.
  void Start(int p_pid, bool p_send_layout)
  {
    Start(p_pid, p_send_layout, FixedString{"/proc/{}/maps", p_pid}.CStr());
  }

  // Start(), with the layout read from p_maps_path instead of
  // /proc/PID/maps. Tests use it for maps text the kernel does not make.
  void Start(int p_pid, bool p_send_layout, const char* p_maps_path)
  {
    busy_ = true;
    send_layout_ = p_send_layout;
    sample_ = MemorySample{};
    layout_.Clear();
    used_ = 0;
    read_time_ = Nanoseconds{0};
    longest_read_ = Nanoseconds{0};
    reads_ = 0;
    reads_maps_ = std::exchange(next_reads_maps_, !next_reads_maps_);
    ReadSummary(p_pid);
    if (!reads_maps_)
    {
      return;
    }
    maps_ = OpenReadonly(p_maps_path);
    if (!maps_)
    {
      sample_.flags_ = sample_.flags_ | memory_wire::Flags::MapsHidden;
    }
  }

  // Reads maps until it ends or p_deadline passes. Returns the sample when
  // it is complete, nullopt when more remains for a later call.
  [[nodiscard]] std::optional<MemorySample> Continue(Nanoseconds p_deadline)
  {
    if (!busy_)
    {
      return std::nullopt;
    }
    while (maps_)
    {
      if (ClockNow(CLOCK_MONOTONIC) >= p_deadline)
      {
        return std::nullopt;
      }
      ReadMore();
    }
    return Finish();
  }

 private:
  void ReadSummary(int p_pid)
  {
    using memory_wire::Field;
    auto& summary = sample_.summary_;
    if (const auto text = Read(FixedString{"/proc/{}/status", p_pid}.CStr()))
    {
      constexpr std::array<std::pair<std::string_view, std::size_t>, 8> kKeys{
          {{"VmSize", Field("vm_size_bytes")},
           {"VmPeak", Field("vm_peak_bytes")},
           {"VmData", Field("vm_data_bytes")},
           {"VmStk", Field("vm_stack_bytes")},
           {"VmExe", Field("vm_exe_bytes")},
           {"VmLib", Field("vm_lib_bytes")},
           {"VmPTE", Field("vm_pte_bytes")},
           {"VmLck", Field("vm_locked_bytes")}}};
      for (const auto& [key, field] : kKeys)
      {
        summary[field] =
            FindKilobytes(*text, key).value_or(memory_wire::kUnavailable);
      }
    }
    if (const auto text = Read(FixedString{"/proc/{}/stat", p_pid}.CStr()))
    {
      summary[Field("minor_faults")] =
          FindStatField(*text, 10).value_or(memory_wire::kUnavailable);
      summary[Field("major_faults")] =
          FindStatField(*text, 12).value_or(memory_wire::kUnavailable);
    }
    if (const auto text = Read(FixedString{"/proc/{}/limits", p_pid}.CStr()))
    {
      summary[Field("address_space_limit_bytes")] =
          FindSoftLimit(*text, "Max address space");
      summary[Field("stack_limit_bytes")] =
          FindSoftLimit(*text, "Max stack size");
    }
    if (const auto text = Read("/proc/sys/vm/max_map_count"))
    {
      summary[Field("max_map_count")] =
          ParseNumber<std::uint64_t>(Trim(*text))
              .value_or(memory_wire::kUnavailable);
    }
  }

  // Contents of p_path, valid until the next read, or nullopt.
  [[nodiscard]] std::optional<std::string_view> Read(const char* p_path)
  {
    return ReadAtStart(OpenReadonly(p_path), buffer_);
  }

  // One read() of maps, then the complete lines in the buffer. A line cut
  // by the read stays at the front of the buffer for the next read.
  void ReadMore()
  {
    const auto space = std::min(kReadBytes, buffer_.size() - used_);
    const auto started = ClockNow(CLOCK_MONOTONIC);
    ssize_t length;
    do
    {
      length = ::read(maps_.Get(), buffer_.data() + used_, space);
    } while (length < 0 && errno == EINTR);
    const auto read_time = ClockNow(CLOCK_MONOTONIC) - started;
    read_time_ += read_time;
    longest_read_ = std::max(longest_read_, read_time);
    ++reads_;
    if (length <= 0)
    {
      if (length < 0 || used_ != 0)
      {
        sample_.flags_ = sample_.flags_ | memory_wire::Flags::MapsPartial;
      }
      maps_ = FileDescriptor{};
      return;
    }
    used_ += static_cast<std::size_t>(length);
    const std::string_view text{buffer_.data(), used_};
    const auto complete = text.rfind('\n');
    if (complete == std::string_view::npos)
    {
      if (used_ == buffer_.size())
      {
        // A line longer than the buffer: no maps line is, so drop it.
        sample_.flags_ = sample_.flags_ | memory_wire::Flags::MapsPartial;
        used_ = 0;
      }
      return;
    }
    ForEachLine(text.substr(0, complete),
                [this](std::string_view p_line)
                {
                  if (const auto line = ParseMapsLine(p_line))
                  {
                    layout_.Add(*line);
                  }
                });
    used_ -= complete + 1;
    std::memmove(buffer_.data(), buffer_.data() + complete + 1, used_);
  }

  [[nodiscard]] MemorySample Finish()
  {
    using memory_wire::Field;
    busy_ = false;
    if (!reads_maps_)
    {
      // The flags still describe the last maps read, which is the layout
      // the collector keeps.
      sample_.flags_ = maps_flags_;
      return sample_;
    }
    auto& summary = sample_.summary_;
    summary[Field("maps_read_us")] = Microseconds(read_time_);
    summary[Field("maps_read_max_us")] = Microseconds(longest_read_);
    summary[Field("maps_reads")] = reads_;
    if (memory_wire::HasFlag(sample_.flags_, memory_wire::Flags::MapsHidden))
    {
      maps_flags_ = sample_.flags_;
      return sample_;
    }
    summary[Field("vma_count")] = layout_.VmaCount();
    if (layout_.Truncated())
    {
      sample_.flags_ = sample_.flags_ | memory_wire::Flags::RegionsTruncated;
    }
    // The hash of the regions' bytes tells whether the layout changed.
    const auto hash = Fnv1a(std::as_bytes(layout_.Regions()));
    if (send_layout_ || hash != last_layout_hash_)
    {
      last_layout_hash_ = hash;
      sample_.regions_ = layout_.Regions();
    }
    maps_flags_ = sample_.flags_;
    return sample_;
  }

  [[nodiscard]] static std::uint64_t Microseconds(Nanoseconds p_time) noexcept
  {
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(p_time).count());
  }

  // Large enough for a maps line with a PATH_MAX path, plus one read.
  std::array<char, 16384> buffer_{};
  std::size_t used_ = 0;
  FileDescriptor maps_;
  bool busy_ = false;
  bool send_layout_ = false;
  // Whether the sample in progress, and the next one, read maps.
  bool reads_maps_ = true;
  bool next_reads_maps_ = true;
  // The flags of the last sample that read maps.
  memory_wire::Flags maps_flags_ = memory_wire::Flags::None;
  MemorySample sample_;
  LayoutBuilder layout_;
  Nanoseconds read_time_{0};
  Nanoseconds longest_read_{0};
  std::uint64_t reads_ = 0;
  std::optional<std::uint64_t> last_layout_hash_;
};

}  // namespace triangulator
