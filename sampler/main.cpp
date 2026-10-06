#include <sys/random.h>

#include <cassert>
#include <csignal>
#include <expected>
#include <format>
#include <string>
#include <string_view>
#include <system_error>

#include "proc.hpp"
#include "resources.hpp"

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
  return session;
}

class Sampler
{
 public:
  Sampler(RuntimeConfig p_config, std::size_t p_descriptor_limit)
      : config_(std::move(p_config)), threads_(p_descriptor_limit)
  {
  }

  // Samples until SIGINT/SIGTERM. Returns an error only when no new session
  // id can be made.
  [[nodiscard]] std::expected<void, std::string> Run(const char* p_config_path)
  {
    if (auto reset = ResetSession(); !reset)
    {
      return reset;
    }
    auto deadline = ClockNow(CLOCK_MONOTONIC);
    while (!stop_requested)
    {
      if (reload_requested)
      {
        reload_requested = 0;
        auto next = LoadConfig(p_config_path);
        if (next)
        {
          config_ = std::move(*next);
          if (auto reset = ResetSession(); !reset)
          {
            return reset;
          }
        }
        else
        {
          logger_.Warn(std::format(
              "invalid SIGHUP config; keeping previous configuration: {}",
              next.error()));
        }
      }
      const auto lookup = FindTarget(config_.settings_.target_);
      if (lookup)
      {
        if (auto sampled = SampleTick(*lookup); !sampled)
        {
          return sampled;
        }
      }
      else
      {
        // Not the same as "target absent": keep the session and the
        // thread cache, send nothing and retry at the next deadline.
        logger_.Warn(
            std::format("target lookup failed: {}; tick skipped, session kept",
                        std::generic_category().message(lookup.error())));
      }
      const auto interval = config_.settings_.Interval();
      const auto now = ClockNow(CLOCK_MONOTONIC);
      deadline += interval;
      if (deadline <= now)
      {
        deadline += interval * ((now - deadline) / interval + 1);
      }
      SleepUntil(deadline);
    }
    return {};
  }

 private:
  [[nodiscard]] std::expected<void, std::string> SampleTick(
      const std::optional<TargetIdentity>& p_target)
  {
    if (p_target != previous_target_)
    {
      if (auto reset = ResetSession(); !reset)
      {
        return reset;
      }
      previous_target_ = p_target;
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
    SendTick(pid, monotonic, wall, std::span{records_}.first(count));
    // Resource samples ride on thread ticks. Half a tick of slack keeps
    // wake-up jitter from pushing one to the following tick.
    const auto resource_interval = ResourceInterval();
    if (p_target && resource_interval > Nanoseconds{0} &&
        monotonic + config_.settings_.Interval() / 2 >= next_resources_)
    {
      SendResources(*p_target);
      next_resources_ = next_resources_ == Nanoseconds{0} ||
                                monotonic - next_resources_ >= resource_interval
                            ? monotonic + resource_interval
                            : next_resources_ + resource_interval;
    }
    return {};
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
                                 config_.settings_.Interval());
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
      const auto& endpoint = config_.endpoint_;
      if (::sendto(endpoint.socket_.Get(), resource_packet_.data(), p_length,
                   MSG_DONTWAIT,
                   reinterpret_cast<const sockaddr*>(&endpoint.address_),
                   endpoint.address_length_) < 0 &&
          errno != EAGAIN && errno != EWOULDBLOCK && errno != ENOBUFS)
      {
        logger_.Warn("UDP send failed; resource sample dropped");
      }
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
    return {};
  }

  void SendTick(int p_pid, Nanoseconds p_monotonic, Nanoseconds p_wall,
                std::span<const wire::RecordBytes> p_records)
  {
    const auto chunks = std::max(
        std::size_t{1}, (p_records.size() + wire::kRecordsPerPacket - 1) /
                            wire::kRecordsPerPacket);
    for (std::size_t chunk = 0; chunk < chunks; ++chunk)
    {
      const auto offset = chunk * wire::kRecordsPerPacket;
      const auto count =
          std::min(p_records.size() - offset, wire::kRecordsPerPacket);
      wire::Packet packet{};
      const auto flags =
          (p_pid ? wire::Flags::None : wire::Flags::TargetAbsent) |
          (config_.settings_.status_fallback_ ? wire::Flags::StatusFallback
                                              : wire::Flags::None);
      wire::EncodeHeader(
          std::span{packet}.first<wire::kHeaderSize>(),
          {
              .flags_ = flags,
              .chunk_ = static_cast<std::uint8_t>(chunk),
              .chunks_ = static_cast<std::uint8_t>(chunks),
              .session_ = session_,
              .sequence_ = sequence_,
              .records_ = static_cast<std::uint16_t>(count),
              .monotonic_ns_ = static_cast<std::uint64_t>(p_monotonic.count()),
              .wall_ns_ = static_cast<std::uint64_t>(p_wall.count()),
              .interval_ms_ = config_.settings_.IntervalMs(),
              .pid_ = static_cast<std::uint32_t>(p_pid),
          });
      const auto bytes = std::as_bytes(p_records.subspan(offset, count));
      std::ranges::copy(bytes,
                        std::span{packet}.subspan<wire::kHeaderSize>().begin());
      const auto& endpoint = config_.endpoint_;
      if (::sendto(endpoint.socket_.Get(), packet.data(),
                   wire::kHeaderSize + bytes.size(), MSG_DONTWAIT,
                   reinterpret_cast<const sockaddr*>(&endpoint.address_),
                   endpoint.address_length_) < 0 &&
          errno != EAGAIN && errno != EWOULDBLOCK && errno != ENOBUFS)
      {
        logger_.Warn("UDP send failed; samples dropped");
      }
    }
    ++sequence_;
  }

  static void SleepUntil(Nanoseconds p_deadline)
  {
    const auto seconds =
        std::chrono::duration_cast<std::chrono::seconds>(p_deadline);
    const timespec wake{
        .tv_sec = static_cast<time_t>(seconds.count()),
        .tv_nsec = static_cast<long>((p_deadline - seconds).count())};
    while (!stop_requested && !reload_requested)
    {
      const auto error =
          ::clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &wake, nullptr);
      if (error == 0)
      {
        break;
      }
      // EINVAL (a bad deadline) is the only other failure for this clock,
      // and the deadline is ours, so it would be a bug.
      assert(error == EINTR);
    }
  }

  RuntimeConfig config_;
  ThreadCache threads_;
  std::array<wire::RecordBytes, wire::kMaxThreads> records_{};
  RateLimitedLogger logger_;
  std::optional<TargetIdentity> previous_target_;
  std::uint64_t session_ = 0;  // set by ResetSession() when Run() starts
  std::uint32_t sequence_ = 0;
  ResourceProbe resources_;
  std::array<std::byte, resource_wire::kMaxPartSize> resource_packet_{};
  std::uint32_t resource_sequence_ = 0;
  Nanoseconds next_resources_{0};
};

}  // namespace
}  // namespace triangulator

int main(int p_argc, char** p_argv)
{
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
