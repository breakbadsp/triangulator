#include <sys/random.h>

#include <algorithm>
#include <cassert>
#include <csignal>
#include <cstring>
#include <expected>
#include <format>
#include <memory>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

#include "budget.hpp"
#include "config_watch.hpp"
#include "discovery.hpp"
#include "exit_status.hpp"
#include "kernel_log.hpp"
#include "memory.hpp"
#include "proc.hpp"
#include "process_info.hpp"
#include "resources.hpp"
#include "schedule.hpp"

// The Makefile sets this from "git describe". A build outside it reports
// "unknown".
#ifndef TRIANGULATOR_VERSION
#define TRIANGULATOR_VERSION "unknown"
#endif

namespace triangulator
{
namespace
{

constexpr std::string_view kVersion = TRIANGULATOR_VERSION;

volatile std::sig_atomic_t reload_requested = 0;
volatile std::sig_atomic_t stop_requested = 0;

extern "C" void OnSignal(int p_number)
{
  if (p_number == SIGHUP)
  {
    reload_requested = 1;
  }
  else
  {
    stop_requested = 1;
  }
}

[[nodiscard]] std::expected<void, std::error_code> InstallSignalHandlers()
{
  struct sigaction action{};
  action.sa_handler = OnSignal;
  ::sigemptyset(&action.sa_mask);
  for (const auto number : {SIGHUP, SIGINT, SIGTERM})
  {
    if (::sigaction(number, &action, nullptr) != 0)
    {
      return std::unexpected(std::error_code{errno, std::generic_category()});
    }
  }
  // A warning to a pipe whose reader has gone then fails with EPIPE, and
  // does not end the sampler.
  struct sigaction ignore{};
  ignore.sa_handler = SIG_IGN;
  ::sigemptyset(&ignore.sa_mask);
  if (::sigaction(SIGPIPE, &ignore, nullptr) != 0)
  {
    return std::unexpected(std::error_code{errno, std::generic_category()});
  }
  return {};
}

// A random session id. getrandom can fail (for example ENOSYS on a kernel
// older than 3.17).
[[nodiscard]] std::expected<std::uint64_t, std::error_code> NewSession()
{
  std::uint64_t session{};
  auto bytes = std::as_writable_bytes(std::span{&session, 1});
  while (!bytes.empty())
  {
    const auto length = ::getrandom(bytes.data(), bytes.size(), GRND_NONBLOCK);
    if (length < 0 && errno == EINTR)
    {
      continue;
    }
    if (length <= 0)
    {
      return std::unexpected(
          std::error_code{length == 0 ? EIO : errno, std::generic_category()});
    }
    bytes = bytes.subspan(static_cast<std::size_t>(length));
  }
  return session == 0 ? 1 : session;
}

class TargetSampler final
{
 public:
  TargetSampler(RuntimeConfig& p_config, DescriptorBudget& p_budget,
                RateLimitedLogger& p_logger, const std::array<char, 64>& p_host)
      : config_(p_config), threads_(p_budget), logger_(p_logger), host_(p_host)
  {
    // Assign() then never allocates for an ID.
    id_.reserve(target_wire::kMaxIdBytes);
  }

  [[nodiscard]] std::expected<void, std::string> Initialize()
  {
    return ResetSession();
  }

  void AnnounceNextTick() noexcept
  {
    next_announcement_ = Nanoseconds{0};
  }

  // Gives this sampler to another discovered target: a new ID and a new
  // session, with nothing of the previous target kept.
  [[nodiscard]] std::expected<void, std::string> Assign(std::string_view p_id)
  {
    id_.assign(p_id);
    previous_target_.reset();
    exit_status_.Stop();
    exit_report_sends_ = 0;
    record_count_ = 0;
    flags_ = 0;
    release_previous_session_ = 0;
    return ResetSession();
  }

  // This target is served on every p_stride-th loop tick.
  void SetStride(std::uint32_t p_stride) noexcept
  {
    stride_ = p_stride;
  }

  // Whether critical_names protects this target. Only the monitoring log
  // line reads it.
  void SetCritical(bool p_critical) noexcept
  {
    critical_ = p_critical;
  }

  // The target_wire flags of the next announcements. A change, and each
  // tick of a release, is announced at once.
  void SetFlags(std::uint8_t p_flags) noexcept
  {
    if (p_flags != flags_)
    {
      flags_ = p_flags;
      next_announcement_ = Nanoseconds{0};
    }
  }

  // A selector-mode switch removes this old identity. Its history stays in
  // the collector, and delayed release packets can name only this session.
  void Release()
  {
    SetFlags(static_cast<std::uint8_t>(flags_ | target_wire::kReleased));
    StepAnnouncement(previous_target_, ClockNow(CLOCK_MONOTONIC));
  }

  // Whether this target was found this tick, so it can take a heavy scan.
  [[nodiscard]] bool HasTarget() const noexcept
  {
    return previous_target_.has_value();
  }

  // A memory-map sample is busy, or due within half a tick.
  [[nodiscard]] bool MemoryDue(Nanoseconds p_now) const
  {
    return previous_target_ && MemoryInterval() > Nanoseconds{0} &&
           (memory_.Busy() || p_now + config_.Interval() / 2 >= next_memory_);
  }

