#pragma once

// The sampler's memory-map thread (docs/process-memory-map-design.md,
// section 6). It starts only when memory_map_enabled = true. It then blocks
// on its control socket until the collector sends a signed "watch" request,
// reads the target's memory map once per memory_map_interval_s while the
// request's lease lasts, and sends TVMA datagrams. With no lease it reads
// nothing.
//
// Like the rest of the sampler it allocates only when it starts (at startup
// or on a reload); a cycle allocates nothing. Every loop over data from
// /proc has a bound.

#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <sys/eventfd.h>
#include <sys/socket.h>

#include <algorithm>
#include <array>
#include <cassert>
#include <cstdint>
#include <expected>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <stop_token>
#include <string>
#include <system_error>
#include <thread>
#include <vector>

#include "../common/memory_wire.hpp"
#include "config.hpp"
#include "io.hpp"
#include "memory_parsing.hpp"
#include "proc.hpp"

namespace triangulator
{

using memory_wire::VmaKind;

[[nodiscard]] inline VmaKind ClassifyVma(const MapsLine& p_line)
{
  const auto name = p_line.name_;
  if (name.empty())
  {
    return p_line.inode_ == 0 ? VmaKind::Anonymous : VmaKind::File;
  }
  if (name == "[heap]")
  {
    return VmaKind::Heap;
  }
  if (name == "[stack]")
  {
    return VmaKind::Stack;
  }
  if (name == "[vdso]" || name == "[vvar]" || name == "[vsyscall]" ||
      name == "[vvar_vclock]")
  {
    return VmaKind::Kernel;
  }
  if (name.starts_with("[anon:"))
  {
    return VmaKind::NamedAnonymous;
  }
  return name.starts_with('[') ? VmaKind::Other : VmaKind::File;
}

[[nodiscard]] inline memory_wire::Vma ToWireVma(const MapsLine& p_line)
{
  memory_wire::Vma vma{.start_ = p_line.start_,
                       .end_ = p_line.end_,
                       .offset_ = p_line.offset_,
                       .inode_ = p_line.inode_,
                       .device_major_ = p_line.device_major_,
                       .device_minor_ = p_line.device_minor_,
                       .permissions_ = p_line.permissions_,
                       .kind_ = ClassifyVma(p_line)};
  if (p_line.deleted_)
  {
    vma.flags_ = std::to_underlying(memory_wire::VmaFlags::Deleted);
  }
  vma.SetName(p_line.name_);
  return vma;
}

// Times each read of a file that takes the target's mmap_lock, and spaces
// the reads out when one is slow: a read's time shows how long the target's
// memory-map lock was held (design, section 11).
class ReadPacer
{
 public:
  static constexpr Nanoseconds kSlowRead = 2ms;
  static constexpr Nanoseconds kFirstBackoff = 1ms;
  static constexpr Nanoseconds kMaxBackoff = 50ms;

  void StartCycle() noexcept
  {
    total_ = Nanoseconds{0};
    longest_ = Nanoseconds{0};
    reads_ = 0;
    slow_reads_ = 0;
  }

  // A cycle with no slow read halves the pause between reads.
  void EndCycle() noexcept
  {
    if (slow_reads_ == 0)
    {
      backoff_ = backoff_ / 2 < kFirstBackoff ? Nanoseconds{0} : backoff_ / 2;
    }
  }

  // Runs p_read (a read() or pread() call) and returns its result.
  template <typename TRead>
  ssize_t Timed(TRead&& p_read)
  {
    if (reads_ > 0 && backoff_ > Nanoseconds{0})
    {
      const auto seconds =
          std::chrono::duration_cast<std::chrono::seconds>(backoff_);
      const timespec pause{
          .tv_sec = static_cast<time_t>(seconds.count()),
          .tv_nsec = static_cast<long>((backoff_ - seconds).count())};
      ::nanosleep(&pause, nullptr);
    }
    const auto started = ClockNow(CLOCK_MONOTONIC);
    ssize_t result;
    do
    {
      result = p_read();
    } while (result < 0 && errno == EINTR);
    const auto elapsed = ClockNow(CLOCK_MONOTONIC) - started;
    total_ += elapsed;
    longest_ = std::max(longest_, elapsed);
    ++reads_;
    if (elapsed > kSlowRead)
    {
      ++slow_reads_;
      backoff_ = std::min(kMaxBackoff, std::max(kFirstBackoff, backoff_ * 2));
    }
    return result;
  }

  void Store(memory_wire::SummaryValues& p_summary) const noexcept
  {
    using memory_wire::Field;
    p_summary[Field("read_ns_total")] =
        static_cast<std::uint64_t>(total_.count());
    p_summary[Field("read_ns_max")] =
        static_cast<std::uint64_t>(longest_.count());
    p_summary[Field("reads")] = reads_;
    p_summary[Field("slow_reads")] = slow_reads_;
    p_summary[Field("backoff_us")] =
        static_cast<std::uint64_t>(backoff_.count() / 1000);
  }

