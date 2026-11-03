#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>

#include "io.hpp"

namespace triangulator
{

// The collector accepts at most 5000 ms between ticks, the 0.2 Hz minimum.
inline constexpr double kMinRateHz = 0.2;
inline constexpr std::uint32_t kMaxTickIntervalMs = 5000;

// The interval_ms of a target served on every p_stride-th loop tick. The
// multiply comes before the rounding: 35 x (1/7 s) is 5000 ms, but 35 x 143 ms
// would be 5005 ms, which the collector rejects.
[[nodiscard]] inline std::uint32_t TickIntervalMs(
    Nanoseconds p_loop_interval, std::uint32_t p_stride) noexcept
{
  const auto interval =
      std::chrono::round<std::chrono::milliseconds>(p_loop_interval * p_stride);
  return static_cast<std::uint32_t>(std::min<std::int64_t>(
      interval.count(), std::int64_t{kMaxTickIntervalMs}));
}

// Twenty fixed buckets cover at least five seconds at the fastest check
// cadence. Tick samples are added to the current bucket without allocation.
//
// One measured total controls two rates. While a critical target is live,
// the loop runs at the critical rate, and other targets are served on every
// Stride()-th tick. Other targets absorb a cut first, against the budget.
// The critical rate falls only when the total exceeds the ceiling (budget
// plus extra) and the other targets have no room left. Per-target CPU is not
// measured: it would cost a syscall per target per tick, and the shared
// discovery and heavy scans belong to no target.
class CpuBudget final
{
 public:
  CpuBudget(double p_rate_hz, double p_budget_pct, double p_extra_pct = 0)
      : configured_rate_(p_rate_hz),
        critical_rate_(p_rate_hz),
        other_rate_(p_rate_hz),
        budget_pct_(p_budget_pct),
        ceiling_pct_(p_budget_pct + p_extra_pct)
  {
  }

  // p_critical_live: a critical target with a process was sampled in this
  // tick. p_other_live: a non-critical target with a process was live.
  void Add(Nanoseconds p_cpu, Nanoseconds p_elapsed,
           bool p_critical_live = false, bool p_other_live = true)
  {
    if (p_critical_live != critical_live_)
    {
      // The ceiling changes. Samples from the old state would steer the
      // first decision of the new one.
      critical_live_ = p_critical_live;
      ClearWindow();
    }
    total_elapsed_ += p_elapsed;
    current_.cpu_ += p_cpu;
    current_.elapsed_ += p_elapsed;
    since_change_ += p_elapsed;
    if (current_.elapsed_ < 250ms)
    {
      return;
    }
    current_.end_ = total_elapsed_;
    buckets_[position_++ % buckets_.size()] = current_;
    current_ = {};
    cpu_ = Nanoseconds{0};
    elapsed_ = Nanoseconds{0};
    for (const auto& bucket : buckets_)
    {
      if (total_elapsed_ - bucket.end_ < 5s)
      {
        cpu_ += bucket.cpu_;
        elapsed_ += bucket.elapsed_;
      }
    }
    if (elapsed_ < 5s || since_change_ < 5s)
    {
      return;
    }
    const double percent = 100.0 * static_cast<double>(cpu_.count()) /
                           static_cast<double>(elapsed_.count());
    if (critical_live_ ? StepCritical(percent, p_other_live)
                       : StepOther(percent))
    {
      since_change_ = Nanoseconds{0};
    }
  }

  // The loop rate.
  [[nodiscard]] double RateHz() const noexcept
  {
    return critical_live_ ? critical_rate_ : other_rate_;
  }
  // A non-critical target is served on every Stride()-th loop tick. The
  // floor keeps its rate, RateHz() / Stride(), at or above kMinRateHz.
  [[nodiscard]] std::uint32_t Stride() const noexcept
  {
    if (!critical_live_)
    {
      return 1;
    }
    return std::max<std::uint32_t>(
        1,
        static_cast<std::uint32_t>(std::floor(critical_rate_ / other_rate_)));
  }
  [[nodiscard]] Nanoseconds Cpu() const noexcept
  {
    return cpu_ + current_.cpu_;
  }
  [[nodiscard]] Nanoseconds Elapsed() const noexcept
  {
    return elapsed_ + current_.elapsed_;
  }

 private:
  struct Bucket
  {
    Nanoseconds cpu_{0};
    Nanoseconds elapsed_{0};
    Nanoseconds end_{0};
  };

  // No critical target: one rate for all targets, against the budget.
  [[nodiscard]] bool StepOther(double p_percent) noexcept
  {
    if (p_percent > budget_pct_)
    {
      other_rate_ =
          std::max(kMinRateHz, other_rate_ * budget_pct_ / p_percent * 0.9);
      return true;
    }
    if (p_percent < budget_pct_ * 0.6 && other_rate_ < configured_rate_)
    {
      other_rate_ = std::min(configured_rate_, other_rate_ * 1.25);
      return true;
    }
    return false;
  }

  // Cuts go to other targets first; recovery goes to critical targets first.
  [[nodiscard]] bool StepCritical(double p_percent, bool p_other_live) noexcept
  {
    const bool other_room = p_other_live && other_rate_ > kMinRateHz;
    if (p_percent > budget_pct_ && other_room)
    {
      other_rate_ =
          std::max(kMinRateHz, other_rate_ * budget_pct_ / p_percent * 0.9);
      return true;
    }
    if (p_percent > ceiling_pct_)
    {
      critical_rate_ =
          std::max(kMinRateHz, critical_rate_ * ceiling_pct_ / p_percent * 0.9);
      other_rate_ = std::min(other_rate_, critical_rate_);
      return true;
    }
    if (p_percent < ceiling_pct_ * 0.6 && critical_rate_ < configured_rate_)
    {
      critical_rate_ = std::min(configured_rate_, critical_rate_ * 1.25);
      return true;
    }
    if (p_percent < budget_pct_ * 0.6 && other_rate_ < critical_rate_)
    {
      other_rate_ = std::min(critical_rate_, other_rate_ * 1.25);
      return true;
    }
    return false;
  }

  void ClearWindow() noexcept
  {
    buckets_ = {};
    current_ = {};
    cpu_ = Nanoseconds{0};
    elapsed_ = Nanoseconds{0};
    since_change_ = Nanoseconds{0};
  }

  double configured_rate_;
  double critical_rate_;
  double other_rate_;
  double budget_pct_;
  double ceiling_pct_;
  bool critical_live_ = false;
  Nanoseconds since_change_{0};
  Nanoseconds total_elapsed_{0};
  std::array<Bucket, 20> buckets_{};
  std::size_t position_ = 0;
  Bucket current_;
  Nanoseconds cpu_{0};
  Nanoseconds elapsed_{0};
};

}  // namespace triangulator