  [[nodiscard]] bool MemoryBusy() const noexcept
  {
    return memory_.Busy();
  }

  void ScanMemory(Nanoseconds p_now)
  {
    if (previous_target_)
    {
      StepMemory(*previous_target_, p_now);
    }
  }

  void ScanResources()
  {
    if (previous_target_)
    {
      SendResources(*previous_target_);
    }
  }

  [[nodiscard]] std::expected<void, std::string> SampleTick(
      const std::optional<TargetIdentity>& p_target,
      Nanoseconds p_exit_deadline)
  {
    if (p_target != previous_target_)
    {
      // records_ still holds the ended target's last tick here.
      bool reported = false;
      if (previous_target_)
      {
        const auto ended = ProcessEnded(*previous_target_);
        if (!ended)
        {
          // The stat read could not decide, for example for lack of
          // descriptors or a permission error. Keep the old target and its
          // last tick, skip this tick as for a failed lookup, and ask again
          // at the next one: no exit report for a process that may live.
          logger_.Warn(
              "cannot tell whether PID {} ended: {}; tick skipped, will "
              "check again",
              previous_target_->pid_, ended.error());
          return {};
        }
        if (*ended)
        {
          // As for StepMemory(): a quarter of a tick, at most 50 ms.
          exit_report_ = kernel_log_.Collect(
              *previous_target_, std::span{records_}.first(record_count_),
              ClockNow(CLOCK_REALTIME), logger_,
              std::max<Nanoseconds>(
                  Nanoseconds{0}, p_exit_deadline - ClockNow(CLOCK_MONOTONIC)));
          if (const auto status = exit_status_.Collect(*previous_target_))
          {
            exit_report_.wait_status_ = *status;
            exit_report_.exit_status_ = exit_wire::ExitStatus::Known;
          }
          lifecycle_.Log("target {}: PID {} ended", id_,
                         previous_target_->pid_);
          exit_report_.ended_session_ = session_;
          exit_report_sends_ = kExitReportSends;
          reported = true;
        }
      }
      release_previous_session_ = session_;
      if (auto reset = ResetSession(); !reset)
      {
        return reset;
      }
      if (reported)
      {
        exit_report_.next_session_ = session_;
      }
      previous_target_ = p_target;
      if (p_target)
      {
        kernel_log_.Watch(logger_);
        exit_status_.Watch(*p_target);
      }
      else
      {
        exit_status_.Stop();
      }
    }
    const auto monotonic = ClockNow(CLOCK_MONOTONIC);
    const auto wall = ClockNow(CLOCK_REALTIME);
    const auto pid = p_target ? p_target->pid_ : 0;
    std::size_t count = 0;
    std::size_t sleeping_without_wchan = 0;
    if (p_target)
    {
      threads_.Rescan(pid, logger_);
      for (auto& thread : threads_.Threads())
      {
        if (auto sample = thread.TakeSample(
                pid, config_.settings_.status_fallback_, logger_))
        {
          records_[count++] = sample->record_;
          sleeping_without_wchan +=
              static_cast<std::size_t>(sample->wchan_hidden_);
        }
      }
      if (count && count == sleeping_without_wchan)
      {
        logger_.Warn(
            "wchan hidden for every sleeping thread; run the sampler as the "
            "target's UID");
      }
    }
    StepAnnouncement(p_target, monotonic);
    SendTick(pid, monotonic, wall, std::span{records_}.first(count));
    record_count_ = count;
    if (p_target)
    {
      kernel_log_.Note(std::span{records_}.first(count));
    }
    if (exit_report_sends_ > 0)
    {
      --exit_report_sends_;
      SendPart(wire::AsBytes(exit_report_), "exit report");
    }
    if (p_target)
    {
      StepProcessInfo(*p_target, monotonic);
    }
    return {};
  }

 private:
  void StepAnnouncement(const std::optional<TargetIdentity>& p_target,
                        Nanoseconds p_monotonic)
  {
    const auto loop_rate = config_.effective_rate_hz_ > 0
                               ? config_.effective_rate_hz_
                               : config_.settings_.rate_hz_;
    const auto effective_millihz =
        static_cast<std::uint32_t>(std::lround(loop_rate / stride_ * 1000));
    // A changed rate goes out at once, not with the 10 s repeat.
    if (p_monotonic < next_announcement_ &&
        (flags_ & target_wire::kReleased) == 0 &&
        effective_millihz == announced_millihz_)
    {
      return;
    }
    target_wire::Packet packet;
    packet.flags_ = flags_;
    packet.excluded_ = config_.excluded_;
    packet.session_ = session_;
    target_wire::SetText(packet.target_, id_);
    packet.host_ = host_;
    packet.configured_millihz_ = static_cast<std::uint32_t>(
        std::lround(config_.settings_.rate_hz_ * 1000));
    packet.effective_millihz_ = effective_millihz;
    packet.cpu_ns_ = config_.sampler_cpu_ns_;
    packet.elapsed_ns_ = config_.sampler_elapsed_ns_;
    packet.budget_basis_points_ = static_cast<std::uint32_t>(
        std::lround(config_.settings_.cpu_budget_pct_ * 100));
    if (p_target)
    {
      packet.pid_ = static_cast<std::uint32_t>(p_target->pid_);
      packet.process_start_ = p_target->starttime_;
      const auto io =
          OpenReadonly(FixedString{"/proc/{}/io", p_target->pid_}.CStr());
      const auto maps =
          OpenReadonly(FixedString{"/proc/{}/maps", p_target->pid_}.CStr());
      if (!io || !maps)
      {
        packet.access_ = target_wire::Access::Limited;
      }
    }
    SendPart(wire::AsBytes(packet), "target announcement");
    if ((flags_ & target_wire::kReleased) != 0 &&
        release_previous_session_ != 0)
    {
      packet.session_ = release_previous_session_;
      SendPart(wire::AsBytes(packet), "previous target release");
    }
    announced_millihz_ = effective_millihz;
    next_announcement_ = p_monotonic + 10s;
  }

