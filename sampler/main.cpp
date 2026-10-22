#include <sys/random.h>

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
#include "exit_status.hpp"
#include "kernel_log.hpp"
#include "memory.hpp"
#include "proc.hpp"
#include "process_info.hpp"
#include "resources.hpp"
#include "schedule.hpp"

namespace triangulator
{
namespace
{

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
    const auto length = ::getrandom(bytes.data(), bytes.size(), 0);
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
  TargetSampler(RuntimeConfig& p_config, TargetConfig p_target,
                DescriptorBudget& p_budget, RateLimitedLogger& p_logger,
                const std::array<char, 64>& p_host)
      : config_(p_config),
        target_(std::move(p_target)),
        threads_(p_budget),
        logger_(p_logger),
        host_(p_host)
  {
  }

  [[nodiscard]] const TargetConfig& Settings() const noexcept
  {
    return target_;
  }
  [[nodiscard]] std::expected<void, std::string> Initialize()
  {
    return ResetSession();
  }

  void AnnounceNextTick() noexcept
  {
    next_announcement_ = Nanoseconds{0};
  }

  [[nodiscard]] bool HeavyDue(bool p_memory, Nanoseconds p_now) const
  {
    if (!previous_target_)
    {
      return false;
    }
    if (p_memory)
    {
      return MemoryInterval() > Nanoseconds{0} &&
             (memory_.Busy() || p_now + config_.Interval() / 2 >= next_memory_);
    }
    return ResourceInterval() > Nanoseconds{0} &&
           p_now + config_.Interval() / 2 >= next_resources_;
  }

  void StepHeavy(bool p_memory, Nanoseconds p_now)
  {
    if (!previous_target_)
    {
      return;
    }
    if (p_memory)
    {
      StepMemory(*previous_target_, p_now);
    }
    else
    {
      SendResources(*previous_target_);
      next_resources_ =
          NextDeadline(next_resources_, p_now, ResourceInterval());
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
          // Without descriptors the check cannot be made. Keep the old
          // target and its last tick, skip this tick as for a failed
          // lookup, and ask again at the next one, so the report is not
          // lost.
          logger_.Warn(
              "cannot tell whether PID {} ended: {}; tick skipped, will "
              "check again",
              previous_target_->pid_, std::strerror(ended.error()));
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
          exit_report_.ended_session_ = session_;
          exit_report_sends_ = kExitReportSends;
          reported = true;
        }
      }
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
    if (p_monotonic < next_announcement_)
    {
      return;
    }
    target_wire::Packet packet;
    packet.session_ = session_;
    target_wire::SetText(packet.target_, target_.id_);
    packet.host_ = host_;
    packet.configured_millihz_ = static_cast<std::uint32_t>(
        std::lround(config_.settings_.rate_hz_ * 1000));
    packet.effective_millihz_ = static_cast<std::uint32_t>(std::lround(
        (config_.effective_rate_hz_ > 0 ? config_.effective_rate_hz_
                                        : config_.settings_.rate_hz_) *
        1000));
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
    next_announcement_ = p_monotonic + 10s;
  }

