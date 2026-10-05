#include <sys/random.h>

#include <csignal>

#include "proc.hpp"

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

void InstallSignalHandlers()
{
  struct sigaction action{};
  action.sa_handler = OnSignal;
  ::sigemptyset(&action.sa_mask);
  for (const auto number : {SIGHUP, SIGINT, SIGTERM})
  {
    if (::sigaction(number, &action, nullptr) != 0)
    {
      throw std::system_error(errno, std::generic_category(), "sigaction");
    }
  }
}

[[nodiscard]] std::uint64_t NewSession()
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
      throw std::system_error(length == 0 ? EIO : errno,
                              std::generic_category(), "getrandom");
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

  void Run(const char* p_config_path)
  {
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
          ResetSession();
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
        SampleTick(*lookup);
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
  }

 private:
  void SampleTick(const std::optional<TargetIdentity>& p_target)
  {
    if (p_target != previous_target_)
    {
      ResetSession();
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
  }

  void ResetSession()
  {
    threads_.Clear();
    session_ = NewSession();
    sequence_ = 0;
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
      if (error != EINTR)
      {
        throw std::system_error(error, std::generic_category(),
                                "clock_nanosleep");
      }
    }
  }

  RuntimeConfig config_;
  ThreadCache threads_;
  std::array<wire::RecordBytes, wire::kMaxThreads> records_{};
  RateLimitedLogger logger_;
  std::optional<TargetIdentity> previous_target_;
  std::uint64_t session_ = NewSession();
  std::uint32_t sequence_ = 0;
};

}  // namespace
}  // namespace triangulator

int main(int p_argc, char** p_argv)
{
  if (p_argc != 2)
  {
    std::fprintf(stderr, "usage: %s CONFIG\n", p_argv[0]);
    return 2;
  }
  try
  {
    auto config = triangulator::LoadConfig(p_argv[1]);
    if (!config)
    {
      std::fprintf(stderr, "invalid sampler config: %s\n",
                   config.error().c_str());
      return 2;
    }
    triangulator::InstallSignalHandlers();
    triangulator::Sampler sampler{std::move(*config),
                                  triangulator::RaiseDescriptorLimit()};
    sampler.Run(p_argv[1]);
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "triangulator: %s\n", error.what());
    return 1;
  }
}