  // Sends what the target is (command line, executable, owner and so on).
  // It is read again for each send, every kProcessInfoInterval: exec,
  // chdir, credential and affinity changes keep the PID and start time, so
  // a copy from the session start can be wrong. Datagrams are not
  // acknowledged, and a collector that started later has not seen it. One
  // read costs about 25 us.
  void StepProcessInfo(const TargetIdentity& p_target, Nanoseconds p_monotonic)
  {
    // Half a tick of slack, as for resources.
    if (p_monotonic + config_.Interval() / 2 < next_process_info_)
    {
      return;
    }
    process_info_ =
        process_info_probe_.Read(p_target.pid_, p_target.starttime_);
    if (!monitoring_logged_)
    {
      monitoring_logged_ = true;
      lifecycle_.Log(
          "target {}: monitoring PID {} ({}){}", id_, p_target.pid_,
          process_wire::Text(LogName(MainThreadName(p_target), process_info_)),
          critical_ ? " critical=true" : "");
    }
    process_info_.session_ = session_;
    process_info_.monotonic_ns_ =
        static_cast<std::uint64_t>(p_monotonic.count());
    process_info_.wall_ns_ =
        static_cast<std::uint64_t>(ClockNow(CLOCK_REALTIME).count());
    SendPart(process_wire::Encode(process_info_), "process info");
    next_process_info_ =
        NextDeadline(next_process_info_, p_monotonic, kProcessInfoInterval);
  }

  // The process name from this tick's main-thread record, so the log needs
  // no extra /proc read. Empty when the main thread was not sampled.
  [[nodiscard]] std::string_view MainThreadName(
      const TargetIdentity& p_target) const
  {
    const auto records = std::span{records_}.first(record_count_);
    const auto main_thread =
        std::ranges::find(records, static_cast<std::uint32_t>(p_target.pid_),
                          &wire::Record::tid_);
    if (main_thread == records.end())
    {
      return {};
    }
    const auto& comm = main_thread->comm_;
    return {comm.data(), static_cast<std::size_t>(
                             std::ranges::find(comm, '\0') - comm.begin())};
  }

  // Time between memory-map samples, as for ResourceInterval().
  [[nodiscard]] Nanoseconds MemoryInterval() const noexcept
  {
    const auto seconds = config_.settings_.memory_interval_s_;
    if (seconds == 0)
    {
      return Nanoseconds{0};
    }
    return std::max<Nanoseconds>(std::chrono::seconds{seconds},
                                 config_.Interval());
  }

  // How often an unchanged layout is sent again: every 10 samples, but at
  // least once a minute, so a collector that started later or lost a part
  // gets it soon. Datagrams are not acknowledged.
  [[nodiscard]] Nanoseconds LayoutRefreshInterval() const noexcept
  {
    return std::min<Nanoseconds>(10 * MemoryInterval(), 60s);
  }

  // Starts a memory-map sample when one is due, and reads more of maps in
  // the time left in this tick. A large target's maps can take several
  // ticks; thread ticks stay on time.
  void StepMemory(const TargetIdentity& p_target, Nanoseconds p_monotonic)
  {
    const auto interval = MemoryInterval();
    if (interval == Nanoseconds{0})
    {
      return;
    }
    // A quarter of a tick, at most 50 ms, including the summary reads in
    // Start(): the rest of the tick stays free for the sleep before the
    // next thread sample. When Start() used it all, maps is read next tick.
    const auto tick = config_.Interval();
    const auto deadline =
        ClockNow(CLOCK_MONOTONIC) + std::min<Nanoseconds>(tick / 4, 50ms);
    if (!memory_.Busy())
    {
      // Half an interval of slack, as for the samples themselves.
      if (p_monotonic + tick / 2 < next_memory_)
      {
        return;
      }
      // Only a sample that reads maps can carry the layout.
      const bool refresh_layout =
          memory_.NextReadsMaps() && p_monotonic + interval / 2 >= next_layout_;
      if (refresh_layout)
      {
        next_layout_ =
            NextDeadline(next_layout_, p_monotonic, LayoutRefreshInterval());
      }
      memory_.Start(p_target.pid_, refresh_layout);
      next_memory_ = NextDeadline(next_memory_, p_monotonic, interval);
    }
    if (const auto sample = memory_.Continue(deadline))
    {
      SendMemory(p_target, *sample);
    }
  }