 private:
  Nanoseconds backoff_{0};
  Nanoseconds total_{0};
  Nanoseconds longest_{0};
  std::uint64_t reads_ = 0;
  std::uint64_t slow_reads_ = 0;
};

// Tier 2: reduces the pagemap entries of one VMA to at most kMaxCells cells.
// A large VMA can need more reads than one burst allows; the scan then goes
// on in the next cycle where it stopped, and the cells keep the values of
// the previous pass until they are read again.
class PageScanner
{
 public:
  static constexpr std::size_t kEntriesPerRead = 512;  // 4 KiB of pagemap
  static constexpr std::uint64_t kPagesPerBurst = 262'144;
  static constexpr Nanoseconds kBurstBudget = 50ms;

  void Reset() noexcept
  {
    start_ = 0;
    end_ = 0;
    pages_ = 0;
    cursor_ = 0;
    cell_count_ = 0;
    complete_ = false;
  }

  // Scans the next part of [p_vma_start, p_vma_end) of p_pid. p_vma_end is
  // nullopt when no VMA starts at p_vma_start now.
  [[nodiscard]] memory_wire::Detail Scan(int p_pid, std::uint64_t p_vma_start,
                                         std::optional<std::uint64_t> p_vma_end,
                                         std::uint64_t p_page_size,
                                         ReadPacer& p_pacer,
                                         const std::stop_token& p_stop)
  {
    using memory_wire::DetailStatus;
    if (!p_vma_end)
    {
      Reset();
      return {.vma_start_ = p_vma_start, .status_ = DetailStatus::NotFound};
    }
    if (p_vma_start != start_ || *p_vma_end != end_)
    {
      // A new selection, or the VMA grew or shrank: the cells cover other
      // pages now.
      Geometry(p_vma_start, *p_vma_end, p_page_size);
    }
    const auto started = ClockNow(CLOCK_MONOTONIC);
    const auto descriptor =
        OpenReadonly(FixedString{"/proc/{}/pagemap", p_pid}.CStr());
    bool readable = static_cast<bool>(descriptor);
    std::uint64_t budget = kPagesPerBurst;
    const auto first_page = start_ / p_page_size;
    while (readable && budget > 0 && cursor_ < pages_ &&
           !p_stop.stop_requested() &&
           ClockNow(CLOCK_MONOTONIC) - started < kBurstBudget)
    {
      const auto count = static_cast<std::size_t>(
          std::min({std::uint64_t{kEntriesPerRead}, pages_ - cursor_, budget}));
      const auto offset = static_cast<off_t>((first_page + cursor_) * 8);
      const auto length = p_pacer.Timed(
          [&]
          {
            return ::pread(descriptor.Get(), entries_.data(), count * 8,
                           offset);
          });
      if (length < 8)
      {
        readable = false;
        break;
      }
      const auto read = static_cast<std::size_t>(length) / 8;
      for (std::size_t index = 0; index < read; ++index)
      {
        Add(DecodePagemapEntry(entries_[index]));
      }
      budget -= read;
    }
    if (cursor_ == pages_)
    {
      complete_ = true;
      cursor_ = 0;
    }
    memory_wire::Detail detail{
        .vma_start_ = start_,
        .vma_end_ = end_,
        .pages_per_cell_ = pages_per_cell_,
        .scan_ns_ = static_cast<std::uint64_t>(
            (ClockNow(CLOCK_MONOTONIC) - started).count()),
        .status_ = !readable   ? DetailStatus::Unreadable
                   : complete_ ? DetailStatus::Complete
                               : DetailStatus::Measuring};
    for (std::size_t cell = 0; cell < cell_count_; ++cell)
    {
      if (cells_[cell] == memory_wire::kUnmeasuredCell)
      {
        continue;
      }
      detail.measured_pages_ += CellPages(cell);
      detail.resident_pages_ += counts_[cell].resident_;
      detail.swapped_pages_ += counts_[cell].swapped_;
      detail.shared_pages_ += counts_[cell].shared_;
    }
    return detail;
  }

  [[nodiscard]] std::span<const memory_wire::Cell> Cells() const noexcept
  {
    return std::span{cells_}.first(cell_count_);
  }

 private:
  struct Counts
  {
    std::uint32_t resident_ = 0;
    std::uint32_t swapped_ = 0;
    std::uint32_t shared_ = 0;
  };

  void Geometry(std::uint64_t p_start, std::uint64_t p_end,
                std::uint64_t p_page_size)
  {
    start_ = p_start;
    end_ = p_end;
    pages_ = (p_end - p_start) / p_page_size;
    const auto cells = std::min<std::uint64_t>(memory_wire::kMaxCells, pages_);
    pages_per_cell_ = cells == 0 ? 1 : (pages_ + cells - 1) / cells;
    cell_count_ = static_cast<std::size_t>((pages_ + pages_per_cell_ - 1) /
                                           pages_per_cell_);
    assert(cell_count_ <= memory_wire::kMaxCells);
    cells_.fill(memory_wire::kUnmeasuredCell);
    counts_.fill({});
    pending_ = {};
    cursor_ = 0;
    complete_ = false;
  }

  [[nodiscard]] std::uint64_t CellPages(std::size_t p_cell) const noexcept
  {
    const auto first = p_cell * pages_per_cell_;
    return std::min(pages_per_cell_, pages_ - first);
  }

