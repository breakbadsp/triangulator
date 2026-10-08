#pragma once

// Memory-map samples ("TVMA", common/memory_wire.hpp): the latest summary for
// /api/live, and the latest complete layout for /api/memory-map. A sample
// carries layout regions only when the layout changed or for a periodic
// refresh, so the layout and the summary can come from different samples.
// The layout is published only when all of its parts arrived; a sample with
// a lost part leaves the previous layout in place. Layouts are ordered by
// their own sample sequence, apart from the summaries, so a late part never
// replaces a newer layout. A new sampler session drops the old layout.

#include <array>
#include <bitset>
#include <cstddef>
#include <cstdint>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>

#include "../common/memory_wire.hpp"
#include "bounded.hpp"
#include "json.hpp"

namespace triangulator::collector
{

[[nodiscard]] inline std::string_view RegionKindName(
    memory_wire::RegionKind p_kind)
{
  using memory_wire::RegionKind;
  switch (p_kind)
  {
    case RegionKind::Anonymous:
      return "anonymous";
    case RegionKind::File:
      return "file";
    case RegionKind::Heap:
      return "heap";
    case RegionKind::Stack:
      return "stack";
    case RegionKind::Kernel:
      return "kernel";
  }
  return "unknown";
}

// Permissions as in /proc/PID/maps, such as "r-xp".
[[nodiscard]] inline std::string PermissionText(std::uint8_t p_permissions)
{
  using memory_wire::Permission;
  const auto has = [p_permissions](Permission p_bit)
  {
    return (p_permissions & std::to_underlying(p_bit)) != 0;
  };
  return {has(Permission::Read) ? 'r' : '-', has(Permission::Write) ? 'w' : '-',
          has(Permission::Execute) ? 'x' : '-',
          has(Permission::Shared) ? 's' : 'p'};
}

class MemoryMonitor
{
 public:
  static constexpr std::size_t kMaxRetiredSessions = 128;

  std::int64_t bad_parts_ = 0;

  // Memory is fixed at construction: Accept() allocates nothing.
  // Snapshot() and Layout() build JSON and do allocate.
  void Accept(const memory_wire::Part& p_part, double p_received)
  {
    const auto& header = p_part.header_;
    if (!session_ || header.session_ != *session_)
    {
      if (IsRetired(header.session_))
      {
        ++late_;
        return;
      }
      StartSession(header.session_);
    }
    if (header.kind_ == memory_wire::PartKind::Summary)
    {
      if (latest_ && header.sequence_ <= latest_->header_.sequence_)
      {
        ++late_;
        return;
      }
      latest_ = Summary{header, p_part.values_, p_received};
      ++samples_;
    }
    if (header.parts_ > 1)
    {
      AcceptLayoutPart(p_part, p_received);
    }
  }

  // Changes each time the published layout changes: a new complete layout,
  // or none after a session change. Starts at zero in every collector run.
  [[nodiscard]] std::uint64_t LayoutVersion() const noexcept
  {
    return layout_version_;
  }

  // The latest summary for /api/live.
  [[nodiscard]] Json Snapshot(double p_now) const
  {
    if (!latest_)
    {
      return JsonObject{
          {"available", false},
          {"reason",
           "No memory-map samples yet. Set memory_interval_s in the "
           "sampler's config to turn them on."},
          {"stats", Stats()}};
    }
    const auto& header = latest_->header_;
    const auto interval = header.interval_ms_ / 1000.0;
    JsonObject values;
    for (std::size_t index = 0; index < memory_wire::kSummaryFields.size();
         ++index)
    {
      const auto value = latest_->values_[index];
      values.emplace_back(
          std::string{memory_wire::kSummaryFields[index]},
          value == memory_wire::kUnavailable ? Json{} : Json(value));
    }
    return JsonObject{
        {"available", true},
        {"stale", p_now - latest_->received_ > std::max(15.0, 3 * interval)},
        {"updated", latest_->received_},
        {"pid", header.pid_},
        {"interval_s", interval},
        {"flags", FlagsJson(header.flags_)},
        {"values", std::move(values)},
        {"layout_id", layout_available_ ? Json(LayoutId()) : Json(nullptr)},
        {"layout_updated",
         layout_available_ ? Json(layout_received_) : Json(nullptr)},
        {"stats", Stats()}};
  }

  // The latest complete layout for /api/memory-map. Addresses are hex
  // strings: they do not fit in a JavaScript number. "id" names the sample
  // the layout came from, so it is the same in every collector run.
  [[nodiscard]] Json Layout() const
  {
    if (!layout_available_)
    {
      return JsonObject{{"available", false}};
    }
    JsonArray regions;
    regions.reserve(layout_count_);
    for (const auto& region : std::span{layout_regions_}.first(layout_count_))
    {
      const std::string_view name{
          region.name_.data(),
          std::char_traits<char>::length(region.name_.data())};
      regions.push_back(
          JsonObject{{"start", std::format("0x{:x}", region.start_)},
                     {"end", std::format("0x{:x}", region.end_)},
                     {"size", region.end_ - region.start_},
                     {"vmas", region.vma_count_},
                     {"kind", RegionKindName(region.kind_)},
                     {"permissions", PermissionText(region.permissions_)},
                     {"name", name}});
    }
    return JsonObject{{"available", true},
                      {"id", LayoutId()},
                      {"updated", layout_received_},
                      {"pid", layout_header_.pid_},
                      {"flags", FlagsJson(layout_header_.flags_)},
                      {"regions", std::move(regions)}};
  }