  // Sends one memory-map sample: the summary, then the layout regions when
  // the sample has them.
  void SendMemory(const TargetIdentity& p_target, const MemorySample& p_sample)
  {
    const auto monotonic = ClockNow(CLOCK_MONOTONIC);
    const auto wall = ClockNow(CLOCK_REALTIME);
    const memory_wire::Header header{
        .parts_ = memory_wire::PartCount(p_sample.regions_.size()),
        .session_ = session_,
        .sequence_ = memory_sequence_++,
        .monotonic_ns_ = static_cast<std::uint64_t>(monotonic.count()),
        .wall_ns_ = static_cast<std::uint64_t>(wall.count()),
        .interval_ms_ = static_cast<std::uint32_t>(
            std::chrono::round<std::chrono::milliseconds>(MemoryInterval())
                .count()),
        .pid_ = static_cast<std::uint32_t>(p_target.pid_),
        .process_start_ = p_target.starttime_,
        .flags_ = p_sample.flags_,
    };
    SendPart(std::span{memory_packet_}.first(memory_wire::EncodeSummary(
                 memory_packet_, header, p_sample.summary_)),
             "memory-map sample");
    for (std::uint8_t part = 1; part < header.parts_; ++part)
    {
      SendPart(std::span{memory_packet_}.first(memory_wire::EncodeRegions(
                   memory_packet_, header, p_sample.regions_, part)),
               "memory-map sample");
    }
  }

  // Sends one datagram of a slow-rate sample. A full socket buffer drops it
  // quietly, like a lost datagram.
  void SendPart(std::span<const std::byte> p_bytes, std::string_view p_what)
  {
    const auto& endpoint = config_.endpoint_;
    if (::sendto(endpoint.socket_.Get(), p_bytes.data(), p_bytes.size(),
                 MSG_DONTWAIT,
                 reinterpret_cast<const sockaddr*>(&endpoint.address_),
                 endpoint.address_length_) < 0 &&
        errno != EAGAIN && errno != EWOULDBLOCK && errno != ENOBUFS)
    {
      logger_.Warn("UDP send failed; {} dropped", p_what);
    }
  }

  // Time between resource samples: the configured interval, but never less
  // than one thread tick. Zero when they are off.
  [[nodiscard]] Nanoseconds ResourceInterval() const noexcept
  {
    const auto seconds = config_.settings_.resource_interval_s_;
    if (seconds == 0)
    {
      return Nanoseconds{0};
    }
    return std::max<Nanoseconds>(std::chrono::seconds{seconds},
                                 config_.Interval());
  }

  // Sends one resource sample: the summary, then the fullest sockets. It
  // shares the thread ticks' session, so the collector can match the two.
  void SendResources(const TargetIdentity& p_target)
  {
    const auto monotonic = ClockNow(CLOCK_MONOTONIC);
    const auto wall = ClockNow(CLOCK_REALTIME);
    const auto sample = resources_.Sample(p_target.pid_);
    const resource_wire::Header header{
        .parts_ = resource_wire::PartCount(sample.sockets_.size()),
        .session_ = session_,
        .sequence_ = resource_sequence_++,
        .monotonic_ns_ = static_cast<std::uint64_t>(monotonic.count()),
        .wall_ns_ = static_cast<std::uint64_t>(wall.count()),
        .interval_ms_ = static_cast<std::uint32_t>(
            std::chrono::round<std::chrono::milliseconds>(ResourceInterval())
                .count()),
        .pid_ = static_cast<std::uint32_t>(p_target.pid_),
        .process_start_ = p_target.starttime_,
        .flags_ = sample.flags_,
    };
    const auto send = [this](std::size_t p_length)
    {
      SendPart(std::span{resource_packet_}.first(p_length), "resource sample");
    };
    send(resource_wire::EncodeSummary(resource_packet_, header, sample.summary_,
                                      sample.cgroup_));
    for (std::uint8_t part = 1; part < header.parts_; ++part)
    {
      send(resource_wire::EncodeSockets(resource_packet_, header,
                                        sample.sockets_, part));
    }
  }

  [[nodiscard]] std::expected<void, std::string> ResetSession()
  {
    const auto session = NewSession();
    if (!session)
    {
      return std::unexpected(
          std::format("getrandom: {}", session.error().message()));
    }
    threads_.Clear();
    session_ = *session;
    sequence_ = 0;
    resource_sequence_ = 0;
    memory_.Reset();
    memory_sequence_ = 0;
    next_memory_ = Nanoseconds{0};
    next_layout_ = Nanoseconds{0};
    next_process_info_ = Nanoseconds{0};
    next_announcement_ = Nanoseconds{0};
    monitoring_logged_ = false;
    return {};
  }