  void Add(PageBits p_bits)
  {
    pending_.resident_ += p_bits.present_ ? 1U : 0U;
    pending_.swapped_ += p_bits.swapped_ ? 1U : 0U;
    pending_.shared_ += p_bits.present_ && !p_bits.exclusive_ ? 1U : 0U;
    ++cursor_;
    if (cursor_ % pages_per_cell_ != 0 && cursor_ != pages_)
    {
      return;
    }
    const auto cell = static_cast<std::size_t>((cursor_ - 1) / pages_per_cell_);
    const auto pages = CellPages(cell);
    const auto scale = [pages](std::uint32_t p_count)
    {
      return static_cast<std::uint8_t>(
          (p_count * std::uint64_t{memory_wire::kCellScale} + pages / 2) /
          pages);
    };
    cells_[cell] = {scale(pending_.resident_), scale(pending_.swapped_),
                    scale(pending_.shared_)};
    counts_[cell] = pending_;
    pending_ = {};
  }

  std::uint64_t start_ = 0;
  std::uint64_t end_ = 0;
  std::uint64_t pages_ = 0;
  std::uint64_t pages_per_cell_ = 1;
  std::uint64_t cursor_ = 0;
  std::size_t cell_count_ = 0;
  bool complete_ = false;
  Counts pending_;
  std::array<memory_wire::Cell, memory_wire::kMaxCells> cells_{};
  std::array<Counts, memory_wire::kMaxCells> counts_{};
  std::array<std::uint64_t, kEntriesPerRead> entries_{};
};

// One cycle's result. The VMA list and the cells stay in the reader.
struct MemoryCycle
{
  memory_wire::SummaryValues summary_ = memory_wire::EmptySummary();
  memory_wire::Flags flags_ = memory_wire::Flags::None;
  bool layout_changed_ = false;
  std::optional<memory_wire::Detail> detail_;
};

// Tiers 0, 1 and 2 for one process: reads status, stat, limits, maps and,
// for a selected VMA, pagemap.
class MemoryMapReader
{
 public:
  static constexpr std::size_t kMapsReadBytes = 4096;
  // The longest maps line: a 4096-byte path and the columns before it.
  static constexpr std::size_t kLongestLine = 4096 + 128;

  explicit MemoryMapReader(std::size_t p_max_vmas)
      : max_vmas_(p_max_vmas),
        page_size_(static_cast<std::uint64_t>(::sysconf(_SC_PAGESIZE))),
        cpu_count_(::sysconf(_SC_NPROCESSORS_ONLN))
  {
    assert(p_max_vmas > 0);
    assert(p_max_vmas <= memory_wire::kMaxVmas);
    current_.reserve(p_max_vmas);
    previous_.reserve(p_max_vmas);
    matched_.reserve(p_max_vmas);
  }

  // Forgets the previous list, so the next cycle marks no VMA as changed.
  void Reset() noexcept
  {
    previous_.clear();
    first_cycle_ = true;
    scanner_.Reset();
  }

  [[nodiscard]] MemoryCycle Read(int p_pid,
                                 std::optional<std::uint64_t> p_detail_start,
                                 const std::stop_token& p_stop)
  {
    using memory_wire::Field;
    MemoryCycle cycle;
    pacer_.StartCycle();
    const auto cpu_started = ClockNow(CLOCK_THREAD_CPUTIME_ID);
    const auto started = ClockNow(CLOCK_MONOTONIC);
    ReadProcessFiles(p_pid, cycle);
    if (ReadMaps(p_pid, cycle.summary_, p_stop))
    {
      cycle.layout_changed_ = CompareLayouts(cycle.summary_);
      if (vma_count_ > current_.size())
      {
        cycle.flags_ = cycle.flags_ | memory_wire::Flags::Truncated;
      }
      std::swap(current_, previous_);
    }
    else
    {
      cycle.flags_ = cycle.flags_ | memory_wire::Flags::MapsUnreadable;
    }
    if (p_detail_start)
    {
      cycle.detail_ =
          scanner_.Scan(p_pid, *p_detail_start, FindEnd(*p_detail_start),
                        page_size_, pacer_, p_stop);
      cycle.summary_[Field("detail_start")] = *p_detail_start;
    }
    pacer_.EndCycle();
    pacer_.Store(cycle.summary_);
    cycle.summary_[Field("cpu_ns")] = static_cast<std::uint64_t>(
        (ClockNow(CLOCK_THREAD_CPUTIME_ID) - cpu_started).count());
    cycle.summary_[Field("cycle_ns")] = static_cast<std::uint64_t>(
        (ClockNow(CLOCK_MONOTONIC) - started).count());
    return cycle;
  }

  // The list of the last cycle that read maps, sorted by start address.
  [[nodiscard]] std::span<const memory_wire::Vma> Vmas() const noexcept
  {
    return previous_;
  }
  [[nodiscard]] std::uint32_t Generation() const noexcept
  {
    return generation_;
  }
  [[nodiscard]] std::span<const memory_wire::Cell> Cells() const noexcept
  {
    return scanner_.Cells();
  }

 private:
  [[nodiscard]] std::optional<std::string_view> ReadSmall(const char* p_path)
  {
    return ReadAtStart(OpenReadonly(p_path), small_buffer_);
  }

