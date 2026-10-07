#pragma once

// The memory report (docs/process-memory-map-design.md, section 9). It runs in
// its own executable against read-only SQLite day files, like the socket
// report. It never reads the UDP stream and never runs in the collector's main
// loop. Reading and judging are separate: ReadEvidence() fills an Evidence from
// the day files, and Findings() is a pure function of the Evidence, so the
// rules are tested without a database.
#include <algorithm>
#include <chrono>
#include <cmath>
#include <format>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "../collector/storage.hpp"
#include "../common/memory_wire.hpp"
#include "../sampler/parsing.hpp"

namespace triangulator::memory_report
{
using collector::Json;
using collector::JsonArray;
using collector::JsonObject;

inline constexpr double kHourS = 3600;
// vm_summary rows exist only while someone watches. A row older than this is
// history, not the state of the process.
inline constexpr double kSummaryMaxAgeS = 900;
// A snapshot is stored at most once an hour, so it may be older.
inline constexpr double kSnapshotMaxAgeS = 2 * kHourS;
inline constexpr double kTrendWindowS = 600;
inline constexpr double kFaultWindowS = 300;
inline constexpr std::uint64_t kMiB = 1024 * 1024;
inline constexpr std::uint64_t kArenaBytes = 64 * kMiB;

enum class Severity
{
  Warning = 0,
  Serious,
  Critical
};

[[nodiscard]] constexpr std::string_view SeverityName(Severity p_severity)
{
  switch (p_severity)
  {
    case Severity::Warning:
      return "warning";
    case Severity::Serious:
      return "serious";
    case Severity::Critical:
      return "critical";
  }
  return "warning";
}

struct Finding
{
  std::string id_;
  Severity severity_ = Severity::Warning;
  std::string title_;
  std::string detail_;
  Json evidence_;
};

// A finding that was not checked, and why. The tab shows the reason, so a
// missing finding never reads as "all is well".
struct Skipped
{
  std::string id_;
  std::string reason_;
};

struct SummaryRow
{
  double ts_{};
  std::array<std::optional<std::uint64_t>, memory_wire::kSummaryFields.size()>
      values_{};
};

struct Vma
{
  std::uint64_t start_{};
  std::uint64_t end_{};
  std::string permissions_;
  std::string kind_;
  std::string name_;
  bool deleted_ = false;