  void SendTick(int p_pid, Nanoseconds p_monotonic, Nanoseconds p_wall,
                std::span<const wire::Record> p_records)
  {
    const auto chunks = std::max(
        std::size_t{1}, (p_records.size() + wire::kRecordsPerPacket - 1) /
                            wire::kRecordsPerPacket);
    for (std::size_t chunk = 0; chunk < chunks; ++chunk)
    {
      const auto offset = chunk * wire::kRecordsPerPacket;
      const auto count =
          std::min(p_records.size() - offset, wire::kRecordsPerPacket);
      const auto flags =
          (p_pid ? wire::Flags::None : wire::Flags::TargetAbsent) |
          (config_.settings_.status_fallback_ ? wire::Flags::StatusFallback
                                              : wire::Flags::None);
      wire::Packet packet{
          .header_ = {
              .flags_ = flags,
              .chunk_ = static_cast<std::uint8_t>(chunk),
              .chunks_ = static_cast<std::uint8_t>(chunks),
              .session_ = session_,
              .sequence_ = sequence_,
              .records_ = static_cast<std::uint16_t>(count),
              .monotonic_ns_ = static_cast<std::uint64_t>(p_monotonic.count()),
              .wall_ns_ = static_cast<std::uint64_t>(p_wall.count()),
              .interval_ms_ = TickIntervalMs(config_.Interval(), stride_),
              .pid_ = static_cast<std::uint32_t>(p_pid),
          }};
      std::ranges::copy(p_records.subspan(offset, count),
                        packet.records_.begin());
      const auto& endpoint = config_.endpoint_;
      if (::sendto(endpoint.socket_.Get(), &packet, wire::DatagramSize(count),
                   MSG_DONTWAIT,
                   reinterpret_cast<const sockaddr*>(&endpoint.address_),
                   endpoint.address_length_) < 0 &&
          errno != EAGAIN && errno != EWOULDBLOCK && errno != ENOBUFS)
      {
        logger_.Warn("UDP send failed; samples dropped");
      }
    }
    ++sequence_;
  }

  // Datagrams are not acknowledged, so an exit report goes out with this
  // many ticks; the collector keeps the first copy that arrives.
  static constexpr int kExitReportSends = 5;

  // How often the process info is read and sent.
  static constexpr Nanoseconds kProcessInfoInterval =
      std::chrono::seconds{process_wire::kRepeatSeconds};

  RuntimeConfig& config_;
  std::string id_;
  ThreadCache threads_;
  std::array<wire::Record, wire::kMaxThreads> records_{};
  std::size_t record_count_ = 0;  // records_ filled by the last tick
  KernelLog kernel_log_;
  ExitStatusWatch exit_status_;
  exit_wire::Report exit_report_{};
  int exit_report_sends_ = 0;
  RateLimitedLogger& logger_;
  LifecycleLogger lifecycle_;
  bool monitoring_logged_ = false;  // for the current session
  std::array<char, 64> host_{};
  Nanoseconds next_announcement_{0};
  std::uint32_t announced_millihz_ = 0;
  std::uint32_t stride_ = 1;
  bool critical_ = false;
  std::optional<TargetIdentity> previous_target_;
  std::uint64_t session_ = 0;  // set by ResetSession() when Run() starts
  std::uint64_t release_previous_session_ = 0;
  std::uint8_t flags_ = 0;  // target_wire flags; 0 for a target table
  std::uint32_t sequence_ = 0;
  ResourceProbe resources_;
  std::array<std::byte, resource_wire::kMaxPartSize> resource_packet_{};
  std::uint32_t resource_sequence_ = 0;
  MemoryProbe memory_;
  std::array<std::byte, memory_wire::kMaxPartSize> memory_packet_{};
  std::uint32_t memory_sequence_ = 0;
  Nanoseconds next_memory_{0};
  Nanoseconds next_layout_{0};
  ProcessInfoProbe process_info_probe_;
  process_wire::Packet process_info_{};
  Nanoseconds next_process_info_{0};
};

// One process and one monotonic loop handle every configured target.
class Sampler final
{
 public:
  Sampler(RuntimeConfig p_config, std::size_t p_descriptor_limit)
      : config_(std::move(p_config)),
        budget_{p_descriptor_limit > 3 * target_wire::kMaxTargets
                    ? p_descriptor_limit - 3 * target_wire::kMaxTargets
                    : 0,
                0},
        cpu_budget_(MakeCpuBudget(config_.settings_))
  {
    if (::gethostname(host_.data(), host_.size() - 1) != 0 ||
        !target_wire::ValidName(target_wire::Text(host_), 63))
    {
      target_wire::SetText(host_, "unknown-host");
    }
  }

