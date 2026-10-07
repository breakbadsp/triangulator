#pragma once

// The collector's part of the memory map (docs/process-memory-map-design.md,
// section 8). It does not interpret the data:
//
// - MemoryMapMonitor reassembles the sampler's TVMA datagrams, keeps the
//   latest summary, VMA list and detail, writes them as JSON for the
//   dashboard, and says when to store a summary row or a snapshot. Like
//   Monitor, it does no I/O, and its datagram path allocates nothing: the
//   buffers for the largest list are reserved when it is made, which is
//   only when [memory_map] enabled = true.
// - MemoryMapControl signs and sends the requests to the sampler. The HTTP
//   thread uses it; a request is one non-blocking sendto, so it cannot delay
//   anything.

#include <arpa/inet.h>
#include <sys/socket.h>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <expected>
#include <format>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "../common/fd.hpp"
#include "../common/memory_wire.hpp"
#include "json.hpp"
#include "text.hpp"

namespace triangulator::collector
{

using memory_wire::kUnavailable;

// Summary fields that hold addresses. JSON numbers lose precision above
// 2^53, so addresses are written as hex text.
[[nodiscard]] inline bool IsAddressField(std::string_view p_name)
{
  return p_name.ends_with("_start") || p_name.ends_with("_end");
}

inline void AppendHex(std::string& p_out, std::uint64_t p_value)
{
  std::format_to(std::back_inserter(p_out), "\"{:x}\"", p_value);
}

[[nodiscard]] inline std::string_view VmaKindName(memory_wire::VmaKind p_kind)
{
  constexpr std::array<std::string_view, 8> kNames{
      "?", "anonymous", "file", "heap", "stack", "kernel", "named", "other"};
  const auto index = std::to_underlying(p_kind);
  return index < kNames.size() ? kNames[index] : "?";
}

// "rw-p", as in /proc/PID/maps.
[[nodiscard]] inline std::array<char, 4> PermissionText(std::uint8_t p_bits)
{
  return {(p_bits & 1) != 0 ? 'r' : '-', (p_bits & 2) != 0 ? 'w' : '-',
          (p_bits & 4) != 0 ? 'x' : '-', (p_bits & 8) != 0 ? 's' : 'p'};
}

// The VMA list as a JSON array of rows, in the order of kVmaColumns. The
// dashboard and the stored snapshots use the same text.
inline constexpr std::string_view kVmaColumns =
    R"(["start","end","size","offset","inode","device","permissions","kind","changes","flags","name"])";

inline void AppendVmaRows(std::string& p_out,
                          std::span<const memory_wire::Vma> p_vmas)
{
  p_out += '[';
  for (std::size_t index = 0; index < p_vmas.size(); ++index)
  {
    const auto& vma = p_vmas[index];
    if (index > 0)
    {
      p_out += ',';
    }
    p_out += '[';
    AppendHex(p_out, vma.start_);
    p_out += ',';
    AppendHex(p_out, vma.end_);
    const auto permissions = PermissionText(vma.permissions_);
    std::format_to(std::back_inserter(p_out),
                   ",{},{},{},\"{:x}:{:x}\",\"{}\",\"{}\",{},{},", vma.Size(),
                   vma.offset_, vma.inode_, vma.device_major_,
                   vma.device_minor_,
                   std::string_view{permissions.data(), permissions.size()},
                   VmaKindName(vma.kind_), vma.changes_, vma.flags_);
    DumpString(vma.Name(), p_out);
    p_out += ']';
  }
  p_out += ']';
}

// A summary to store in vm_summary.
struct MemorySummaryRow
{
  double ts_{};
  FixedText<24> session_;
  std::uint32_t pid_{};
  std::uint32_t generation_{};
  std::uint16_t flags_{};
  memory_wire::SummaryValues values_{};
};

// A VMA list to store in vm_snapshot. rows_ is the JSON of AppendVmaRows.
struct MemorySnapshotRow
{
  double ts_{};
  std::string session_;
  std::uint32_t pid_{};
  std::uint32_t generation_{};
  std::uint64_t vma_count_{};
  bool truncated_ = false;
  std::string rows_;
};

class MemoryMapMonitor
{
 public:
  // A vm_summary row at most this often while a watch lasts.
  static constexpr double kSummaryRowSeconds = 60;
  // A stored VMA list: the first complete list of each watch, then at most
  // one this often.
  static constexpr double kSnapshotSeconds = 3600;
  // No summary for this long ends a watch.
  static constexpr double kWatchGapSeconds = 60;