  // Sends what the target is (command line, executable, owner and so on).
  // It is read when the session starts, as it hardly changes, and sent again
  // every kProcessInfoInterval: datagrams are not acknowledged, and a
  // collector that started later has not seen it. One small datagram of
  // cached bytes, so it adds no /proc reads after the first.
  void StepProcessInfo(const TargetIdentity& p_target, Nanoseconds p_monotonic)
  {
    // Half a tick of slack, as for resources.
    if (p_monotonic + config_.Interval() / 2 < next_process_info_)
    {
      return;
    }
    if (!process_info_read_)
    {
      process_info_ =
          process_info_probe_.Read(p_target.pid_, p_target.starttime_);
      process_info_.session_ = session_;
      process_info_.monotonic_ns_ =
          static_cast<std::uint64_t>(p_monotonic.count());
      process_info_.wall_ns_ =
          static_cast<std::uint64_t>(ClockNow(CLOCK_REALTIME).count());
      process_info_read_ = true;
    }
    SendPart(process_wire::Encode(process_info_), "process info");
    next_process_info_ =
        NextDeadline(next_process_info_, p_monotonic, kProcessInfoInterval);
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
      const bool refresh_layout = p_monotonic + interval / 2 >= next_layout_;
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
    next_resources_ = Nanoseconds{0};  // a new session samples at once
    memory_.Reset();
    memory_sequence_ = 0;
    next_memory_ = Nanoseconds{0};
    next_layout_ = Nanoseconds{0};
    process_info_read_ = false;
    next_process_info_ = Nanoseconds{0};
    next_announcement_ = Nanoseconds{0};
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
              .interval_ms_ = config_.IntervalMs(),
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

  // How often the cached process info is sent again.
  static constexpr Nanoseconds kProcessInfoInterval =
      std::chrono::seconds{process_wire::kRepeatSeconds};

  RuntimeConfig& config_;
  TargetConfig target_;
  ThreadCache threads_;
  std::array<wire::Record, wire::kMaxThreads> records_{};
  std::size_t record_count_ = 0;  // records_ filled by the last tick
  KernelLog kernel_log_;
  ExitStatusWatch exit_status_;
  exit_wire::Report exit_report_{};
  int exit_report_sends_ = 0;
  RateLimitedLogger& logger_;
  std::array<char, 64> host_{};
  Nanoseconds next_announcement_{0};
  std::optional<TargetIdentity> previous_target_;
  std::uint64_t session_ = 0;  // set by ResetSession() when Run() starts
  std::uint32_t sequence_ = 0;
  ResourceProbe resources_;
  std::array<std::byte, resource_wire::kMaxPartSize> resource_packet_{};
  std::uint32_t resource_sequence_ = 0;
  Nanoseconds next_resources_{0};
  MemoryProbe memory_;
  std::array<std::byte, memory_wire::kMaxPartSize> memory_packet_{};
  std::uint32_t memory_sequence_ = 0;
  Nanoseconds next_memory_{0};
  Nanoseconds next_layout_{0};
  ProcessInfoProbe process_info_probe_;
  process_wire::Packet process_info_{};
  bool process_info_read_ = false;  // process_info_ is this session's
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
        cpu_budget_(config_.settings_.rate_hz_,
                    config_.settings_.cpu_budget_pct_)
  {
    if (::gethostname(host_.data(), host_.size() - 1) != 0 ||
        !target_wire::ValidName(target_wire::Text(host_), 63))
    {
      target_wire::SetText(host_, "unknown-host");
    }
  }

  [[nodiscard]] std::expected<void, std::string> Run(const char* p_config_path)
  {
    if (auto prepared = PrepareTargets(false); !prepared)
    {
      return prepared;
    }
    auto deadline = ClockNow(CLOCK_MONOTONIC);
    auto last_elapsed = deadline;
    auto last_cpu = ClockNow(CLOCK_THREAD_CPUTIME_ID);
    while (!stop_requested)
    {
      if (reload_requested)
      {
        reload_requested = 0;
        auto next = LoadConfig(p_config_path);
        if (next)
        {
          const auto& before = config_.settings_;
          const auto& after = next->settings_;
          const bool keep_sessions =
              before.rate_hz_ == after.rate_hz_ &&
              before.cpu_budget_pct_ == after.cpu_budget_pct_ &&
              before.collector_ == after.collector_ &&
              before.status_fallback_ == after.status_fallback_ &&
              before.resource_interval_s_ == after.resource_interval_s_ &&
              before.memory_interval_s_ == after.memory_interval_s_;
          config_ = std::move(*next);
          if (!keep_sessions)
          {
            cpu_budget_ = CpuBudget{config_.settings_.rate_hz_,
                                    config_.settings_.cpu_budget_pct_};
          }
          config_.effective_rate_hz_ = cpu_budget_.RateHz();
          if (auto prepared = PrepareTargets(keep_sessions); !prepared)
          {
            return prepared;
          }
          last_elapsed = ClockNow(CLOCK_MONOTONIC);
          last_cpu = ClockNow(CLOCK_THREAD_CPUTIME_ID);
        }
        else
        {
          logger_.Warn(
              "invalid SIGHUP config; keeping previous configuration: {}",
              next.error());
        }
      }
      const auto exit_deadline =
          ClockNow(CLOCK_MONOTONIC) +
          std::min<Nanoseconds>(config_.Interval() / 4, 50ms);
      const auto lookups = FindTargets(config_.settings_.targets_);
      for (std::size_t index = 0; index < targets_.size(); ++index)
      {
        if (lookups[index])
        {
          if (auto sampled =
                  targets_[index]->SampleTick(*lookups[index], exit_deadline);
              !sampled)
          {
            return sampled;
          }
        }
        else
        {
          logger_.Warn("target lookup failed: {}; tick skipped, session kept",
                       std::strerror(lookups[index].error()));
        }
      }
      const auto now = ClockNow(CLOCK_MONOTONIC);
      // A single cursor gives resources and memory maps equal opportunities.
      const auto jobs = targets_.size() * 2;
      for (std::size_t checked = 0; checked < jobs; ++checked)
      {
        const auto job = heavy_cursor_++ % jobs;
        const auto index = job / 2;
        if (lookups[index] && targets_[index]->HeavyDue(job % 2 != 0, now))
        {
          targets_[index]->StepHeavy(job % 2 != 0, now);
          break;
        }
      }
      const auto end = ClockNow(CLOCK_MONOTONIC);
      const auto cpu = ClockNow(CLOCK_THREAD_CPUTIME_ID);
      cpu_budget_.Add(cpu - last_cpu, end - last_elapsed);
      last_cpu = cpu;
      last_elapsed = end;
      const auto old_rate = config_.effective_rate_hz_;
      config_.effective_rate_hz_ = cpu_budget_.RateHz();
      config_.sampler_cpu_ns_ =
          static_cast<std::uint64_t>(cpu_budget_.Cpu().count());
      config_.sampler_elapsed_ns_ =
          static_cast<std::uint64_t>(cpu_budget_.Elapsed().count());
      if (old_rate > 0 && old_rate != config_.effective_rate_hz_)
      {
        for (auto& target : targets_)
        {
          target->AnnounceNextTick();
        }
      }
      const auto interval = config_.Interval();
      deadline += interval;
      if (deadline <= end)
      {
        deadline += interval * ((end - deadline) / interval + 1);
      }
      SleepUntil(deadline);
    }
    return {};
  }

 private:
  RuntimeConfig config_;
  DescriptorBudget budget_;
  CpuBudget cpu_budget_;
  RateLimitedLogger logger_;
  std::array<char, 64> host_{};
  std::vector<std::unique_ptr<TargetSampler>> targets_;
  std::size_t heavy_cursor_ = 0;

  [[nodiscard]] std::expected<void, std::string> PrepareTargets(
      bool p_keep_sessions)
  {
    std::vector<std::unique_ptr<TargetSampler>> next;
    next.reserve(config_.settings_.targets_.size());
    for (const auto& target : config_.settings_.targets_)
    {
      const auto found = std::ranges::find_if(
          targets_,
          [&](const auto& p_existing)
          {
            return p_existing && p_existing->Settings() == target;
          });
      if (p_keep_sessions && found != targets_.end())
      {
        next.push_back(std::move(*found));
      }
      else
      {
        auto sampler = std::make_unique<TargetSampler>(config_, target, budget_,
                                                       logger_, host_);
        if (auto initialized = sampler->Initialize(); !initialized)
        {
          return initialized;
        }
        next.push_back(std::move(sampler));
      }
    }
    targets_ = std::move(next);
    heavy_cursor_ = 0;
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

int main(int p_argc, char** p_argv)
{
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
    triangulator::Sampler sampler{std::move(*config),
                                  triangulator::RaiseDescriptorLimit()};
    if (auto ran = sampler.Run(config_path); !ran)
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
}