  [[nodiscard]] std::expected<void, std::string> Run(const char* p_config_path)
  {
    if (auto prepared = PreparePool(false); !prepared)
    {
      return prepared;
    }
    LogTargets(std::format("triangulator-sampler {} started", kVersion));
    ConfigWatch watch{p_config_path};
    auto deadline = ClockNow(CLOCK_MONOTONIC);
#ifndef TRIANGULATOR_CAPACITY_BENCHMARK
    auto last_elapsed = deadline;
    auto last_cpu = ClockNow(CLOCK_THREAD_CPUTIME_ID);
#endif
    while (!stop_requested)
    {
      // A control wake can precede the tick deadline. Start its tick here
      // so the old deadline cannot delay sampling after a rate increase.
      deadline = std::min(deadline, ClockNow(CLOCK_MONOTONIC));
      const bool signal = reload_requested != 0;
      reload_requested = 0;
      if (watch.Poll(signal, ClockNow(CLOCK_MONOTONIC), logger_))
      {
        watch.Reloaded(ClockNow(CLOCK_MONOTONIC));
        auto applied = Reload(p_config_path);
        if (!applied)
        {
          return std::unexpected(applied.error());
        }
#ifndef TRIANGULATOR_CAPACITY_BENCHMARK
        if (*applied)
        {
          last_elapsed = ClockNow(CLOCK_MONOTONIC);
          last_cpu = ClockNow(CLOCK_THREAD_CPUTIME_ID);
        }
#endif
      }
      const auto exit_deadline =
          ClockNow(CLOCK_MONOTONIC) +
          std::min<Nanoseconds>(config_.Interval() / 4, 50ms);
      const auto stride = cpu_budget_.Stride();
      if (auto sampled = SampleDiscovered(exit_deadline, stride); !sampled)
      {
        return sampled;
      }
      StepHeavy(live_);
#ifndef TRIANGULATOR_CAPACITY_BENCHMARK
      const auto end = ClockNow(CLOCK_MONOTONIC);
      const auto cpu = ClockNow(CLOCK_THREAD_CPUTIME_ID);
      const auto live = LiveTargets();
      cpu_budget_.Add(cpu - last_cpu, end - last_elapsed, live.critical_,
                      live.other_);
      last_cpu = cpu;
      last_elapsed = end;
      config_.effective_rate_hz_ = cpu_budget_.RateHz();
      config_.sampler_cpu_ns_ =
          static_cast<std::uint64_t>(cpu_budget_.Cpu().count());
      config_.sampler_elapsed_ns_ =
          static_cast<std::uint64_t>(cpu_budget_.Elapsed().count());
      const auto interval = config_.Interval();
      deadline += interval;
      if (deadline <= end)
      {
        deadline += interval * ((end - deadline) / interval + 1);
      }
      SleepUntil(watch.Deadline(deadline));
#endif
    }
    return {};
  }

 private:
  RuntimeConfig config_;
  DescriptorBudget budget_;
  CpuBudget cpu_budget_;
  RateLimitedLogger logger_;
  std::array<char, 64> host_{};
  Discovery discovery_;
  // One sampler for each discovery slot, made at startup or reload.
  std::vector<std::unique_ptr<TargetSampler>> pool_;
  HeavySchedule heavy_schedule_;
  std::size_t memory_cursor_ = 0;
  // Slots sampled with a process. A slot skipped by its stride keeps the
  // value of its last served tick.
  std::array<bool, target_wire::kMaxTargets> live_{};
  std::uint64_t tick_ = 0;

  [[nodiscard]] static CpuBudget MakeCpuBudget(const Config& p_settings)
  {
    return CpuBudget{p_settings.rate_hz_, p_settings.cpu_budget_pct_,
                     p_settings.critical_extra_budget_pct_};
  }

  struct LiveKinds
  {
    bool critical_ = false;
    bool other_ = false;
  };

  // A waiting slot of a critical name has no process, so it is not live.
  [[nodiscard]] LiveKinds LiveTargets() noexcept
  {
    LiveKinds kinds;
    const auto slots = discovery_.Used();
    for (std::size_t index = 0; index < slots.size(); ++index)
    {
      if (live_[index] && pool_[index]->HasTarget())
      {
        (IsCritical(config_.settings_, slots[index]) ? kinds.critical_
                                                     : kinds.other_) = true;
      }
    }
    return kinds;
  }

  // Reads the configuration file again. The value is false when the file
  // was invalid and the previous configuration stays.
  [[nodiscard]] std::expected<bool, std::string> Reload(const char* p_path)
  {
    auto next = LoadConfig(p_path);
    if (!next)
    {
      // The operator just edited the file and is looking for this line.
      logger_.AllowNext();
      logger_.Warn("invalid configuration; keeping the previous one: {}",
                   next.error());
      return false;
    }
    const auto& before = config_.settings_;
    const auto& after = next->settings_;
    const bool keep_sessions =
        before.rate_hz_ == after.rate_hz_ &&
        before.cpu_budget_pct_ == after.cpu_budget_pct_ &&
        before.collector_ == after.collector_ &&
        before.status_fallback_ == after.status_fallback_ &&
        before.resource_interval_s_ == after.resource_interval_s_ &&
        before.memory_interval_s_ == after.memory_interval_s_;
    // Release through the old endpoint, while the actual sessions still exist.
    // Configure() can erase slots above a reduced discovery capacity.
    for (std::size_t index = 0; index < pool_.size(); ++index)
    {
      if ((!keep_sessions || index >= after.max_targets_) &&
          discovery_.Used()[index].state_ != SlotState::Free)
      {
        pool_[index]->Release();
      }
    }
    const bool same_critical =
        before.critical_names_ == after.critical_names_ &&
        before.critical_extra_budget_pct_ == after.critical_extra_budget_pct_;
    if (!keep_sessions || !same_critical)
    {
      cpu_budget_ = MakeCpuBudget(after);
    }
    config_ = std::move(*next);
    config_.effective_rate_hz_ = cpu_budget_.RateHz();
    if (auto prepared = PreparePool(keep_sessions); !prepared)
    {
      return std::unexpected(prepared.error());
    }
    LogTargets("configuration reloaded");
    return true;
  }