  // Room for every slot of the largest list: the last part may be short,
  // but its slots start at (part - 1) * kVmasPerPart.
  static constexpr std::size_t kSlots =
      memory_wire::kMaxLayoutParts * memory_wire::kVmasPerPart;

  MemoryMapMonitor()
      : layout_(kSlots),
        assembling_(kSlots),
        received_(memory_wire::kMaxLayoutParts)
  {
  }

  std::int64_t bad_parts_ = 0;

  void Accept(const memory_wire::Part& p_part, double p_now)
  {
    const auto& header = p_part.header_;
    if (summary_ && header.session_ == summary_->header_.session_ &&
        Older(header.sequence_, summary_->header_.sequence_))
    {
      ++late_parts_;
      return;
    }
    switch (header.kind_)
    {
      case memory_wire::PartKind::Summary:
        AcceptSummary(p_part, p_now);
        break;
      case memory_wire::PartKind::Vmas:
        AcceptVmas(p_part, p_now);
        break;
      case memory_wire::PartKind::Detail:
        AcceptDetail(p_part, p_now);
        break;
    }
    ++version_;
  }

  // Changes when the data does; the main loop rebuilds the JSON only then.
  [[nodiscard]] std::uint64_t Version() const noexcept
  {
    return version_;
  }

  // The dashboard's view. p_now decides live or stale.
  [[nodiscard]] std::string Json(double p_now) const
  {
    std::string out;
    out.reserve(256 + layout_count_ * 120);
    out += R"({"enabled":true,"state":")";
    out += State(p_now);
    std::format_to(std::back_inserter(out),
                   R"(","now":{},"incomplete_layouts":{},"late_parts":{},)"
                   R"("bad_parts":{},"summary":)",
                   p_now, incomplete_layouts_, late_parts_, bad_parts_);
    AppendSummary(out);
    out += R"(,"layout":)";
    AppendLayout(out);
    out += R"(,"detail":)";
    AppendDetail(out);
    out += '}';
    return out;
  }

  // A row for vm_summary, once per kSummaryRowSeconds while summaries
  // arrive.
  [[nodiscard]] std::optional<MemorySummaryRow> TakeSummaryRow()
  {
    if (!summary_ || summary_stored_ ||
        summary_->received_ - last_summary_row_ < kSummaryRowSeconds)
    {
      return std::nullopt;
    }
    summary_stored_ = true;
    last_summary_row_ = summary_->received_;
    MemorySummaryRow row{.ts_ = summary_->received_,
                         .session_ = {},
                         .pid_ = summary_->header_.pid_,
                         .generation_ = summary_->header_.generation_,
                         .flags_ = std::to_underlying(summary_->header_.flags_),
                         .values_ = summary_->values_};
    AppendUnsigned(row.session_, summary_->header_.session_);
    return row;
  }

  // A row for vm_snapshot: the first complete list of a watch, and then
  // one each kSnapshotSeconds.
  [[nodiscard]] std::optional<MemorySnapshotRow> TakeSnapshot()
  {
    if (!snapshot_due_)
    {
      return std::nullopt;
    }
    snapshot_due_ = false;
    last_snapshot_ = layout_received_;
    MemorySnapshotRow row{
        .ts_ = layout_received_,
        .session_ = std::to_string(layout_header_.session_),
        .pid_ = layout_header_.pid_,
        .generation_ = layout_header_.generation_,
        .vma_count_ = layout_vma_count_,
        .truncated_ = memory_wire::HasFlag(layout_header_.flags_,
                                           memory_wire::Flags::Truncated),
        .rows_ = {}};
    AppendVmaRows(row.rows_, std::span{layout_}.first(layout_count_));
    return row;
  }

 private:
  struct Summary
  {
    memory_wire::Header header_;
    memory_wire::SummaryValues values_{};
    double received_{};
  };

  // Sequence numbers wrap; a part is older when it is less than half the
  // range behind.
  [[nodiscard]] static bool Older(std::uint32_t p_sequence,
                                  std::uint32_t p_latest) noexcept
  {
    return p_sequence != p_latest &&
           static_cast<std::uint32_t>(p_latest - p_sequence) < 0x8000'0000U;
  }

  void AcceptSummary(const memory_wire::Part& p_part, double p_now)
  {
    const bool new_watch =
        !summary_ || summary_->header_.session_ != p_part.header_.session_ ||
        p_now - summary_->received_ > kWatchGapSeconds;
    if (new_watch)
    {
      snapshot_this_watch_ = false;
    }
    summary_ = Summary{p_part.header_, p_part.values_, p_now};
    summary_stored_ = false;
    if (p_part.header_.parts_ == 1 + p_part.header_.layout_parts_)
    {
      // No detail in this cycle: the selection ended.
      detail_received_ = 0;
    }
  }

  void AcceptVmas(const memory_wire::Part& p_part, double p_now)
  {
    const auto& header = p_part.header_;
    if (!assembling_header_ ||
        assembling_header_->session_ != header.session_ ||
        assembling_header_->sequence_ != header.sequence_)
    {
      if (assembling_header_ && received_count_ > 0)
      {
        ++incomplete_layouts_;  // the previous list lost a part
      }
      assembling_header_ = header;
      received_count_ = 0;
      assembling_count_ = 0;
      std::fill_n(received_.begin(), header.layout_parts_, 0);
    }
    else if (!assembling_header_->SameCycle(header))
    {
      ++bad_parts_;
      return;
    }
    const auto index = static_cast<std::size_t>(header.part_ - 1);
    if (received_[index] != 0)
    {
      return;  // a duplicate
    }
    received_[index] = 1;
    ++received_count_;
    const auto vmas = p_part.Vmas();
    std::ranges::copy(
        vmas, assembling_.begin() + static_cast<std::ptrdiff_t>(
                                        index * memory_wire::kVmasPerPart));
    assembling_count_ = std::max(
        assembling_count_, index * memory_wire::kVmasPerPart + vmas.size());
    if (received_count_ < header.layout_parts_)
    {
      return;
    }
    std::swap(layout_, assembling_);
    layout_count_ = assembling_count_;
    layout_header_ = header;
    layout_received_ = p_now;
    layout_vma_count_ =
        summary_ && summary_->header_.sequence_ == header.sequence_
            ? summary_->values_[memory_wire::Field("vma_count")]
            : layout_count_;
    assembling_header_.reset();
    received_count_ = 0;
    if (!snapshot_this_watch_ || p_now - last_snapshot_ >= kSnapshotSeconds)
    {
      snapshot_due_ = true;
      snapshot_this_watch_ = true;
    }
  }

  void AcceptDetail(const memory_wire::Part& p_part, double p_now)
  {
    const auto& detail = p_part.detail_;
    const auto cells = p_part.Cells();
    std::ranges::copy(cells, cells_.begin() + detail.first_cell_);
    detail_ = detail;
    detail_header_ = p_part.header_;
    detail_received_ = p_now;
  }

  [[nodiscard]] std::string_view State(double p_now) const
  {
    if (!summary_)
    {
      return "waiting";
    }
    const double interval = summary_->header_.interval_ms_ / 1000.0;
    return p_now - summary_->received_ <= 3 * interval + 1 ? "live" : "stale";
  }

  void AppendSummary(std::string& p_out) const
  {
    if (!summary_)
    {
      p_out += "null";
      return;
    }
    const auto& header = summary_->header_;
    std::format_to(
        std::back_inserter(p_out),
        R"({{"received_at":{},"session":"{}","sequence":{},"pid":{},)"
        R"("process_start":{},"generation":{},"interval_s":{},"wall":{},)"
        R"("truncated":{},"target_absent":{},"maps_unreadable":{},)"
        R"("status_unreadable":{},"values":{{)",
        summary_->received_, header.session_, header.sequence_, header.pid_,
        header.process_start_, header.generation_, header.interval_ms_ / 1000.0,
        static_cast<double>(header.wall_ns_) / 1e9,
        memory_wire::HasFlag(header.flags_, memory_wire::Flags::Truncated),
        memory_wire::HasFlag(header.flags_, memory_wire::Flags::TargetAbsent),
        memory_wire::HasFlag(header.flags_, memory_wire::Flags::MapsUnreadable),
        memory_wire::HasFlag(header.flags_,
                             memory_wire::Flags::StatusUnreadable));
    for (std::size_t index = 0; index < memory_wire::kSummaryFields.size();
         ++index)
    {
      const auto name = memory_wire::kSummaryFields[index];
      const auto value = summary_->values_[index];
      std::format_to(std::back_inserter(p_out), "{}\"{}\":", index ? "," : "",
                     name);
      if (value == kUnavailable)
      {
        p_out += "null";
      }
      else if (IsAddressField(name) || name == "start_stack")
      {
        AppendHex(p_out, value);
      }
      else
      {
        std::format_to(std::back_inserter(p_out), "{}", value);
      }
    }
    p_out += "}}";
  }

  void AppendLayout(std::string& p_out) const
  {
    if (layout_received_ == 0)
    {
      p_out += "null";
      return;
    }
    std::format_to(std::back_inserter(p_out),
                   R"({{"received_at":{},"session":"{}","sequence":{},)"
                   R"("generation":{},"pid":{},"truncated":{},"vma_count":{},)"
                   R"("columns":{},"rows":)",
                   layout_received_, layout_header_.session_,
                   layout_header_.sequence_, layout_header_.generation_,
                   layout_header_.pid_,
                   memory_wire::HasFlag(layout_header_.flags_,
                                        memory_wire::Flags::Truncated),
                   layout_vma_count_, kVmaColumns);
    AppendVmaRows(p_out, std::span{layout_}.first(layout_count_));
    p_out += '}';
  }

  void AppendDetail(std::string& p_out) const
  {
    if (detail_received_ == 0)
    {
      p_out += "null";
      return;
    }
    constexpr std::array<std::string_view, 5> kStatus{
        "?", "measuring", "complete", "not_found", "unreadable"};
    const auto status = std::to_underlying(detail_.status_);
    std::format_to(
        std::back_inserter(p_out),
        R"({{"received_at":{},"sequence":{},"vma_start":"{:x}",)"
        R"("vma_end":"{:x}","pages_per_cell":{},"measured_pages":{},)"
        R"("resident_pages":{},"swapped_pages":{},"shared_pages":{},)"
        R"("scan_ns":{},"status":"{}","cells":[)",
        detail_received_, detail_header_.sequence_, detail_.vma_start_,
        detail_.vma_end_, detail_.pages_per_cell_, detail_.measured_pages_,
        detail_.resident_pages_, detail_.swapped_pages_, detail_.shared_pages_,
        detail_.scan_ns_, status < kStatus.size() ? kStatus[status] : "?");
    for (std::size_t cell = 0; cell < detail_.cell_count_; ++cell)
    {
      const auto& value = cells_[cell];
      if (value == memory_wire::kUnmeasuredCell)
      {
        std::format_to(std::back_inserter(p_out), "{}null", cell ? "," : "");
      }
      else
      {
        std::format_to(std::back_inserter(p_out), "{}[{},{},{}]",
                       cell ? "," : "", value.resident_, value.swapped_,
                       value.shared_);
      }
    }
    p_out += "]}";
  }

  std::uint64_t version_ = 0;
  std::int64_t late_parts_ = 0;
  std::int64_t incomplete_layouts_ = 0;
  std::optional<Summary> summary_;
  bool summary_stored_ = true;
  double last_summary_row_ = -kSummaryRowSeconds;
  // The latest complete list.
  std::vector<memory_wire::Vma> layout_;
  std::size_t layout_count_ = 0;
  std::uint64_t layout_vma_count_ = 0;
  memory_wire::Header layout_header_{};
  double layout_received_ = 0;
  // The list being reassembled.
  std::vector<memory_wire::Vma> assembling_;
  std::vector<std::uint8_t> received_;
  std::optional<memory_wire::Header> assembling_header_;
  std::size_t received_count_ = 0;
  std::size_t assembling_count_ = 0;
  bool snapshot_due_ = false;
  bool snapshot_this_watch_ = false;
  double last_snapshot_ = 0;
  // The latest detail. Its parts are small and arrive together; each part
  // writes its slice of the cells.
  memory_wire::Detail detail_{};
  memory_wire::Header detail_header_{};
  double detail_received_ = 0;
  std::array<memory_wire::Cell, memory_wire::kMaxCells> cells_{};
};