  // Tier 0: files that take no mmap_lock.
  void ReadProcessFiles(int p_pid, MemoryCycle& p_cycle)
  {
    using memory_wire::Field;
    auto& summary = p_cycle.summary_;
    if (const auto status =
            ReadSmall(FixedString{"/proc/{}/status", p_pid}.CStr()))
    {
      for (const auto& [key, field] :
           {std::pair{"VmSize", Field("vm_size_bytes")},
            std::pair{"VmPeak", Field("vm_peak_bytes")},
            std::pair{"VmRSS", Field("vm_rss_bytes")},
            std::pair{"VmHWM", Field("vm_hwm_bytes")},
            std::pair{"RssAnon", Field("rss_anon_bytes")},
            std::pair{"RssFile", Field("rss_file_bytes")},
            std::pair{"RssShmem", Field("rss_shmem_bytes")},
            std::pair{"VmSwap", Field("vm_swap_bytes")},
            std::pair{"VmData", Field("vm_data_bytes")},
            std::pair{"VmStk", Field("vm_stack_bytes")},
            std::pair{"VmExe", Field("vm_exe_bytes")},
            std::pair{"VmLib", Field("vm_lib_bytes")},
            std::pair{"VmPTE", Field("vm_pte_bytes")},
            std::pair{"VmLck", Field("vm_locked_bytes")}})
      {
        summary[field] =
            FindKilobytes(*status, key).value_or(memory_wire::kUnavailable);
      }
    }
    else
    {
      p_cycle.flags_ = p_cycle.flags_ | memory_wire::Flags::StatusUnreadable;
    }
    if (const auto text = ReadSmall(FixedString{"/proc/{}/stat", p_pid}.CStr()))
    {
      if (const auto stat = ParseProcessStat(*text))
      {
        summary[Field("minor_faults")] = stat->minor_faults_;
        summary[Field("major_faults")] = stat->major_faults_;
        if (stat->start_stack_ != 0)
        {
          summary[Field("start_stack")] = stat->start_stack_;
        }
      }
    }
    if (const auto limits =
            ReadSmall(FixedString{"/proc/{}/limits", p_pid}.CStr()))
    {
      for (const auto& [row, field] :
           {std::pair{"Max address space", Field("rlimit_as_bytes")},
            std::pair{"Max stack size", Field("rlimit_stack_bytes")},
            std::pair{"Max locked memory", Field("rlimit_memlock_bytes")}})
      {
        summary[field] =
            ParseSoftLimit(*limits, row).value_or(memory_wire::kUnavailable);
      }
    }
    if (const auto text = ReadSmall("/proc/sys/vm/max_map_count"))
    {
      summary[Field("max_map_count")] =
          ParseNumber<std::uint64_t>(Trim(*text))
              .value_or(memory_wire::kUnavailable);
    }
    if (cpu_count_ > 0)
    {
      summary[Field("cpu_count")] = static_cast<std::uint64_t>(cpu_count_);
    }
    summary[Field("page_size_bytes")] = page_size_;
  }

  // Tier 1: reads maps in small reads, so each read holds the target's
  // mmap_lock for a short time. Returns false when the file is unreadable.
  [[nodiscard]] bool ReadMaps(int p_pid, memory_wire::SummaryValues& p_summary,
                              const std::stop_token& p_stop)
  {
    const auto descriptor =
        OpenReadonly(FixedString{"/proc/{}/maps", p_pid}.CStr());
    if (!descriptor)
    {
      return false;
    }
    current_.clear();
    vma_count_ = 0;
    totals_ = {};
    std::size_t pending = 0;  // bytes of an unfinished line at the front
    while (!p_stop.stop_requested())
    {
      const auto length = pacer_.Timed(
          [&]
          {
            return ::read(descriptor.Get(), maps_buffer_.data() + pending,
                          kMapsReadBytes);
          });
      if (length < 0)
      {
        return false;  // ESRCH, EIO: the process exited during the read
      }
      if (length == 0)
      {
        break;
      }
      std::string_view text{maps_buffer_.data(),
                            pending + static_cast<std::size_t>(length)};
      std::size_t newline = 0;
      while ((newline = text.find('\n')) != std::string_view::npos)
      {
        Accept(text.substr(0, newline));
        text.remove_prefix(newline + 1);
      }
      if (text.size() > kLongestLine)
      {
        return false;  // not a maps file
      }
      std::memmove(maps_buffer_.data(), text.data(), text.size());
      pending = text.size();
    }
    std::ranges::sort(current_, {}, &memory_wire::Vma::start_);
    StoreTotals(p_summary);
    return true;
  }

  void Accept(std::string_view p_line)
  {
    const auto line = ParseMapsLine(p_line);
    if (!line)
    {
      return;
    }
    ++vma_count_;
    const auto size = line->end_ - line->start_;
    totals_.mapped_ += size;
    (line->inode_ != 0 ? totals_.file_ : totals_.anonymous_) += size;
    if ((line->permissions_ & std::to_underlying(Permissions::Write)) != 0)
    {
      totals_.writable_ += size;
    }
    if ((line->permissions_ & std::to_underlying(Permissions::Execute)) != 0)
    {
      totals_.executable_ += size;
    }
    const auto vma = ToWireVma(*line);
    if (vma.kind_ == VmaKind::Heap)
    {
      totals_.heap_ = {vma.start_, vma.end_};
    }
    else if (vma.kind_ == VmaKind::Stack)
    {
      totals_.stack_ = {vma.start_, vma.end_};
    }
    Keep(vma);
  }