  // Tells the operator what the sampler does now. It writes to the sink
  // directly, not through logger_, so the 60 s warning limit cannot hide it.
  void LogTargets(std::string_view p_event) const
  {
    const auto& settings = config_.settings_;
    std::array<char, 256> line{};
    const auto result = std::format_to_n(line.data(), line.size(),
                                         "{}; discovery, up to {} targets",
                                         p_event, settings.max_targets_);
    StderrSink().Write(
        {line.data(),
         std::min(static_cast<std::size_t>(result.size), line.size())});
  }

  // Discovery: one bounded part of a /proc pass, then one tick for each
  // used slot. A stat read per instance detects an exit or a reused PID. A
  // non-critical slot is served on every p_stride-th tick only, and does
  // nothing on the others: its own sequence numbers and interval_ms then
  // describe the slower rate to the collector.
  [[nodiscard]] std::expected<void, std::string> SampleDiscovered(
      Nanoseconds p_exit_deadline, std::uint32_t p_stride)
  {
    const bool other_tick = tick_++ % p_stride == 0;
    const auto& settings = config_.settings_;
    const auto scanned = discovery_.Scan(settings, ClockNow(CLOCK_MONOTONIC));
    if (!scanned)
    {
      logger_.Warn("process discovery stopped: {}; it starts again later",
                   scanned.error());
    }
    else if (*scanned && discovery_.Excluded() > 0)
    {
      logger_.Warn(
          "{} matching processes are not monitored: all {} slots of "
          "max_targets are in use",
          discovery_.Excluded(), settings.max_targets_);
    }
    const auto previous_excluded = config_.excluded_;
    config_.excluded_ = static_cast<std::uint8_t>(
        std::min<std::uint32_t>(discovery_.Excluded(), 255));
    if (previous_excluded != config_.excluded_)
    {
      for (auto& sampler : pool_)
      {
        sampler->AnnounceNextTick();
      }
    }
    const auto slots = discovery_.Used();
    for (std::size_t index = 0; index < slots.size(); ++index)
    {
      auto& slot = slots[index];
      auto& sampler = *pool_[index];
      if (slot.state_ == SlotState::Free)
      {
        live_[index] = false;
        continue;
      }
      const bool critical = IsCritical(settings, slot);
      if (!critical && !other_tick)
      {
        continue;
      }
      live_[index] = false;
      if (slot.reassigned_)
      {
        slot.reassigned_ = false;
        if (auto assigned = sampler.Assign(slot.id_.data()); !assigned)
        {
          return assigned;
        }
      }
      std::optional<TargetIdentity> identity;
      if (slot.identity_.pid_ != 0)
      {
        const auto found = FindTarget(slot.identity_.pid_);
        if (!found)
        {
          logger_.Warn("target lookup failed: {}; tick skipped, session kept",
                       found.error());
          continue;
        }
        if (*found == slot.identity_)
        {
          identity = slot.identity_;
        }
        else if (slot.state_ == SlotState::Running)
        {
          discovery_.End(settings, index);
        }
        else
        {
          slot.identity_ = {};
        }
      }
      sampler.SetFlags(discovery_.Flags(index));
      sampler.SetStride(critical ? 1 : p_stride);
      sampler.SetCritical(critical);
      if (auto sampled = sampler.SampleTick(identity, p_exit_deadline);
          !sampled)
      {
        return sampled;
      }
      live_[index] = true;
      if (slot.state_ == SlotState::Releasing)
      {
        discovery_.StepRelease(index);
      }
    }
    return {};
  }

  // One heavy scan at most per tick, chosen by the heavy cycle.
  void StepHeavy(std::span<const bool> p_live)
  {
    auto& samplers = pool_;
    const auto now = ClockNow(CLOCK_MONOTONIC);
    std::size_t live_targets = 0;
    bool memory_waiting = false;
    for (std::size_t index = 0; index < samplers.size(); ++index)
    {
      if (p_live[index] && samplers[index]->HasTarget())
      {
        ++live_targets;
        memory_waiting = memory_waiting || samplers[index]->MemoryDue(now);
      }
    }
    const bool resources_on = config_.settings_.resource_interval_s_ > 0;
    const auto resource_target = heavy_schedule_.Next({
        .resource_targets_ = resources_on ? live_targets : 0,
        .memory_waiting_ = memory_waiting,
        .interval_ticks_ =
            resources_on ? IntervalTicks(
                               std::chrono::seconds{
                                   config_.settings_.resource_interval_s_},
                               config_.Interval())
                         : 0,
    });
    if (resource_target)
    {
      ScanResources(p_live, *resource_target);
    }
    else
    {
      ScanMemory(p_live, now);
    }
  }

  // Resources of live target number p_number. A target that ended since the
  // cycle started leaves its position empty.
  void ScanResources(std::span<const bool> p_live, std::size_t p_number)
  {
    auto& samplers = pool_;
    std::size_t number = 0;
    for (std::size_t index = 0; index < samplers.size(); ++index)
    {
      if (p_live[index] && samplers[index]->HasTarget())
      {
        if (number == p_number)
        {
          samplers[index]->ScanResources();
          return;
        }
        ++number;
      }
    }
  }