// Sends signed requests to the sampler's control socket.
class MemoryMapControl
{
 public:
  // The lease of each request. The sampler shortens it to its
  // memory_map_max_lease_s. The dashboard renews it every 5 s.
  static constexpr std::uint32_t kLeaseSeconds = 15;
  // At most one request this often, whatever the dashboard does.
  static constexpr auto kMinimumGap = std::chrono::milliseconds{250};

  [[nodiscard]] static std::expected<MemoryMapControl, std::string> Create(
      const sockaddr_storage& p_address, socklen_t p_length,
      std::vector<std::uint8_t> p_token)
  {
    FileDescriptor socket{::socket(
        p_address.ss_family, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0)};
    if (!socket)
    {
      return std::unexpected(std::format(
          "memory map socket: {}", std::generic_category().message(errno)));
    }
    return MemoryMapControl{std::move(socket), p_address, p_length,
                            std::move(p_token)};
  }

  // Sends a watch for the layout, or for the detail of the VMA at
  // p_vma_start. Returns an error text when the request was not sent.
  [[nodiscard]] std::expected<void, std::string> Watch(
      std::optional<std::uint64_t> p_vma_start)
  {
    return Send(memory_wire::Request{.action_ = memory_wire::Action::Watch,
                                     .tier_ = p_vma_start
                                                  ? memory_wire::Tier::Detail
                                                  : memory_wire::Tier::Layout,
                                     .lease_s_ = kLeaseSeconds,
                                     .vma_start_ = p_vma_start.value_or(0)});
  }