  // Keeps the max_vmas largest VMAs, in a min-heap while the list is full.
  // The heap and the stack sort as the largest and the kernel's areas next,
  // so a short list still shows where the heap and the stack are.
  void Keep(const memory_wire::Vma& p_vma)
  {
    const auto priority = [](const memory_wire::Vma& p_item)
    {
      constexpr auto kHighest = std::numeric_limits<std::uint64_t>::max();
      if (p_item.kind_ == VmaKind::Heap || p_item.kind_ == VmaKind::Stack)
      {
        return kHighest;
      }
      return p_item.kind_ == VmaKind::Kernel ? kHighest - 1 : p_item.Size();
    };
    const auto larger =
        [&](const memory_wire::Vma& p_left, const memory_wire::Vma& p_right)
    {
      return priority(p_left) > priority(p_right);
    };
    if (current_.size() < max_vmas_)
    {
      current_.push_back(p_vma);
      if (current_.size() == max_vmas_)
      {
        std::ranges::make_heap(current_, larger);
      }
      return;
    }
    if (priority(p_vma) <= priority(current_.front()))
    {
      return;
    }
    std::ranges::pop_heap(current_, larger);
    current_.back() = p_vma;
    std::ranges::push_heap(current_, larger);
  }

  void StoreTotals(memory_wire::SummaryValues& p_summary) const
  {
    using memory_wire::Field;
    p_summary[Field("vma_count")] = vma_count_;
    p_summary[Field("vmas_sent")] = current_.size();
    p_summary[Field("mapped_bytes")] = totals_.mapped_;
    p_summary[Field("anonymous_bytes")] = totals_.anonymous_;
    p_summary[Field("file_bytes")] = totals_.file_;
    p_summary[Field("writable_bytes")] = totals_.writable_;
    p_summary[Field("executable_bytes")] = totals_.executable_;
    if (totals_.heap_)
    {
      p_summary[Field("heap_start")] = totals_.heap_->first;
      p_summary[Field("heap_end")] = totals_.heap_->second;
    }
    if (totals_.stack_)
    {
      p_summary[Field("stack_start")] = totals_.stack_->first;
      p_summary[Field("stack_end")] = totals_.stack_->second;
    }
  }

  // Marks each VMA of current_ as new, moved or unchanged against previous_
  // (both sorted by start) and counts the removed ones. Returns true when
  // the layout changed, which raises the generation.
  [[nodiscard]] bool CompareLayouts(memory_wire::SummaryValues& p_summary)
  {
    using memory_wire::Changes;
    using memory_wire::Field;
    std::uint64_t added = 0;
    std::uint64_t resized = 0;
    matched_.assign(previous_.size(), 0);
    for (auto& vma : current_)
    {
      vma.changes_ = std::to_underlying(Changes::None);
      if (first_cycle_)
      {
        continue;
      }
      const auto by_start = std::ranges::lower_bound(previous_, vma.start_, {},
                                                     &memory_wire::Vma::start_);
      if (by_start != previous_.end() && by_start->start_ == vma.start_)
      {
        matched_[static_cast<std::size_t>(by_start - previous_.begin())] = 1;
        if (by_start->end_ != vma.end_)
        {
          vma.changes_ = std::to_underlying(Changes::EndMoved);
          ++resized;
        }
        else if (by_start->permissions_ != vma.permissions_ ||
                 by_start->inode_ != vma.inode_ ||
                 by_start->offset_ != vma.offset_)
        {
          vma.changes_ = std::to_underlying(Changes::New);
          ++added;
        }
        continue;
      }
      // Ends are sorted too: the VMAs do not overlap.
      const auto by_end = std::ranges::lower_bound(previous_, vma.end_, {},
                                                   &memory_wire::Vma::end_);
      const auto index = static_cast<std::size_t>(by_end - previous_.begin());
      if (by_end != previous_.end() && by_end->end_ == vma.end_ &&
          matched_[index] == 0)
      {
        matched_[index] = 1;
        vma.changes_ = std::to_underlying(Changes::StartMoved);
        ++resized;
        continue;
      }
      vma.changes_ = std::to_underlying(Changes::New);
      ++added;
    }
    const auto removed =
        first_cycle_
            ? std::uint64_t{0}
            : static_cast<std::uint64_t>(std::ranges::count(matched_, 0));
    p_summary[Field("vmas_new")] = added;
    p_summary[Field("vmas_resized")] = resized;
    p_summary[Field("vmas_removed")] = removed;
    const bool changed = first_cycle_ || added + resized + removed > 0;
    first_cycle_ = false;
    if (changed)
    {
      ++generation_;
    }
    return changed;
  }

  // The end of the VMA that starts at p_start, in the current list.
  [[nodiscard]] std::optional<std::uint64_t> FindEnd(
      std::uint64_t p_start) const
  {
    const auto found = std::ranges::lower_bound(previous_, p_start, {},
                                                &memory_wire::Vma::start_);
    if (found == previous_.end() || found->start_ != p_start)
    {
      return std::nullopt;
    }
    return found->end_;
  }

  struct Totals
  {
    std::uint64_t mapped_ = 0;
    std::uint64_t anonymous_ = 0;
    std::uint64_t file_ = 0;
    std::uint64_t writable_ = 0;
    std::uint64_t executable_ = 0;
    std::optional<std::pair<std::uint64_t, std::uint64_t>> heap_;
    std::optional<std::pair<std::uint64_t, std::uint64_t>> stack_;
  };

