// Tests of the memory report rules (docs/process-memory-map-design.md,
// section 9): the rules on built Evidence, and a round trip through real
// day files.
#include "../metrics/memory_report.hpp"

#include <unistd.h>

#include <cassert>
#include <iostream>

namespace
{
using namespace triangulator::memory_report;
using triangulator::memory_wire::Field;

constexpr double kAt = 1'790'000'000;

SummaryRow Summary()
{
  SummaryRow row;
  row.ts_ = kAt - 5;
  row.values_[Field("vma_count")] = 100;
  row.values_[Field("max_map_count")] = 65530;
  row.values_[Field("vm_size_bytes")] = 100 * kMiB;
  row.values_[Field("rlimit_as_bytes")] = 1000 * kMiB;
  row.values_[Field("stack_start")] = 0x7ffc'0000'0000ULL;
  row.values_[Field("stack_end")] = 0x7ffc'0000'0000ULL + 132 * 1024;
  row.values_[Field("rlimit_stack_bytes")] = 8 * kMiB;
  row.values_[Field("cpu_count")] = 1;
  return row;
}

Evidence Quiet()
{
  Evidence evidence;
  evidence.at_ = kAt;
  evidence.pid_ = 50;
  evidence.summary_ = Summary();
  evidence.snapshot_ = Snapshot{
      .ts_ = kAt - 60, .truncated_ = false, .vma_count_ = 0, .vmas_ = {}};
  return evidence;
}

const Finding* Find(const Result& p_result, std::string_view p_id)
{
  for (const auto& finding : p_result.findings_)
  {
    if (finding.id_ == p_id)
    {
      return &finding;
    }
  }
  return nullptr;
}

bool Skips(const Result& p_result, std::string_view p_id)
{
  return std::ranges::any_of(p_result.skipped_,
                             [&](const Skipped& p_item)
                             {
                               return p_item.id_ == p_id;
                             });
}

Vma Mapping(std::uint64_t p_start, std::uint64_t p_size,
            std::string p_permissions = "rw-p",
            std::string p_kind = "anonymous", std::string p_name = "",
            bool p_deleted = false)
{
  return Vma{.start_ = p_start,
             .end_ = p_start + p_size,
             .permissions_ = std::move(p_permissions),
             .kind_ = std::move(p_kind),
             .name_ = std::move(p_name),
             .deleted_ = p_deleted};
}

void Limits()
{
  auto evidence = Quiet();
  auto result = Findings(evidence);
  assert(result.findings_.empty());

  // 80 % warns, 90 % is critical.
  evidence.summary_->values_[Field("vma_count")] = 52'500;
  result = Findings(evidence);
  assert(Find(result, "vma_count")->severity_ == Severity::Warning);
  evidence.summary_->values_[Field("vma_count")] = 59'000;
  result = Findings(evidence);
  assert(Find(result, "vma_count")->severity_ == Severity::Critical);
  evidence.summary_->values_[Field("vma_count")] = 100;

  evidence.summary_->values_[Field("vm_size_bytes")] = 850 * kMiB;
  assert(Find(Findings(evidence), "address_space"));
  evidence.summary_->values_[Field("vm_size_bytes")] = 100 * kMiB;

  // The stack is 132 KiB of 8 MiB. 50 % warns; 80 % is critical.
  auto& end = evidence.summary_->values_[Field("stack_end")];
  end = 0x7ffc'0000'0000ULL + 4 * kMiB;
  assert(Find(Findings(evidence), "stack")->severity_ == Severity::Warning);
  end = 0x7ffc'0000'0000ULL + 7 * kMiB;
  assert(Find(Findings(evidence), "stack")->severity_ == Severity::Critical);

  // An unlimited address space has no ratio. Unknown is not zero: no finding.
  evidence.summary_->values_[Field("rlimit_as_bytes")] = std::nullopt;
  evidence.summary_->values_[Field("vm_size_bytes")] = 850 * kMiB;
  assert(!Find(Findings(evidence), "address_space"));

  // Without a recent summary the checks are listed as not done.
  evidence.summary_.reset();
  result = Findings(evidence);
  assert(Skips(result, "vma_count") && Skips(result, "stack"));
}

void Snapshots()
{
  auto evidence = Quiet();
  auto& vmas = evidence.snapshot_->vmas_;
  vmas.push_back(Mapping(0x7f00'0000'0000ULL, 4096, "r-xp", "file",
                         "/usr/lib/libc.so", true));
  vmas.push_back(Mapping(0x7f10'0000'0000ULL, 4096, "r-xp", "file",
                         "/memfd:jit", true));  // removed on purpose
  vmas.push_back(Mapping(0x7f20'0000'0000ULL, 8192, "rwxp"));
  auto result = Findings(evidence);
  assert(Find(result, "stale_library")
             ->evidence_.Find("files")
             ->AsArray()
             .size() == 1);
  assert(Find(result, "writable_executable"));
  assert(!Find(result, "small_vmas"));

  // More than half of at least 1000 mappings are 4 to 64 KiB.
  for (std::uint64_t index = 0; index < 1000; ++index)
  {
    vmas.push_back(Mapping(0x7e00'0000'0000ULL + index * 0x20000, 8192));
  }
  assert(Find(Findings(evidence), "small_vmas"));

  // A glibc arena heap: 64 MiB aligned, a readable part and the reserved rest.
  // 9 heaps for 1 CPU is above 8 per CPU.
  evidence.snapshot_->vmas_.clear();
  for (std::uint64_t index = 0; index < 9; ++index)
  {
    const auto start = 0x7d00'0000'0000ULL + index * 2 * kArenaBytes;
    evidence.snapshot_->vmas_.push_back(Mapping(start, 2 * kMiB));
    evidence.snapshot_->vmas_.push_back(
        Mapping(start + 2 * kMiB, kArenaBytes - 2 * kMiB, "---p"));
  }
  assert(CountArenaHeaps(evidence.snapshot_->vmas_) == 9);
  assert(Find(Findings(evidence), "arenas"));
  evidence.summary_->values_[Field("cpu_count")] = 2;
  assert(!Find(Findings(evidence), "arenas"));

  // A list cut at the limit has the largest mappings only: say so.
  evidence.snapshot_->truncated_ = true;
  result = Findings(evidence);
  assert(Skips(result, "small_vmas") && Skips(result, "arenas"));
  evidence.snapshot_.reset();
  assert(Skips(Findings(evidence), "stale_library"));
}

ResourcePoint Point(double p_ts, std::int64_t p_rss)
{
  ResourcePoint point;
  point.ts_ = p_ts;
  point.rss_bytes_ = p_rss;
  point.swap_bytes_ = 0;
  point.host_some_pct_ = 0;
  point.host_full_pct_ = 0;
  return point;
}

void Trends()
{
  auto evidence = Quiet();
  assert(Skips(Findings(evidence), "rss_growth"));  // no samples at all

  // 10 minutes in 5 s steps. 2 MiB per minute, in every step.
  const auto grow = [&](double p_mib_per_minute, double p_rising_share)
  {
    evidence.resources_.clear();
    std::int64_t rss = 500 * static_cast<std::int64_t>(kMiB);
    for (int step = 0; step <= 120; ++step)
    {
      const bool rises = step % 10 < static_cast<int>(p_rising_share * 10);
      rss += rises ? static_cast<std::int64_t>(p_mib_per_minute * kMiB / 12 /
                                               p_rising_share)
                   : -1;
      evidence.resources_.push_back(Point(kAt - 600 + step * 5, rss));
    }
  };
  grow(2, 1);
  assert(Find(Findings(evidence), "rss_growth"));
  grow(0.5, 1);  // rises in every step but slowly
  assert(!Find(Findings(evidence), "rss_growth"));
  grow(2, 0.5);  // fast, but it falls half of the time: a plateau
  assert(!Find(Findings(evidence), "rss_growth"));
  grow(0, 1);
  evidence.resources_.resize(4);  // too few samples to say
  assert(Skips(Findings(evidence), "rss_growth"));

  // Pressure: any "full", or "some" above 10 %.
  grow(0, 1);
  assert(!Find(Findings(evidence), "memory_pressure"));
  evidence.resources_.back().cgroup_some_pct_ = 12;
  assert(Find(Findings(evidence), "memory_pressure"));
  evidence.resources_.back().cgroup_some_pct_ = 0;
  evidence.resources_.back().host_full_pct_ = 0.5;
  assert(Find(Findings(evidence), "memory_pressure")->title_.contains("full"));
  evidence.resources_.back().host_full_pct_ = 0;

  // Swap in use and rising.
  evidence.resources_.front().swap_bytes_ = 100;
  evidence.resources_.back().swap_bytes_ = 100;
  assert(!Find(Findings(evidence), "swap"));
  evidence.resources_.back().swap_bytes_ = 5 * kMiB;
  assert(Find(Findings(evidence), "swap"));

  // The cgroup: 90 % of the limit, or events at the limit.
  evidence.resources_.back().cgroup_max_ = 1000;
  evidence.resources_.back().cgroup_current_ = 950;
  assert(Find(Findings(evidence), "cgroup")->severity_ == Severity::Warning);
  evidence.resources_.back().cgroup_current_ = 100;
  assert(!Find(Findings(evidence), "cgroup"));
  evidence.resources_.back().cgroup_oom_kills_ = 1;
  assert(Find(Findings(evidence), "cgroup")->severity_ == Severity::Critical);
  evidence.resources_.back().cgroup_oom_kills_ = 0;
  // "max" (no limit) is a huge number, not 90 % of anything.
  evidence.resources_.back().cgroup_max_ = std::int64_t{1} << 62;
  evidence.resources_.back().cgroup_current_ = std::int64_t{1} << 61;
  assert(!Find(Findings(evidence), "cgroup"));
}

void Faults()
{
  auto evidence = Quiet();
  assert(Skips(Findings(evidence), "major_faults"));
  const auto minute = static_cast<std::int64_t>(kAt / 60);
  // A quiet hour: 60 faults a minute (1 per second).
  for (std::int64_t offset = 0; offset < 55; ++offset)
  {
    evidence.major_faults_[minute - offset] = 60;
  }
  assert(!Find(Findings(evidence), "major_faults"));
  // The last 5 minutes: 1200 faults a minute (20 per second), 20 times more.
  for (std::int64_t offset = 0; offset < 5; ++offset)
  {
    evidence.major_faults_[minute - offset] = 1200;
  }
  assert(Find(Findings(evidence), "major_faults"));
  // A busy hour: 20 per second is the normal rate, so nothing rose.
  for (auto& [key, count] : evidence.major_faults_)
  {
    count = 1200;
  }
  assert(!Find(Findings(evidence), "major_faults"));
  // Few faults are never a finding, however much they rose.
  for (auto& [key, count] : evidence.major_faults_)
  {
    count = key >= minute - 4 ? 300 : 0;  // 5 per second against 0
  }
  assert(!Find(Findings(evidence), "major_faults"));
}

void Order()
{
  auto evidence = Quiet();
  evidence.summary_->values_[Field("vma_count")] = 52'500;          // warning
  evidence.summary_->values_[Field("vm_size_bytes")] = 900 * kMiB;  // warning
  evidence.summary_->values_[Field("stack_end")] =
      0x7ffc'0000'0000ULL + 7 * kMiB;  // critical
  const auto result = Findings(evidence);
  assert(result.findings_.size() == 3);
  assert(result.findings_.front().id_ == "stack");
}

// ---- A round trip through day files ----------------------------------------

struct TemporaryDirectory
{
  std::filesystem::path path_;
  TemporaryDirectory()
  {
    std::string pattern =
        (std::filesystem::temp_directory_path() / "memory-report-XXXXXX")
            .string();
    assert(::mkdtemp(pattern.data()) != nullptr);
    path_ = pattern;
  }
  ~TemporaryDirectory()
  {
    std::error_code error;
    std::filesystem::remove_all(path_, error);
  }
};

void Exec(sqlite3* p_database, const std::string& p_sql)
{
  using namespace triangulator::collector;
  const auto done = Execute(p_database, p_sql);
  if (!done)
  {
    std::cerr << p_sql << ": " << done.error() << '\n';
  }
  assert(done);
}

void DayFileRoundTrip()
{
  using namespace triangulator::collector;
  TemporaryDirectory directory;
  const auto day = UtcDay(kAt);
  const auto path = directory.path_ / std::format("{:%F}.sqlite3", day);
  {
    auto database = OpenDatabase(path, false);
    assert(database);
    auto* handle = database->get();
    Exec(handle, std::string{kSchema});
    Exec(handle, ResourceTableSql());
    Exec(handle, MemoryTableSql());
    // A summary 5 s ago: 90 % of vm.max_map_count. Other fields are NULL.
    Exec(handle,
         std::format("INSERT INTO vm_summary(ts,session,pid,generation,flags,"
                     "vma_count,max_map_count) VALUES ({},'1',50,1,0,59000,"
                     "65530)",
                     kAt - 5));
    // An older summary of another process must not win.
    Exec(handle,
         std::format("INSERT INTO vm_summary(ts,session,pid,generation,flags,"
                     "vma_count,max_map_count) VALUES ({},'0',49,1,0,5,65530)",
                     kAt - 1));
    // "No target" (pid 0) is newer than everything and must not be chosen.
    Exec(handle,
         std::format("INSERT INTO vm_summary(ts,session,pid,generation,flags) "
                     "VALUES ({},'2',0,1,2)",
                     kAt - 0.5));
    // A stored list: a deleted library and a writable executable mapping.
    Exec(handle,
         std::format(
             "INSERT INTO vm_snapshot VALUES ({},'1',50,1,2,0,'[]','"
             "[[\"7f0000000000\",\"7f0000001000\",4096,0,1,\"8:1\",\"r-xp\","
             "\"file\",0,1,\"/usr/lib/libold.so\"],[\"7f1000000000\","
             "\"7f1000002000\",8192,0,0,\"0:0\",\"rwxp\",\"anonymous\",0,0,"
             "\"\"]]')",
             kAt - 60));
    // Resource samples: swap rising, and memory pressure now.
    for (int step = 0; step <= 120; ++step)
    {
      Exec(handle,
           std::format(
               "INSERT INTO resource_sample(ts,session,sequence,pid,rss_bytes,"
               "swap_bytes,host_memory_some_pct,flags,cgroup,sockets,"
               "sockets_complete) VALUES ({},'1',{},50,1000,{},{},0,'','[]',1)",
               kAt - 600 + step * 5, step, step == 0 ? 10 : 1000,
               step >= 118 ? 25 : 0));
    }
  }
  const auto result = Report(directory.path_, 0, kAt);
  assert(result.Find("available")->AsBool());
  assert(result.Find("pid")->AsInt() == 50);
  std::vector<std::string> ids;
  for (const auto& finding : result.Find("findings")->AsArray())
  {
    ids.push_back(finding.Find("id")->AsString());
  }
  const auto has = [&](std::string_view p_id)
  {
    return std::ranges::find(ids, p_id) != ids.end();
  };
  assert(has("vma_count"));
  assert(has("stale_library"));
  assert(has("writable_executable"));
  assert(has("swap"));
  assert(has("memory_pressure"));
  assert(!result.Find("read_error")->AsBool());

  // Looking back: before the first sample there is nothing to report.
  const auto before = Report(directory.path_, 0, kAt - 86400 * 2);
  assert(!before.Find("available")->AsBool());
  // The report does not change the files: a second call gives the same.
  assert(DumpJson(Report(directory.path_, 50, kAt)) == DumpJson(result));
  // An empty directory is "nothing recorded", not a failure.
  TemporaryDirectory empty;
  assert(!Report(empty.path_, 0, kAt).Find("available")->AsBool());
}
}  // namespace

int main()
{
  Limits();
  Snapshots();
  Trends();
  Faults();
  Order();
  DayFileRoundTrip();
  std::cout << "memory report tests passed\n";
}