 private:
  MemoryMapControl(FileDescriptor p_socket, const sockaddr_storage& p_address,
                   socklen_t p_length, std::vector<std::uint8_t> p_token)
      : socket_(std::move(p_socket)),
        address_(p_address),
        length_(p_length),
        token_(std::move(p_token))
  {
  }

  [[nodiscard]] std::expected<void, std::string> Send(
      memory_wire::Request p_request)
  {
    const auto now = std::chrono::steady_clock::now();
    if (now - last_sent_ < kMinimumGap)
    {
      return std::unexpected("requests are too frequent");
    }
    // The counter is the wall clock, so it keeps rising across collector
    // restarts. It must also rise when the clock does not move.
    const auto wall = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::system_clock::now().time_since_epoch())
            .count());
    counter_ = std::max(wall, counter_ + 1);
    p_request.counter_ = counter_;
    const auto request = memory_wire::Sign(p_request, token_);
    if (::sendto(socket_.Get(), &request, sizeof(request), MSG_DONTWAIT,
                 reinterpret_cast<const sockaddr*>(&address_), length_) < 0)
    {
      return std::unexpected(
          std::format("cannot send to the sampler: {}",
                      std::generic_category().message(errno)));
    }
    last_sent_ = now;
    return {};
  }

  FileDescriptor socket_;
  sockaddr_storage address_{};
  socklen_t length_{};
  std::vector<std::uint8_t> token_;
  std::uint64_t counter_ = 0;
  std::chrono::steady_clock::time_point last_sent_{};
};

// What the HTTP thread shares with the main loop: the latest JSON (written
// by the main loop) and the request sender (used by the HTTP thread only).
class MemoryMapShared
{
 public:
  explicit MemoryMapShared(MemoryMapControl p_control)
      : control_(std::move(p_control))
  {
  }

  void SetJson(std::shared_ptr<const std::string> p_json)
  {
    const std::scoped_lock lock{mutex_};
    json_ = std::move(p_json);
  }
  [[nodiscard]] std::shared_ptr<const std::string> Json()
  {
    const std::scoped_lock lock{mutex_};
    return json_;
  }
  [[nodiscard]] MemoryMapControl& Control() noexcept
  {
    return control_;
  }

 private:
  std::mutex mutex_;
  std::shared_ptr<const std::string> json_ = std::make_shared<
      const std::string>(
      R"({"enabled":true,"state":"waiting","summary":null,"layout":null,"detail":null})");
  MemoryMapControl control_;
};

}  // namespace triangulator::collector