  std::size_t max_vmas_;
  std::uint64_t page_size_;
  long cpu_count_;
  std::vector<memory_wire::Vma> current_;
  std::vector<memory_wire::Vma> previous_;
  std::vector<std::uint8_t> matched_;
  std::uint64_t vma_count_ = 0;
  Totals totals_;
  std::uint32_t generation_ = 0;
  bool first_cycle_ = true;
  ReadPacer pacer_;
  PageScanner scanner_;
  std::array<char, 1024 * 16> small_buffer_{};
  std::array<char, kMapsReadBytes + kLongestLine> maps_buffer_{};
};

// The target and session that the main thread found, for the memory-map
// thread. A short lock: the main thread writes once per tick and the memory
// thread reads once per cycle.
class MemoryMapTarget
{
 public:
  struct View
  {
    std::uint64_t session_ = 0;
    std::optional<TargetIdentity> target_;
  };

  void Publish(std::uint64_t p_session,
               const std::optional<TargetIdentity>& p_target)
  {
    const std::scoped_lock lock{mutex_};
    view_ = {p_session, p_target};
  }
  [[nodiscard]] View Read()
  {
    const std::scoped_lock lock{mutex_};
    return view_;
  }

 private:
  std::mutex mutex_;
  View view_;
};

struct MemoryMapOptions
{
  std::chrono::seconds interval_{2};
  std::chrono::seconds keyframe_{30};
  std::size_t max_vmas_ = 8192;
  std::chrono::seconds max_lease_{15};
  SocketAddress listen_;
  SocketAddress collector_;
  std::vector<std::uint8_t> token_;
};

[[nodiscard]] inline MemoryMapOptions MemoryMapOptionsFrom(
    const RuntimeConfig& p_config)
{
  assert(p_config.memory_map_.has_value());
  const auto& settings = p_config.settings_;
  return MemoryMapOptions{
      .interval_ = std::chrono::seconds{settings.memory_map_interval_s_},
      .keyframe_ = std::chrono::seconds{settings.memory_map_keyframe_s_},
      .max_vmas_ = static_cast<std::size_t>(settings.memory_map_max_vmas_),
      .max_lease_ = std::chrono::seconds{settings.memory_map_max_lease_s_},
      .listen_ = p_config.memory_map_->listen_,
      .collector_ = {p_config.endpoint_.address_,
                     p_config.endpoint_.address_length_},
      .token_ = p_config.memory_map_->token_};
}

// True when p_peer has the host address of p_expected; the port may differ.
[[nodiscard]] inline bool SameHost(const sockaddr_storage& p_peer,
                                   const SocketAddress& p_expected)
{
  if (p_peer.ss_family != p_expected.Family())
  {
    return false;
  }
  if (p_peer.ss_family == AF_INET)
  {
    return reinterpret_cast<const sockaddr_in&>(p_peer).sin_addr.s_addr ==
           reinterpret_cast<const sockaddr_in&>(p_expected.address_)
               .sin_addr.s_addr;
  }
  return std::memcmp(&reinterpret_cast<const sockaddr_in6&>(p_peer).sin6_addr,
                     &reinterpret_cast<const sockaddr_in6&>(p_expected.address_)
                          .sin6_addr,
                     sizeof(in6_addr)) == 0;
}

// The thread: the control socket, the lease and the cycles. Make it with
// Start(); the destructor stops and joins the thread.
class MemoryMapper final
{
 public:
  // At most this many requests are checked each second. A flood of forged
  // requests costs at most this many HMAC computations.
  static constexpr int kRequestsPerSecond = 8;
  static constexpr std::size_t kDatagramsPerWake = 64;
  // A pause after this many datagrams, so a long layout does not overflow
  // the collector's receive buffer.
  static constexpr std::size_t kBurstDatagrams = 32;