 private:
  struct Summary
  {
    memory_wire::Header header_;
    memory_wire::SummaryValues values_{};
    double received_{};
  };

  // Retires the current session, if any, and drops its summary and layout.
  // A late datagram from a retired session is ignored.
  void StartSession(std::uint64_t p_session) noexcept
  {
    if (session_)
    {
      retired_sessions_.PushBack(*session_);
    }
    session_ = p_session;
    latest_.reset();
    assembling_ = false;
    layout_sequence_.reset();
    if (layout_available_)
    {
      layout_available_ = false;
      ++layout_version_;
    }
  }

  [[nodiscard]] bool IsRetired(std::uint64_t p_session) const noexcept
  {
    for (std::size_t index = 0; index < retired_sessions_.Size(); ++index)
    {
      if (retired_sessions_[index] == p_session)
      {
        return true;
      }
    }
    return false;
  }

  void AcceptLayoutPart(const memory_wire::Part& p_part, double p_received)
  {
    const auto& header = p_part.header_;
    if ((layout_sequence_ && header.sequence_ <= *layout_sequence_) ||
        (assembling_ && header.sequence_ < assembly_header_.sequence_))
    {
      // Older than the published layout or the one in progress. A summary
      // was already used above, so only a region part counts as late.
      if (header.kind_ == memory_wire::PartKind::Regions)
      {
        ++late_;
      }
      return;
    }
    if (assembling_ && header.sequence_ == assembly_header_.sequence_ &&
        !header.SameSample(assembly_header_))
    {
      ++bad_parts_;  // the same sample with a different header
      return;
    }
    if (!assembling_ || header.sequence_ != assembly_header_.sequence_)
    {
      if (assembling_)
      {
        ++incomplete_layouts_;  // a part of the previous layout was lost
      }
      assembling_ = true;
      assembly_header_ = header;
      parts_seen_.reset();
      assembly_count_ = 0;
    }
    if (header.kind_ != memory_wire::PartKind::Regions ||
        parts_seen_.test(header.part_))
    {
      return;  // the summary, or a duplicate
    }
    parts_seen_.set(header.part_);
    const auto first =
        (header.part_ - std::size_t{1}) * memory_wire::kRegionsPerPart;
    std::ranges::copy(p_part.Regions(), assembly_regions_.begin() +
                                            static_cast<std::ptrdiff_t>(first));
    assembly_count_ = std::max(assembly_count_, first + p_part.region_count_);
    if (parts_seen_.count() + 1 == header.parts_)
    {
      assembling_ = false;
      layout_header_ = assembly_header_;
      layout_regions_ = assembly_regions_;
      layout_count_ = assembly_count_;
      layout_received_ = p_received;
      layout_sequence_ = header.sequence_;
      layout_available_ = true;
      ++layout_version_;
      ++layouts_;
    }
  }

  // The session and sequence of the published layout's sample. The session
  // does not fit in a JavaScript number, so this is a string.
  [[nodiscard]] std::string LayoutId() const
  {
    return std::format("{}:{}", layout_header_.session_,
                       layout_header_.sequence_);
  }

  [[nodiscard]] static Json FlagsJson(memory_wire::Flags p_flags)
  {
    using memory_wire::Flags;
    using memory_wire::HasFlag;
    return JsonObject{
        {"maps_hidden", HasFlag(p_flags, Flags::MapsHidden)},
        {"maps_partial", HasFlag(p_flags, Flags::MapsPartial)},
        {"regions_truncated", HasFlag(p_flags, Flags::RegionsTruncated)}};
  }

  [[nodiscard]] Json Stats() const
  {
    return JsonObject{{"samples", samples_},
                      {"layouts", layouts_},
                      {"incomplete_layouts", incomplete_layouts_},
                      {"late", late_},
                      {"bad_parts", bad_parts_}};
  }

  std::optional<std::uint64_t> session_;
  Ring<std::uint64_t, kMaxRetiredSessions> retired_sessions_;
  std::optional<Summary> latest_;
  bool assembling_ = false;
  memory_wire::Header assembly_header_;
  std::bitset<memory_wire::kMaxParts> parts_seen_;
  std::array<memory_wire::Region, memory_wire::kMaxRegions> assembly_regions_{};
  std::size_t assembly_count_ = 0;
  memory_wire::Header layout_header_;
  std::array<memory_wire::Region, memory_wire::kMaxRegions> layout_regions_{};
  std::size_t layout_count_ = 0;
  double layout_received_{};
  // The sequence of the published layout's sample, in this session.
  std::optional<std::uint32_t> layout_sequence_;
  bool layout_available_ = false;
  std::uint64_t layout_version_ = 0;
  std::int64_t layouts_ = 0;
  std::int64_t samples_ = 0;
  std::int64_t incomplete_layouts_ = 0;
  std::int64_t late_ = 0;
};

}  // namespace triangulator::collector
