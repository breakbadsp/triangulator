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

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <optional>
#include <span>
#include <string_view>

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

[[nodiscard]] inline memory_wire::RegionKind ClassifyMapping(
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

[[nodiscard]] inline std::optional<MapsLine> ParseMapsLine(
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
  }

  void Add(const MapsLine& p_line)
  {
    ++vma_count_;
    std::array<char, memory_wire::kNameSize> name{};
    // Keep the end of a long path: the file name is the useful part.
    const auto kept = p_line.name_.substr(
        p_line.name_.size() -
        std::min(p_line.name_.size(), memory_wire::kNameSize - 1));
    std::ranges::copy(kept, name.begin());
    if (size_ != 0)
    {
      auto& last = regions_[size_ - 1];
      if (last.end_ == p_line.start_ && last.kind_ == p_line.kind_ &&
          last.name_ == name)
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
    regions_[size_++] = memory_wire::Region{.start_ = p_line.start_,
                                            .end_ = p_line.end_,
                                            .vma_count_ = 1,
                                            .kind_ = p_line.kind_,
                                            .permissions_ = p_line.permissions_,
                                            .name_ = name};
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
  std::array<memory_wire::Region, memory_wire::kMaxRegions> regions_{};
  std::size_t size_ = 0;
  std::uint64_t vma_count_ = 0;
  bool truncated_ = false;
};

// Field p_field (1-based, as in proc(5)) of /proc/PID/stat, as a number.
[[nodiscard]] inline std::optional<std::uint64_t> FindStatField(
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
[[nodiscard]] inline std::uint64_t FindSoftLimit(std::string_view p_text,
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

// A finished sample. regions_ views the probe's storage and stays valid
// until the probe's next Start(). It is empty when the layout is unchanged
// since the last sample that sent it.
struct MemorySample
{
  memory_wire::SummaryValues summary_ = memory_wire::EmptySummary();
  memory_wire::Flags flags_ = memory_wire::Flags::None;
  std::span<const memory_wire::Region> regions_;
};

class MemoryProbe
{
 public:
  // A layout is sent again after this many samples, even when unchanged,
  // so a collector that started later or lost a part gets it.
  static constexpr int kLayoutRefreshSamples = 10;
  static constexpr std::size_t kReadBytes = 4096;

  // Whether a sample is in progress: Continue() has more of maps to read.
  [[nodiscard]] bool Busy() const noexcept
  {
    return busy_;
  }

  // Forgets the last layout and any sample in progress, for a new session.
  void Reset() noexcept
  {
    maps_ = FileDescriptor{};
    busy_ = false;
    last_layout_hash_.reset();
    samples_since_layout_ = 0;
  }

  // Starts a sample of p_pid: reads the summary files, which take no
  // memory-map lock, and opens maps.
  void Start(int p_pid)
  {
    busy_ = true;
    sample_ = MemorySample{};
    layout_.Clear();
    used_ = 0;
    read_time_ = Nanoseconds{0};
    reads_ = 0;
    ReadSummary(p_pid);
    maps_ = OpenReadonly(FixedString{"/proc/{}/maps", p_pid}.CStr());
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
      for (const auto& [key, field] :
           {std::pair{"VmSize", Field("vm_size_bytes")},
            std::pair{"VmPeak", Field("vm_peak_bytes")},
            std::pair{"VmData", Field("vm_data_bytes")},
            std::pair{"VmStk", Field("vm_stack_bytes")},
            std::pair{"VmExe", Field("vm_exe_bytes")},
            std::pair{"VmLib", Field("vm_lib_bytes")},
            std::pair{"VmPTE", Field("vm_pte_bytes")},
            std::pair{"VmLck", Field("vm_locked_bytes")}})
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
    read_time_ += ClockNow(CLOCK_MONOTONIC) - started;
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
    auto& summary = sample_.summary_;
    summary[Field("maps_read_us")] = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::microseconds>(read_time_)
            .count());
    summary[Field("maps_reads")] = reads_;
    if (memory_wire::HasFlag(sample_.flags_, memory_wire::Flags::MapsHidden))
    {
      return sample_;
    }
    summary[Field("vma_count")] = layout_.VmaCount();
    if (layout_.Truncated())
    {
      sample_.flags_ = sample_.flags_ | memory_wire::Flags::RegionsTruncated;
    }
    const auto hash = Hash(layout_.Regions());
    if (hash != last_layout_hash_ ||
        ++samples_since_layout_ >= kLayoutRefreshSamples)
    {
      last_layout_hash_ = hash;
      samples_since_layout_ = 0;
      sample_.regions_ = layout_.Regions();
    }
    return sample_;
  }

  // FNV-1a over the regions' bytes, to tell whether the layout changed.
  [[nodiscard]] static std::uint64_t Hash(
      std::span<const memory_wire::Region> p_regions) noexcept
  {
    std::uint64_t hash = 14695981039346656037ull;
    for (const auto byte : std::as_bytes(p_regions))
    {
      hash = (hash ^ std::to_integer<std::uint64_t>(byte)) * 1099511628211ull;
    }
    return hash;
  }

  // Large enough for a maps line with a PATH_MAX path, plus one read.
  std::array<char, 16384> buffer_{};
  std::size_t used_ = 0;
  FileDescriptor maps_;
  bool busy_ = false;
  MemorySample sample_;
  LayoutBuilder layout_;
  Nanoseconds read_time_{0};
  std::uint64_t reads_ = 0;
  std::optional<std::uint64_t> last_layout_hash_;
  int samples_since_layout_ = 0;
};

}  // namespace triangulator