  [[nodiscard]] static std::expected<std::unique_ptr<MemoryMapper>, std::string>
  Start(MemoryMapOptions p_options, MemoryMapTarget& p_target)
  {
    FileDescriptor control{::socket(p_options.listen_.Family(),
                                    SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC,
                                    0)};
    if (!control || ::bind(control.Get(), p_options.listen_.Get(),
                           p_options.listen_.length_) != 0)
    {
      return std::unexpected(std::format(
          "memory_map_listen: {}", std::generic_category().message(errno)));
    }
    FileDescriptor wake{::eventfd(0, EFD_CLOEXEC | EFD_NONBLOCK)};
    // Blocking, unlike the main socket: this thread may wait for buffer
    // space, and a dropped part would make the collector's list stale.
    FileDescriptor sender{
        ::socket(p_options.collector_.Family(), SOCK_DGRAM | SOCK_CLOEXEC, 0)};
    if (!wake || !sender)
    {
      return std::unexpected(std::format(
          "memory map: {}", std::generic_category().message(errno)));
    }
    const timeval timeout{0, 100'000};
    ::setsockopt(sender.Get(), SOL_SOCKET, SO_SNDTIMEO, &timeout,
                 sizeof(timeout));
    auto mapper = std::unique_ptr<MemoryMapper>(
        new MemoryMapper(std::move(p_options), p_target, std::move(control),
                         std::move(wake), std::move(sender)));
    // Block every signal in the new thread, so SIGHUP, SIGINT and SIGTERM
    // go to the main thread and wake it from clock_nanosleep at once.
    sigset_t all{};
    sigset_t previous{};
    ::sigfillset(&all);
    ::pthread_sigmask(SIG_BLOCK, &all, &previous);
    std::expected<void, std::string> started;
    try
    {
      mapper->thread_ = std::jthread(
          [raw = mapper.get()](std::stop_token p_stop)
          {
            raw->Run(p_stop);
          });
    }
    catch (const std::system_error& error)
    {
      started = std::unexpected(
          std::format("cannot start the memory-map thread: {}", error.what()));
    }
    ::pthread_sigmask(SIG_SETMASK, &previous, nullptr);
    if (!started)
    {
      return std::unexpected(std::move(started.error()));
    }
    return mapper;
  }

  ~MemoryMapper()
  {
    thread_.request_stop();
    const std::uint64_t one = 1;
    [[maybe_unused]] const auto written =
        ::write(wake_.Get(), &one, sizeof(one));
    if (thread_.joinable())
    {
      thread_.join();
    }
  }
  MemoryMapper(const MemoryMapper&) = delete;
  MemoryMapper& operator=(const MemoryMapper&) = delete;
  MemoryMapper(MemoryMapper&&) = delete;
  MemoryMapper& operator=(MemoryMapper&&) = delete;

 private:
  MemoryMapper(MemoryMapOptions p_options, MemoryMapTarget& p_target,
               FileDescriptor p_control, FileDescriptor p_wake,
               FileDescriptor p_sender)
      : options_(std::move(p_options)),
        target_(p_target),
        control_(std::move(p_control)),
        wake_(std::move(p_wake)),
        sender_(std::move(p_sender)),
        reader_(options_.max_vmas_)
  {
  }

  [[nodiscard]] bool Active(Nanoseconds p_now) const noexcept
  {
    return p_now < lease_until_;
  }

  void Run(const std::stop_token& p_stop)
  {
    while (!p_stop.stop_requested())
    {
      auto now = ClockNow(CLOCK_MONOTONIC);
      int timeout_ms = -1;  // no lease: block until a request arrives
      if (Active(now))
      {
        timeout_ms = static_cast<int>(std::max<std::int64_t>(
            0, std::chrono::ceil<std::chrono::milliseconds>(next_cycle_ - now)
                   .count()));
      }
      std::array<pollfd, 2> ready{pollfd{control_.Get(), POLLIN, 0},
                                  pollfd{wake_.Get(), POLLIN, 0}};
      if (::poll(ready.data(), ready.size(), timeout_ms) < 0 && errno != EINTR)
      {
        logger_.Warn("memory map: poll failed: {}",
                     std::generic_category().message(errno));
        return;
      }
      if (p_stop.stop_requested() || (ready[1].revents & POLLIN) != 0)
      {
        return;
      }
      now = ClockNow(CLOCK_MONOTONIC);
      if ((ready[0].revents & POLLIN) != 0)
      {
        HandleRequests(now);
      }
      if (Active(now) && now >= next_cycle_)
      {
        Cycle(now, p_stop);
        next_cycle_ += options_.interval_;
        if (next_cycle_ <= now)
        {
          next_cycle_ = now + options_.interval_;
        }
      }
    }
  }

  void HandleRequests(Nanoseconds p_now)
  {
    // Refill the request budget: kRequestsPerSecond per second, at most
    // one second's worth saved.
    const auto refill = (p_now - budget_time_) * kRequestsPerSecond / 1s;
    if (refill > 0)
    {
      budget_ = static_cast<int>(
          std::min<std::int64_t>(kRequestsPerSecond, budget_ + refill));
      budget_time_ = p_now;
    }
    for (std::size_t count = 0; count < kDatagramsPerWake; ++count)
    {
      std::array<std::byte, memory_wire::kRequestSize + 1> datagram{};
      sockaddr_storage peer{};
      socklen_t peer_length = sizeof(peer);
      const auto length = ::recvfrom(
          control_.Get(), datagram.data(), datagram.size(), MSG_DONTWAIT,
          reinterpret_cast<sockaddr*>(&peer), &peer_length);
      if (length < 0)
      {
        return;  // EAGAIN: nothing more
      }
      if (budget_ == 0)
      {
        continue;  // over the rate: drop unread
      }
      --budget_;
      if (!SameHost(peer, options_.collector_))
      {
        logger_.Warn(
            "memory map: request from a host that is not the "
            "collector ignored");
        continue;
      }
      const auto request = memory_wire::DecodeRequest(
          std::span{datagram}.first(static_cast<std::size_t>(length)),
          options_.token_);
      if (!request)
      {
        logger_.Warn("memory map: request ignored: {}", request.error());
        continue;
      }
      if (request->counter_ <= last_counter_)
      {
        logger_.Warn("memory map: old or repeated request ignored");
        continue;
      }
      last_counter_ = request->counter_;
      Apply(*request, p_now);
    }
  }

  void Apply(const memory_wire::Request& p_request, Nanoseconds p_now)
  {
    if (p_request.action_ == memory_wire::Action::Stop)
    {
      lease_until_ = Nanoseconds{0};
      return;
    }
    if (!Active(p_now))
    {
      // A new watch: start at once, with a fresh list and a full layout.
      reader_.Reset();
      force_layout_ = true;
      next_cycle_ = p_now;
    }
    const auto lease =
        std::min(std::chrono::seconds{p_request.lease_s_}, options_.max_lease_);
    lease_until_ = p_now + lease;
    if (p_request.tier_ == memory_wire::Tier::Detail)
    {
      if (detail_start_ != p_request.vma_start_)
      {
        // A new selection is read at once, not at the next interval.
        next_cycle_ = p_now;
      }
      detail_start_ = p_request.vma_start_;
    }
    else
    {
      detail_start_.reset();
    }
  }

  void Cycle(Nanoseconds p_now, const std::stop_token& p_stop)
  {
    using memory_wire::Field;
    const auto view = target_.Read();
    memory_wire::Header header{
        .sequence_ = sequence_++,
        .session_ = view.session_,
        .monotonic_ns_ = static_cast<std::uint64_t>(p_now.count()),
        .wall_ns_ =
            static_cast<std::uint64_t>(ClockNow(CLOCK_REALTIME).count()),
        .interval_ms_ = static_cast<std::uint32_t>(
            std::chrono::milliseconds{options_.interval_}.count()),
    };
    if (!view.target_)
    {
      header.flags_ = memory_wire::Flags::TargetAbsent;
      header.parts_ = 1;
      header.generation_ = reader_.Generation();
      Send(memory_wire::EncodeSummary(buffer_, header,
                                      memory_wire::EmptySummary()));
      return;
    }
    if (view.target_ != last_target_)
    {
      // Another process: nothing of the old list applies.
      reader_.Reset();
      force_layout_ = true;
      last_target_ = view.target_;
    }
    header.pid_ = static_cast<std::uint32_t>(view.target_->pid_);
    header.process_start_ = view.target_->starttime_;
    auto cycle = reader_.Read(view.target_->pid_, detail_start_, p_stop);
    cycle.summary_[Field("lease_remaining_ms")] = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(lease_until_ -
                                                              p_now)
            .count());
    const bool layout = !memory_wire::HasFlag(
                            cycle.flags_, memory_wire::Flags::MapsUnreadable) &&
                        !reader_.Vmas().empty() &&
                        (cycle.layout_changed_ || force_layout_ ||
                         p_now - last_layout_ >= options_.keyframe_);
    const auto vmas = reader_.Vmas();
    const auto cells = reader_.Cells();
    header.generation_ = reader_.Generation();
    header.flags_ = cycle.flags_;
    header.layout_parts_ = static_cast<std::uint16_t>(
        layout ? memory_wire::LayoutParts(vmas.size()) : 0);
    const auto detail_parts =
        cycle.detail_ ? memory_wire::DetailParts(cells.size()) : 0;
    header.parts_ =
        static_cast<std::uint16_t>(1 + header.layout_parts_ + detail_parts);
    send_failed_ = false;
    Send(memory_wire::EncodeSummary(buffer_, header, cycle.summary_));
    for (std::size_t part = 0; part < header.layout_parts_; ++part)
    {
      Send(memory_wire::EncodeVmas(buffer_, header, vmas, part));
    }
    for (std::size_t part = 0; part < detail_parts; ++part)
    {
      Send(memory_wire::EncodeDetail(buffer_, header, *cycle.detail_, cells,
                                     part));
    }
    if (layout)
    {
      last_layout_ = p_now;
      // A lost local send would leave the collector's list stale until
      // the next keyframe; send the list again next cycle instead.
      force_layout_ = send_failed_;
    }
  }