  // A memory turn: the busy memory-map sample continues, or the next due
  // target in turn starts one. The cursor stays on a busy sample, so only
  // one sample is in progress at a time.
  void ScanMemory(std::span<const bool> p_live, Nanoseconds p_now)
  {
    auto& samplers = pool_;
    for (std::size_t checked = 0; checked < samplers.size(); ++checked)
    {
      const auto index = (memory_cursor_ + checked) % samplers.size();
      auto& sampler = *samplers[index];
      if (p_live[index] && sampler.MemoryDue(p_now))
      {
        sampler.ScanMemory(p_now);
        memory_cursor_ = sampler.MemoryBusy() ? index : index + 1;
        return;
      }
    }
  }

  [[nodiscard]] std::expected<void, std::string> PreparePool(
      bool p_keep_sessions)
  {
    discovery_.Configure(config_.settings_);
    if (!p_keep_sessions)
    {
      pool_.clear();
    }
    if (pool_.size() > config_.settings_.max_targets_)
    {
      pool_.resize(config_.settings_.max_targets_);
    }
    pool_.reserve(config_.settings_.max_targets_);
    for (std::size_t index = pool_.size();
         index < config_.settings_.max_targets_; ++index)
    {
      auto sampler =
          std::make_unique<TargetSampler>(config_, budget_, logger_, host_);
      if (auto initialized = sampler->Initialize(); !initialized)
      {
        return initialized;
      }
      pool_.push_back(std::move(sampler));
    }
    for (auto& slot : discovery_.Used())
    {
      if (!p_keep_sessions)
      {
        slot.reassigned_ = slot.state_ != SlotState::Free;
      }
    }
    heavy_schedule_.Reset();
    memory_cursor_ = 0;
    return {};
  }

  static void SleepUntil(Nanoseconds p_deadline)
  {
    while (!stop_requested && !reload_requested)
    {
      const auto remaining = p_deadline - ClockNow(CLOCK_MONOTONIC);
      if (remaining <= Nanoseconds{0})
      {
        break;
      }
      const auto seconds =
          std::chrono::duration_cast<std::chrono::seconds>(remaining);
      const timespec wait{
          .tv_sec = static_cast<time_t>(seconds.count()),
          .tv_nsec = static_cast<long>((remaining - seconds).count())};
      // ThreadSanitizer intercepts nanosleep so it can deliver signals during
      // the wait. With clock_nanosleep it can defer the handler past EINTR.
      // Recompute from the monotonic deadline after each interruption.
      if (::nanosleep(&wait, nullptr) == 0)
      {
        break;
      }
      [[maybe_unused]] const auto error = errno;
      // The timespec is valid and non-null, so other errors are bugs.
      assert(error == EINTR);
    }
  }
};

}  // namespace
}  // namespace triangulator

int SamplerMain(int p_argc, char** p_argv)
{
#ifdef TRIANGULATOR_CAPACITY_BENCHMARK
  // Only the separate benchmark binary can bypass the production controls.
  if (p_argc == 2 && std::string_view{p_argv[1]} == "--capacity-mode")
  {
    std::puts("capacity-v1: no CPU budget; no deadline wait");
    return 0;
  }
#endif
  if (p_argc == 2 && (std::string_view{p_argv[1]} == "-h" ||
                      std::string_view{p_argv[1]} == "--help"))
  {
    std::puts(
        "usage: triangulator-sampler [--check-config] CONFIG\n"
        "       triangulator-sampler -h|--help\n\n"
        "Read-only Linux process and thread sampler.\n"
        "--check-config validates CONFIG without sampling.");
    return 0;
  }
  // --check-config validates CONFIG with the same parser a SIGHUP reload
  // uses, then exits without sampling or sending anything.
  const bool check_config =
      p_argc == 3 && std::string_view{p_argv[1]} == "--check-config";
  if (p_argc != 2 && !check_config)
  {
    std::fprintf(stderr, "usage: %s [--check-config] CONFIG\n", p_argv[0]);
    return 2;
  }
  const char* config_path = p_argv[p_argc - 1];
  try
  {
    auto config = triangulator::LoadConfig(config_path);
    if (!config)
    {
      std::fprintf(stderr, "invalid sampler config: %s\n",
                   config.error().c_str());
      return 2;
    }
    if (check_config)
    {
      std::puts("Sampler configuration is valid");
      return 0;
    }
    if (auto installed = triangulator::InstallSignalHandlers(); !installed)
    {
      std::fprintf(stderr, "triangulator: sigaction: %s\n",
                   installed.error().message().c_str());
      return 1;
    }
    // Chooses how warnings are written before the first tick.
    static_cast<void>(triangulator::StderrSink());
    triangulator::Sampler sampler{std::move(*config),
                                  triangulator::RaiseDescriptorLimit()};
    const auto ran = sampler.Run(config_path);
    if (!ran)
    {
      std::fprintf(stderr, "triangulator: %s\n", ran.error().c_str());
      return 1;
    }
  }
  catch (const std::exception& error)
  {
    // Last resort for a bug or an exception from the standard library.
    std::fprintf(stderr, "triangulator: %s\n", error.what());
    return 1;
  }
  return 0;
}

#ifndef TRIANGULATOR_SAMPLER_TEST
int main(int p_argc, char** p_argv)
{
  return SamplerMain(p_argc, p_argv);
}
#endif