  [[nodiscard]] std::uint64_t Size() const noexcept
  {
    return end_ - start_;
  }
};

struct Snapshot
{
  double ts_{};
  bool truncated_ = false;
  std::uint64_t vma_count_{};
  std::vector<Vma> vmas_;
};

// One resource_sample row.
struct ResourcePoint
{
  double ts_{};
  std::optional<std::int64_t> rss_bytes_;
  std::optional<std::int64_t> swap_bytes_;
  std::optional<std::int64_t> cgroup_current_;
  std::optional<std::int64_t> cgroup_max_;
  std::int64_t cgroup_max_events_ = 0;
  std::int64_t cgroup_oom_kills_ = 0;
  std::optional<double> host_some_pct_;
  std::optional<double> host_full_pct_;
  std::optional<double> cgroup_some_pct_;
  std::optional<double> cgroup_full_pct_;
};

struct Evidence
{
  double at_{};
  std::uint32_t pid_{};
  std::optional<SummaryRow> summary_;
  std::optional<Snapshot> snapshot_;
  std::vector<ResourcePoint> resources_;  // oldest first, the last hour
  // Major faults of all threads, by minute (ts / 60). A minute is here only
  // when a rollup row exists for it, so "no data" never counts as zero.
  std::map<std::int64_t, std::int64_t> major_faults_;
  bool read_error_ = false;
};

namespace detail
{
[[nodiscard]] inline std::string Percent(double p_ratio)
{
  return std::format("{:.0f} %", p_ratio * 100);
}

[[nodiscard]] inline std::string Size(std::uint64_t p_bytes)
{
  constexpr std::array<std::string_view, 5> kUnits{"B", "KiB", "MiB", "GiB",
                                                   "TiB"};
  auto value = static_cast<double>(p_bytes);
  std::size_t unit = 0;
  while (value >= 1024 && unit + 1 < kUnits.size())
  {
    value /= 1024;
    ++unit;
  }
  return unit == 0 ? std::format("{} B", p_bytes)
                   : std::format("{:.1f} {}", value, kUnits[unit]);
}

[[nodiscard]] inline double Median(std::vector<double> p_values)
{
  std::ranges::sort(p_values);
  const auto middle = p_values.size() / 2;
  return p_values.size() % 2 == 1
             ? p_values[middle]
             : (p_values[middle - 1] + p_values[middle]) / 2;
}

// Highest value of a column over the samples since p_from.
template <typename TGetter>
[[nodiscard]] std::optional<double> MaxSince(
    const std::vector<ResourcePoint>& p_points, double p_from, TGetter p_get)
{
  std::optional<double> result;
  for (const auto& point : p_points)
  {
    const std::optional<double> value = p_get(point);
    if (point.ts_ >= p_from && value)
    {
      result = result ? std::max(*result, *value) : *value;
    }
  }
  return result;
}

inline void Add(std::vector<Finding>& p_out, std::string p_id,
                Severity p_severity, std::string p_title, std::string p_detail,
                Json p_evidence)
{
  p_out.push_back(Finding{.id_ = std::move(p_id),
                          .severity_ = p_severity,
                          .title_ = std::move(p_title),
                          .detail_ = std::move(p_detail),
                          .evidence_ = std::move(p_evidence)});
}

// Warns at p_warn and is critical at p_critical (as ratios of a limit).
[[nodiscard]] inline std::optional<Severity> Level(double p_ratio,
                                                   double p_warn,
                                                   double p_critical)
{
  if (p_ratio >= p_critical)
  {
    return Severity::Critical;
  }
  if (p_ratio >= p_warn)
  {
    return Severity::Warning;
  }
  return std::nullopt;
}
}  // namespace detail

// The findings that come from vm_summary: the limits of one process.
inline void CheckLimits(const Evidence& p_evidence, std::vector<Finding>& p_out,
                        std::vector<Skipped>& p_skipped)
{
  using namespace memory_wire;
  if (!p_evidence.summary_)
  {
    for (const auto* id : {"vma_count", "address_space", "stack"})
    {
      p_skipped.push_back(
          {id,
           "Nobody watched the memory map in the last 15 minutes. Open "
           "the Memory map section to measure it."});
    }
    return;
  }
  const auto& values = p_evidence.summary_->values_;
  const auto vma_count = values[Field("vma_count")];
  const auto max_map_count = values[Field("max_map_count")];
  if (vma_count && max_map_count && *max_map_count > 0)
  {
    const double ratio =
        static_cast<double>(*vma_count) / static_cast<double>(*max_map_count);
    if (const auto level = detail::Level(ratio, 0.8, 0.9))
    {
      detail::Add(p_out, "vma_count", *level,
                  std::format("{} of the mapping limit is used",
                              detail::Percent(ratio)),
                  std::format("The process has {} mappings. The limit "
                              "vm.max_map_count is {}. At the limit, mmap and "
                              "mprotect fail with ENOMEM even when RAM is "
                              "free.",
                              *vma_count, *max_map_count),
                  JsonObject{{"vma_count", *vma_count},
                             {"max_map_count", *max_map_count}});
    }
  }
  const auto vm_size = values[Field("vm_size_bytes")];
  const auto address_limit = values[Field("rlimit_as_bytes")];
  if (vm_size && address_limit && *address_limit > 0)
  {
    const double ratio =
        static_cast<double>(*vm_size) / static_cast<double>(*address_limit);
    if (ratio >= 0.8)
    {
      detail::Add(
          p_out, "address_space", Severity::Warning,
          std::format("{} of the address-space limit is used",
                      detail::Percent(ratio)),
          std::format("The process maps {}. RLIMIT_AS is {}. At the "
                      "limit, mmap and brk fail with ENOMEM.",
                      detail::Size(*vm_size), detail::Size(*address_limit)),
          JsonObject{{"vm_size_bytes", *vm_size},
                     {"rlimit_as_bytes", *address_limit}});
    }
  }
  const auto stack_start = values[Field("stack_start")];
  const auto stack_end = values[Field("stack_end")];
  const auto stack_limit = values[Field("rlimit_stack_bytes")];
  if (stack_start && stack_end && *stack_end >= *stack_start && stack_limit &&
      *stack_limit > 0)
  {
    const auto size = *stack_end - *stack_start;
    const double ratio =
        static_cast<double>(size) / static_cast<double>(*stack_limit);
    if (const auto level = detail::Level(ratio, 0.5, 0.8))
    {
      detail::Add(p_out, "stack", *level,
                  std::format("The main stack uses {} of its limit",
                              detail::Percent(ratio)),
                  std::format("The stack is {}. RLIMIT_STACK is {}. At the "
                              "limit the process receives SIGSEGV. Look for "
                              "deep or endless recursion, or large arrays on "
                              "the stack.",
                              detail::Size(size), detail::Size(*stack_limit)),
                  JsonObject{{"stack_bytes", size},
                             {"rlimit_stack_bytes", *stack_limit}});
    }
  }
}

// Counts the reserved 64 MiB blocks that glibc uses for the heaps of its
// non-main arenas: anonymous mappings that start on a 64 MiB boundary and,
// together with the neighbors that follow them, are exactly 64 MiB long.
[[nodiscard]] inline std::size_t CountArenaHeaps(std::vector<Vma> p_vmas)
{
  std::ranges::sort(p_vmas, {}, &Vma::start_);
  std::size_t count = 0;
  for (std::size_t index = 0; index < p_vmas.size();)
  {
    const auto& first = p_vmas[index];
    if (first.kind_ != "anonymous" || first.start_ % kArenaBytes != 0)
    {
      ++index;
      continue;
    }
    auto end = first.end_;
    auto next = index + 1;
    while (end < first.start_ + kArenaBytes && next < p_vmas.size() &&
           p_vmas[next].kind_ == "anonymous" && p_vmas[next].start_ == end)
    {
      end = p_vmas[next].end_;
      ++next;
    }
    if (end - first.start_ == kArenaBytes)
    {
      ++count;
      index = next;
    }
    else
    {
      ++index;
    }
  }
  return count;
}

// The findings that come from the stored VMA list.
inline void CheckSnapshot(const Evidence& p_evidence,
                          std::vector<Finding>& p_out,
                          std::vector<Skipped>& p_skipped)
{
  if (!p_evidence.snapshot_)
  {
    for (const auto* id :
         {"small_vmas", "arenas", "stale_library", "writable_executable"})
    {
      p_skipped.push_back(
          {id,
           "No stored VMA list in the last 2 hours. Open the Memory map "
           "section to record one."});
    }
    return;
  }
  const auto& snapshot = *p_evidence.snapshot_;
  const auto& vmas = snapshot.vmas_;

  std::vector<std::string> deleted;
  std::vector<std::string> executable_writable;
  for (const auto& vma : vmas)
  {
    // memfd, /dev/zero and SysV shared memory are removed on purpose.
    if (vma.deleted_ && vma.name_.starts_with('/') &&
        !vma.name_.starts_with("/memfd:") &&
        !vma.name_.starts_with("/dev/zero") &&
        !vma.name_.starts_with("/SYSV") &&
        std::ranges::find(deleted, vma.name_) == deleted.end())
    {
      deleted.push_back(vma.name_);
    }
    if (vma.permissions_.starts_with("rwx"))
    {
      executable_writable.push_back(std::format(
          "{:x}-{:x} {}", vma.start_, vma.end_,
          vma.name_.empty() ? std::string{"anonymous"} : vma.name_));
    }
  }
  if (!deleted.empty())
  {
    JsonArray names;
    for (const auto& name : deleted)
    {
      names.emplace_back(name);
    }
    detail::Add(
        p_out, "stale_library", Severity::Warning,
        std::format("The process runs {} replaced file{}", deleted.size(),
                    deleted.size() == 1 ? "" : "s"),
        std::format("{} is mapped but deleted on disk. This is usually a "
                    "package update. The process keeps the old code until it "
                    "restarts.",
                    deleted.front()),
        JsonObject{{"files", std::move(names)}});
  }
  if (!executable_writable.empty())
  {
    JsonArray ranges;
    for (std::size_t index = 0;
         index < std::min<std::size_t>(executable_writable.size(), 10); ++index)
    {
      ranges.emplace_back(executable_writable[index]);
    }
    detail::Add(
        p_out, "writable_executable", Severity::Warning,
        std::format("{} mapping{} both writable and executable",
                    executable_writable.size(),
                    executable_writable.size() == 1 ? " is" : "s are"),
        "Memory that can be written and run is normal for a JIT compiler. "
        "Other programs should not have it.",
        JsonObject{{"count", executable_writable.size()},
                   {"mappings", std::move(ranges)}});
  }

  // A list cut at memory_map_max_vmas holds the largest mappings, so counts of
  // small ones would be too low.
  if (snapshot.truncated_)
  {
    for (const auto* id : {"small_vmas", "arenas"})
    {
      p_skipped.push_back({id, "The stored VMA list was cut at the limit."});
    }
    return;
  }
  const auto small = static_cast<std::size_t>(std::ranges::count_if(
      vmas,
      [](const Vma& p_vma)
      {
        return p_vma.Size() >= 4096 && p_vma.Size() <= 64 * 1024;
      }));
  if (vmas.size() >= 1000 && small * 2 > vmas.size())
  {
    detail::Add(
        p_out, "small_vmas", Severity::Warning,
        std::format("{} of {} mappings are 4 to 64 KiB",
                    detail::Percent(static_cast<double>(small) /
                                    static_cast<double>(vmas.size())),
                    vmas.size()),
        "Many small mappings often mean many guard pages or many tiny mmap "
        "calls. They use the mapping limit and fragment the address space.",
        JsonObject{{"small", small}, {"vma_count", vmas.size()}});
  }
  const auto summary_cpus =
      p_evidence.summary_
          ? p_evidence.summary_->values_[memory_wire::Field("cpu_count")]
          : std::nullopt;
  if (!summary_cpus || *summary_cpus == 0)
  {
    p_skipped.push_back({"arenas", "The CPU count is not known."});
    return;
  }
  const auto arenas = CountArenaHeaps(vmas);
  if (arenas > 8 * *summary_cpus)
  {
    detail::Add(
        p_out, "arenas", Severity::Warning,
        std::format("{} malloc arena heaps for {} CPUs", arenas, *summary_cpus),
        "The glibc default allows 8 arenas for each CPU. Many arenas mean "
        "many threads that allocate, and each arena keeps its free memory. "
        "Consider MALLOC_ARENA_MAX.",
        JsonObject{{"arena_heaps", arenas}, {"cpu_count", *summary_cpus}});
  }
}

// The findings that come from the tables that the collector writes all the
// time: they work also when nobody watched the memory map before.
inline void CheckTrends(const Evidence& p_evidence, std::vector<Finding>& p_out,
                        std::vector<Skipped>& p_skipped)
{
  const auto& points = p_evidence.resources_;
  const double at = p_evidence.at_;
  if (points.empty())
  {
    for (const auto* id : {"rss_growth", "memory_pressure", "swap", "cgroup"})
    {
      p_skipped.push_back({id, "No resource samples in the last hour."});
    }
  }
  else
  {
    // Resident memory that rises in almost every step, for 10 minutes.
    std::vector<const ResourcePoint*> window;
    for (const auto& point : points)
    {
      if (point.ts_ >= at - kTrendWindowS && point.rss_bytes_)
      {
        window.push_back(&point);
      }
    }
    const double span =
        window.size() >= 2 ? window.back()->ts_ - window.front()->ts_ : 0;
    if (window.size() < 10 || span < kTrendWindowS / 2)
    {
      p_skipped.push_back({"rss_growth", "Less than 5 minutes of samples."});
    }
    else
    {
      std::size_t rising = 0;
      for (std::size_t index = 1; index < window.size(); ++index)
      {
        rising += *window[index]->rss_bytes_ > *window[index - 1]->rss_bytes_;
      }
      const double steps = static_cast<double>(window.size() - 1);
      const double per_minute =
          static_cast<double>(*window.back()->rss_bytes_ -
                              *window.front()->rss_bytes_) /
          (span / 60);
      if (static_cast<double>(rising) >= 0.9 * steps &&
          per_minute > static_cast<double>(kMiB))
      {
        detail::Add(
            p_out, "rss_growth", Severity::Warning,
            std::format("Resident memory grows by {}/min without a plateau",
                        detail::Size(static_cast<std::uint64_t>(per_minute))),
            "It rose in at least 90 % of the steps in the last 10 minutes. "
            "This is a suspicion of a leak, not proof: a cache that fills "
            "looks the same.",
            JsonObject{{"per_minute_bytes", per_minute},
                       {"rising_steps", rising},
                       {"steps", window.size() - 1},
                       {"rss_bytes", *window.back()->rss_bytes_}});
      }
    }

    // Pressure stall information of the last minute.
    const double recent = at - 60;
    const auto host_some = detail::MaxSince(points, recent,
                                            [](const ResourcePoint& p_point)
                                            {
                                              return p_point.host_some_pct_;
                                            });
    const auto host_full = detail::MaxSince(points, recent,
                                            [](const ResourcePoint& p_point)
                                            {
                                              return p_point.host_full_pct_;
                                            });
    const auto group_some = detail::MaxSince(points, recent,
                                             [](const ResourcePoint& p_point)
                                             {
                                               return p_point.cgroup_some_pct_;
                                             });
    const auto group_full = detail::MaxSince(points, recent,
                                             [](const ResourcePoint& p_point)
                                             {
                                               return p_point.cgroup_full_pct_;
                                             });
    const bool full = host_full.value_or(0) > 0 || group_full.value_or(0) > 0;
    const bool some = host_some.value_or(0) > 10 || group_some.value_or(0) > 10;
    if (full || some)
    {
      detail::Add(
          p_out, "memory_pressure", Severity::Serious,
          full ? "Tasks stall on memory (full pressure)"
               : "Tasks wait for memory more than 10 % of the time",
          full ? "All non-idle tasks waited for memory at the same time. The "
                 "workload needs more memory, or its limit is too low."
               : "Some tasks waited for reclaim, swap or page-ins. Check the "
                 "memory limits and the growth.",
          JsonObject{{"host_some_pct", host_some},
                     {"host_full_pct", host_full},
                     {"cgroup_some_pct", group_some},
                     {"cgroup_full_pct", group_full}});
    }

    // Swap that is in use and growing.
    const auto& latest = points.back();
    std::optional<std::int64_t> earliest_swap;
    for (const auto& point : points)
    {
      if (point.ts_ >= at - kTrendWindowS && point.swap_bytes_)
      {
        earliest_swap = point.swap_bytes_;
        break;
      }
    }
    if (latest.swap_bytes_ && *latest.swap_bytes_ > 0 && earliest_swap &&
        *latest.swap_bytes_ > *earliest_swap)
    {
      detail::Add(
          p_out, "swap", Severity::Warning,
          std::format(
              "{} of this process is in swap, and it grows",
              detail::Size(static_cast<std::uint64_t>(*latest.swap_bytes_))),
          "The value rose in the last 10 minutes. Pages in swap cost a disk "
          "read when the process needs them again.",
          JsonObject{{"swap_bytes", *latest.swap_bytes_},
                     {"swap_bytes_before", *earliest_swap}});
    }

    // Room in the cgroup, and the kernel's events about its limit.
    std::int64_t limit_events = 0;
    std::int64_t oom_kills = 0;
    for (const auto& point : points)
    {
      if (point.ts_ >= at - kTrendWindowS)
      {
        limit_events += point.cgroup_max_events_;
        oom_kills += point.cgroup_oom_kills_;
      }
    }
    // A limit near 2^63 is "max" (no limit).
    const bool limited = latest.cgroup_max_ && *latest.cgroup_max_ > 0 &&
                         *latest.cgroup_max_ < (std::int64_t{1} << 60);
    const double used = limited && latest.cgroup_current_
                            ? static_cast<double>(*latest.cgroup_current_) /
                                  static_cast<double>(*latest.cgroup_max_)
                            : 0;
    if (oom_kills > 0 || limit_events > 0 || used > 0.9)
    {
      detail::Add(
          p_out, "cgroup",
          oom_kills > 0 ? Severity::Critical : Severity::Warning,
          oom_kills > 0
              ? "The OOM killer ended a process in the cgroup"
              : (limit_events > 0
                     ? "The cgroup reached its memory limit"
                     : std::format("The cgroup uses {} of its memory limit",
                                   detail::Percent(used))),
          "Usage includes page cache that the kernel can reclaim. It is a "
          "problem when the process's own memory is most of it.",
          JsonObject{{"current_bytes", latest.cgroup_current_},
                     {"max_bytes", latest.cgroup_max_},
                     {"limit_events_10min", limit_events},
                     {"oom_kills_10min", oom_kills}});
    }
  }

  // Major page faults: the last 5 minutes against the median minute of the
  // last hour.
  const auto recent_first =
      static_cast<std::int64_t>(std::floor((at - kFaultWindowS) / 60)) + 1;
  std::int64_t recent_sum = 0;
  std::size_t recent_minutes = 0;
  std::vector<double> per_minute;
  for (const auto& [minute, faults] : p_evidence.major_faults_)
  {
    per_minute.push_back(static_cast<double>(faults) / 60);
    if (minute >= recent_first)
    {
      recent_sum += faults;
      ++recent_minutes;
    }
  }
  if (recent_minutes < 3 || per_minute.size() < 10)
  {
    p_skipped.push_back(
        {"major_faults", "Less than 10 minutes of thread samples."});
    return;
  }
  const double rate = static_cast<double>(recent_sum) /
                      static_cast<double>(recent_minutes * 60);
  const double typical = detail::Median(std::move(per_minute));
  if (rate > 10 && rate > 4 * typical)
  {
    detail::Add(
        p_out, "major_faults", Severity::Warning,
        std::format("Major page faults: {:.0f} per second", rate),
        std::format("The usual rate in the last hour is {:.1f} per "
                    "second. A major fault reads a page from disk, "
                    "so the thread waits. Memory may be short.",
                    typical),
        JsonObject{{"per_second", rate}, {"typical_per_second", typical}});
  }
}

struct Result
{
  std::vector<Finding> findings_;
  std::vector<Skipped> skipped_;
};

[[nodiscard]] inline Result Findings(const Evidence& p_evidence)
{
  Result result;
  CheckLimits(p_evidence, result.findings_, result.skipped_);
  CheckSnapshot(p_evidence, result.findings_, result.skipped_);
  CheckTrends(p_evidence, result.findings_, result.skipped_);
  std::ranges::stable_sort(result.findings_,
                           [](const Finding& p_left, const Finding& p_right)
                           {
                             return p_left.severity_ > p_right.severity_;
                           });
  return result;
}

[[nodiscard]] inline Json ToJson(const Evidence& p_evidence,
                                 const Result& p_result)
{
  JsonArray findings;
  for (const auto& finding : p_result.findings_)
  {
    findings.emplace_back(
        JsonObject{{"id", finding.id_},
                   {"severity", SeverityName(finding.severity_)},
                   {"title", finding.title_},
                   {"detail", finding.detail_},
                   {"evidence", finding.evidence_}});
  }
  JsonArray skipped;
  for (const auto& item : p_result.skipped_)
  {
    skipped.emplace_back(
        JsonObject{{"id", item.id_}, {"reason", item.reason_}});
  }
  const auto age = [&](double p_ts)
  {
    return p_evidence.at_ - p_ts;
  };
  return JsonObject{
      {"available", true},
      {"pid", p_evidence.pid_},
      {"at", p_evidence.at_},
      {"findings", std::move(findings)},
      {"skipped", std::move(skipped)},
      {"sources",
       JsonObject{
           {"summary_age_s",
            p_evidence.summary_ ? Json{age(p_evidence.summary_->ts_)} : Json{}},
           {"snapshot_age_s", p_evidence.snapshot_
                                  ? Json{age(p_evidence.snapshot_->ts_)}
                                  : Json{}},
           {"resource_samples", p_evidence.resources_.size()},
           {"fault_minutes", p_evidence.major_faults_.size()}}},
      {"read_error", p_evidence.read_error_}};
}

// ---------------------------------------------------------------------------
// Reading the day files. Every function opens a file read-only, so the report
// cannot disturb the collector's writes. A file that cannot be read sets
// read_error_ and is skipped.

// The day files that can hold rows in [p_from, p_to], newest first.
[[nodiscard]] inline std::vector<std::filesystem::path> DayPaths(
    const std::filesystem::path& p_directory, double p_from, double p_to)
{
  std::vector<std::filesystem::path> paths;
  const auto first = collector::UtcDay(p_from);
  for (auto day = collector::UtcDay(p_to); day >= first;
       day -= std::chrono::days{1})
  {
    auto path = p_directory / std::format("{:%F}.sqlite3", day);
    std::error_code error;
    if (std::filesystem::exists(path, error))
    {
      paths.push_back(std::move(path));
    }
  }
  return paths;
}

[[nodiscard]] inline std::expected<bool, std::string> HasTable(
    sqlite3* p_database, std::string_view p_table)
{
  auto statement = collector::Prepare(
      p_database, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
  if (!statement)
  {
    return std::unexpected(std::move(statement.error()));
  }
  collector::Binder{statement->get()}.Add(p_table);
  const int status = ::sqlite3_step(statement->get());
  if (auto checked = collector::Check(p_database, status); !checked)
  {
    return std::unexpected(std::move(checked.error()));
  }
  return status == SQLITE_ROW;
}

[[nodiscard]] inline std::optional<std::int64_t> OptionalInt(
    sqlite3_stmt* p_statement, int p_column)
{
  if (::sqlite3_column_type(p_statement, p_column) == SQLITE_NULL)
  {
    return std::nullopt;
  }
  return ::sqlite3_column_int64(p_statement, p_column);
}

[[nodiscard]] inline std::optional<double> OptionalReal(
    sqlite3_stmt* p_statement, int p_column)
{
  if (::sqlite3_column_type(p_statement, p_column) == SQLITE_NULL)
  {
    return std::nullopt;
  }
  return ::sqlite3_column_double(p_statement, p_column);
}

// The VMA rows of kVmaColumns, as stored in vm_snapshot.
[[nodiscard]] inline std::optional<std::vector<Vma>> ParseVmas(
    std::string_view p_json)
{
  const auto parsed = collector::ParseJson(p_json);
  if (!parsed || !parsed->IsArray())
  {
    return std::nullopt;
  }
  std::vector<Vma> vmas;
  for (const auto& row : parsed->AsArray())
  {
    if (!row.IsArray() || row.AsArray().size() < 11)
    {
      return std::nullopt;
    }
    const auto& cells = row.AsArray();
    if (!cells[0].IsString() || !cells[1].IsString() || !cells[6].IsString() ||
        !cells[7].IsString() || !cells[9].IsNumber() || !cells[10].IsString())
    {
      return std::nullopt;
    }
    const auto start = ParseHex(cells[0].AsString());
    const auto end = ParseHex(cells[1].AsString());
    if (!start || !end || *end < *start)
    {
      return std::nullopt;
    }
    vmas.push_back(
        Vma{.start_ = *start,
            .end_ = *end,
            .permissions_ = cells[6].AsString(),
            .kind_ = cells[7].AsString(),
            .name_ = cells[10].AsString(),
            .deleted_ = (static_cast<int>(cells[9].AsNumber()) & 1) != 0});
  }
  return vmas;
}

// The pid of the newest resource sample or summary at or before p_at. A
// summary with pid 0 means "no target" and is ignored.
[[nodiscard]] inline std::optional<std::uint32_t> FindPid(
    const std::vector<std::filesystem::path>& p_files, double p_at,
    bool& p_read_error)
{
  std::optional<std::uint32_t> pid;
  double newest = 0;
  for (const auto& path : p_files)
  {
    auto database = collector::OpenDatabase(path, true);
    if (!database)
    {
      p_read_error = true;
      continue;
    }
    ::sqlite3_busy_timeout(database->get(), 100);
    for (const auto* table : {"resource_sample", "vm_summary"})
    {
      const auto present = HasTable(database->get(), table);
      if (!present)
      {
        p_read_error = true;
        continue;
      }
      if (!*present)
      {
        continue;
      }
      auto statement = collector::Prepare(
          database->get(),
          std::format("SELECT pid,ts FROM {} WHERE ts<=? AND pid>0 ORDER BY "
                      "ts DESC LIMIT 1",
                      table));
      if (!statement)
      {
        p_read_error = true;
        continue;
      }
      collector::Binder{statement->get()}.Add(p_at);
      if (::sqlite3_step(statement->get()) == SQLITE_ROW &&
          ::sqlite3_column_double(statement->get(), 1) > newest)
      {
        newest = ::sqlite3_column_double(statement->get(), 1);
        pid = static_cast<std::uint32_t>(
            ::sqlite3_column_int64(statement->get(), 0));
      }
    }
  }
  return pid;
}

inline void ReadResources(sqlite3* p_database, Evidence& p_evidence)
{
  auto statement = collector::Prepare(
      p_database,
      "SELECT ts,rss_bytes,swap_bytes,cgroup_memory_current,cgroup_memory_max,"
      "cgroup_memory_max_events_delta,cgroup_memory_oom_kill_delta,"
      "host_memory_some_pct,host_memory_full_pct,cgroup_memory_some_pct,"
      "cgroup_memory_full_pct FROM resource_sample WHERE pid=? AND ts>? AND "
      "ts<=? ORDER BY ts");
  if (!statement)
  {
    p_evidence.read_error_ = true;
    return;
  }
  auto* query = statement->get();
  collector::Binder{query}
      .Add(std::int64_t{p_evidence.pid_})
      .Add(p_evidence.at_ - kHourS)
      .Add(p_evidence.at_);
  int status = SQLITE_DONE;
  while ((status = ::sqlite3_step(query)) == SQLITE_ROW)
  {
    p_evidence.resources_.push_back(
        ResourcePoint{.ts_ = ::sqlite3_column_double(query, 0),
                      .rss_bytes_ = OptionalInt(query, 1),
                      .swap_bytes_ = OptionalInt(query, 2),
                      .cgroup_current_ = OptionalInt(query, 3),
                      .cgroup_max_ = OptionalInt(query, 4),
                      .cgroup_max_events_ = OptionalInt(query, 5).value_or(0),
                      .cgroup_oom_kills_ = OptionalInt(query, 6).value_or(0),
                      .host_some_pct_ = OptionalReal(query, 7),
                      .host_full_pct_ = OptionalReal(query, 8),
                      .cgroup_some_pct_ = OptionalReal(query, 9),
                      .cgroup_full_pct_ = OptionalReal(query, 10)});
  }
  if (status != SQLITE_DONE)
  {
    p_evidence.read_error_ = true;
  }
}

inline void ReadFaults(sqlite3* p_database, Evidence& p_evidence)
{
  auto statement = collector::Prepare(
      p_database,
      "SELECT CAST(ts/60 AS INTEGER),COALESCE(SUM(major_faults_delta),0) FROM "
      "thread_rollup WHERE ts>? AND ts<=? GROUP BY 1");
  if (!statement)
  {
    p_evidence.read_error_ = true;
    return;
  }
  auto* query = statement->get();
  collector::Binder{query}.Add(p_evidence.at_ - kHourS).Add(p_evidence.at_);
  int status = SQLITE_DONE;
  while ((status = ::sqlite3_step(query)) == SQLITE_ROW)
  {
    p_evidence.major_faults_[::sqlite3_column_int64(query, 0)] +=
        ::sqlite3_column_int64(query, 1);
  }
  if (status != SQLITE_DONE)
  {
    p_evidence.read_error_ = true;
  }
}

inline void ReadSummary(sqlite3* p_database, Evidence& p_evidence)
{
  std::string columns = "ts";
  for (const auto name : memory_wire::kSummaryFields)
  {
    columns += std::format(",{}", name);
  }
  auto statement = collector::Prepare(
      p_database,
      std::format("SELECT {} FROM vm_summary WHERE pid=? AND ts>? AND ts<=? "
                  "ORDER BY ts DESC LIMIT 1",
                  columns));
  if (!statement)
  {
    p_evidence.read_error_ = true;
    return;
  }
  auto* query = statement->get();
  collector::Binder{query}
      .Add(std::int64_t{p_evidence.pid_})
      .Add(p_evidence.at_ - kSummaryMaxAgeS)
      .Add(p_evidence.at_);
  const int status = ::sqlite3_step(query);
  if (status == SQLITE_ROW)
  {
    SummaryRow row;
    row.ts_ = ::sqlite3_column_double(query, 0);
    for (std::size_t index = 0; index < row.values_.size(); ++index)
    {
      const auto value = OptionalInt(query, static_cast<int>(index) + 1);
      if (value && *value >= 0)
      {
        row.values_[index] = static_cast<std::uint64_t>(*value);
      }
    }
    if (!p_evidence.summary_ || row.ts_ > p_evidence.summary_->ts_)
    {
      p_evidence.summary_ = std::move(row);
    }
  }
  else if (status != SQLITE_DONE)
  {
    p_evidence.read_error_ = true;
  }
}

inline void ReadSnapshot(sqlite3* p_database, Evidence& p_evidence)
{
  auto statement = collector::Prepare(
      p_database,
      "SELECT ts,vma_count,truncated,vmas FROM vm_snapshot WHERE pid=? AND "
      "ts>? AND ts<=? ORDER BY ts DESC LIMIT 1");
  if (!statement)
  {
    p_evidence.read_error_ = true;
    return;
  }
  auto* query = statement->get();
  collector::Binder{query}
      .Add(std::int64_t{p_evidence.pid_})
      .Add(p_evidence.at_ - kSnapshotMaxAgeS)
      .Add(p_evidence.at_);
  const int status = ::sqlite3_step(query);
  if (status == SQLITE_ROW)
  {
    const double ts = ::sqlite3_column_double(query, 0);
    if (p_evidence.snapshot_ && p_evidence.snapshot_->ts_ >= ts)
    {
      return;
    }
    auto vmas = ParseVmas(collector::ColumnText(query, 3));
    if (!vmas)
    {
      p_evidence.read_error_ = true;
      return;
    }
    p_evidence.snapshot_ = Snapshot{
        .ts_ = ts,
        .truncated_ = ::sqlite3_column_int64(query, 2) != 0,
        .vma_count_ =
            static_cast<std::uint64_t>(::sqlite3_column_int64(query, 1)),
        .vmas_ = std::move(*vmas)};
  }
  else if (status != SQLITE_DONE)
  {
    p_evidence.read_error_ = true;
  }
}

// Fills the Evidence for p_pid (0: the newest process) at time p_at.
[[nodiscard]] inline std::optional<Evidence> ReadEvidence(
    const std::filesystem::path& p_directory, std::uint32_t p_pid, double p_at)
{
  Evidence evidence;
  evidence.at_ = p_at;
  const auto files = DayPaths(p_directory, p_at - kSnapshotMaxAgeS, p_at);
  if (p_pid == 0)
  {
    const auto pid = FindPid(files, p_at, evidence.read_error_);
    if (!pid)
    {
      return std::nullopt;
    }
    p_pid = *pid;
  }
  evidence.pid_ = p_pid;
  // Newest file first: the first file that has a summary or a snapshot wins,
  // and the resource window crosses at most one midnight.
  for (const auto& path : files)
  {
    auto database = collector::OpenDatabase(path, true);
    if (!database)
    {
      evidence.read_error_ = true;
      continue;
    }
    auto* handle = database->get();
    ::sqlite3_busy_timeout(handle, 100);
    for (const auto* table :
         {"resource_sample", "thread_rollup", "vm_summary", "vm_snapshot"})
    {
      const auto present = HasTable(handle, table);
      if (!present)
      {
        evidence.read_error_ = true;
        continue;
      }
      if (!*present)
      {
        continue;
      }
      const std::string_view name{table};
      if (name == "resource_sample")
      {
        ReadResources(handle, evidence);
      }
      else if (name == "thread_rollup")
      {
        ReadFaults(handle, evidence);
      }
      else if (name == "vm_summary")
      {
        ReadSummary(handle, evidence);
      }
      else
      {
        ReadSnapshot(handle, evidence);
      }
    }
  }
  std::ranges::sort(evidence.resources_, {}, &ResourcePoint::ts_);
  return evidence;
}

// The report for p_pid (0: the newest process) as it was at p_at.
[[nodiscard]] inline Json Report(const std::filesystem::path& p_directory,
                                 std::uint32_t p_pid, double p_at)
{
  const auto evidence = ReadEvidence(p_directory, p_pid, p_at);
  if (!evidence)
  {
    return JsonObject{
        {"available", false},
        {"reason", "No resource samples or memory-map rows are recorded yet."}};
  }
  return ToJson(*evidence, Findings(*evidence));
}
}  // namespace triangulator::memory_report