  void Send(std::size_t p_length)
  {
    if (++sent_in_burst_ == kBurstDatagrams)
    {
      sent_in_burst_ = 0;
      const timespec pause{.tv_sec = 0, .tv_nsec = 1'000'000};
      ::nanosleep(&pause, nullptr);
    }
    if (::sendto(sender_.Get(), buffer_.data(), p_length, 0,
                 options_.collector_.Get(), options_.collector_.length_) < 0)
    {
      send_failed_ = true;
      logger_.Warn("memory map: UDP send failed: {}",
                   std::generic_category().message(errno));
    }
  }

  MemoryMapOptions options_;
  MemoryMapTarget& target_;
  FileDescriptor control_;
  FileDescriptor wake_;
  FileDescriptor sender_;
  MemoryMapReader reader_;
  RateLimitedLogger logger_;
  std::array<std::byte, memory_wire::kMaxPartSize> buffer_{};
  Nanoseconds lease_until_{0};
  Nanoseconds next_cycle_{0};
  Nanoseconds last_layout_{0};
  Nanoseconds budget_time_{0};
  int budget_ = kRequestsPerSecond;
  std::uint64_t last_counter_ = 0;
  std::optional<std::uint64_t> detail_start_;
  std::optional<TargetIdentity> last_target_;
  std::uint32_t sequence_ = 0;
  std::size_t sent_in_burst_ = 0;
  bool force_layout_ = true;
  bool send_failed_ = false;
  // Last, so the thread is the first member destroyed and stops before the
  // members it uses. The destructor joins it anyway.
  std::jthread thread_;
};

}  // namespace triangulator
