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

// One measured total controls two rates. While a critical target is live,
// the loop runs at the critical rate, and other targets are served on every
// Stride()-th tick. Other targets absorb a cut first, against the budget.
// The critical rate falls only when the total exceeds the ceiling (budget
// plus extra) and the other targets have no room left. Per-target CPU is not
// measured: it would cost a syscall per target per tick, and the shared
// discovery and heavy scans belong to no target.
//
// Two windows of about five seconds feed the decisions. The main window sees
// every tick and decides the rate of the targets without a live critical
// target; each change of the critical state clears it, so that work from
// before an exit cannot cut the other targets. The critical window sees only
// the ticks that sample a live critical target and decides the critical
// state. It survives the gaps: a target that is live for less than five
// seconds at a time and gone for longer than the hold never fills a window of
// wall time, but its live ticks add up to one.
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
    critical_gap_ =
        p_critical_live ? Nanoseconds{0} : critical_gap_ + p_elapsed;
    // A short gap, such as a critical process that restarts, keeps the
    // critical state, so the loop rate does not flip with it.
    const bool critical_live =
        p_critical_live || (critical_live_ && critical_gap_ < kCriticalHold);
    if (critical_live != critical_live_)
    {
      // The main window clears at a change, whatever its direction: samples
      // from the old state would steer the first decision of the new one.
      critical_live_ = critical_live;
      main_.Clear();
      since_change_ = Nanoseconds{0};
    }
    since_change_ += p_elapsed;
    const bool main_closed = main_.Add(p_cpu, p_elapsed);
    if (p_critical_live && critical_.Add(p_cpu, p_elapsed) &&
        critical_.IsFull() && StepCritical(critical_.Percent(), p_other_live))
    {
      // The next decision needs five seconds of live ticks at the new rates.
      critical_.Clear();
    }
    if (!critical_live_ && main_closed && main_.IsFull() &&
        since_change_ >= kWindowLength && StepOther(main_.Percent()))
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
    return main_.Cpu();
  }
  [[nodiscard]] Nanoseconds Elapsed() const noexcept
  {
    return main_.Elapsed();
  }

 private:
  // A cut aims 10% below the target. Recovery waits for use below 60% of
  // it, so that a cut and a rise cannot alternate.
  static constexpr double kCutMargin = 0.9;
  static constexpr double kRecoverBelow = 0.6;
  static constexpr double kRaiseStep = 1.25;
  static constexpr Nanoseconds kCriticalHold = 5s;
  static constexpr Nanoseconds kWindowLength = 5s;

  // Twenty fixed buckets cover at least five seconds at the fastest check
  // cadence. Tick samples are added to the current bucket without allocation.
  // The window has its own clock, which advances only with the samples that
  // it receives.
  class Window final
  {
   public:
    // True when a bucket closed, which is when the sums change.
    [[nodiscard]] bool Add(Nanoseconds p_cpu, Nanoseconds p_elapsed) noexcept
    {
      total_elapsed_ += p_elapsed;
      current_.cpu_ += p_cpu;
      current_.elapsed_ += p_elapsed;
      if (current_.elapsed_ < 250ms)
      {
        return false;
      }
      current_.end_ = total_elapsed_;
      buckets_[position_++ % buckets_.size()] = current_;
      current_ = {};
      cpu_ = Nanoseconds{0};
      elapsed_ = Nanoseconds{0};
      for (const auto& bucket : buckets_)
      {
        if (total_elapsed_ - bucket.end_ < kWindowLength)
        {
          cpu_ += bucket.cpu_;
          elapsed_ += bucket.elapsed_;
        }
      }
      return true;
    }

    void Clear() noexcept
    {
      buckets_ = {};
      current_ = {};
      cpu_ = Nanoseconds{0};
      elapsed_ = Nanoseconds{0};
    }

    // The closed buckets cover a complete window.
    [[nodiscard]] bool IsFull() const noexcept
    {
      return elapsed_ >= kWindowLength;
    }
    // The use over the closed buckets: call it only when IsFull().
    [[nodiscard]] double Percent() const noexcept
    {
      return 100.0 * static_cast<double>(cpu_.count()) /
             static_cast<double>(elapsed_.count());
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

    Nanoseconds total_elapsed_{0};
    std::array<Bucket, 20> buckets_{};
    std::size_t position_ = 0;
    Bucket current_;
    Nanoseconds cpu_{0};
    Nanoseconds elapsed_{0};
  };

  // No critical target: one rate for all targets, against the budget.
  [[nodiscard]] bool StepOther(double p_percent) noexcept
  {
    if (p_percent > budget_pct_)
    {
      other_rate_ = std::max(
          kMinRateHz, other_rate_ * budget_pct_ / p_percent * kCutMargin);
      return true;
    }
    if (p_percent < budget_pct_ * kRecoverBelow &&
        other_rate_ < configured_rate_)
    {
      other_rate_ = std::min(configured_rate_, other_rate_ * kRaiseStep);
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
      other_rate_ = std::max(
          kMinRateHz, other_rate_ * budget_pct_ / p_percent * kCutMargin);
      return true;
    }
    if (p_percent > ceiling_pct_)
    {
      critical_rate_ = std::max(
          kMinRateHz, critical_rate_ * ceiling_pct_ / p_percent * kCutMargin);
      other_rate_ = std::min(other_rate_, critical_rate_);
      return true;
    }
    if (p_percent < ceiling_pct_ * kRecoverBelow &&
        critical_rate_ < configured_rate_)
    {
      critical_rate_ = std::min(configured_rate_, critical_rate_ * kRaiseStep);
      return true;
    }
    if (p_percent < budget_pct_ * kRecoverBelow && other_rate_ < critical_rate_)
    {
      other_rate_ = std::min(critical_rate_, other_rate_ * kRaiseStep);
      return true;
    }
    return false;
  }

  double configured_rate_;
  double critical_rate_;
  double other_rate_;
  double budget_pct_;
  double ceiling_pct_;
  bool critical_live_ = false;
  Nanoseconds critical_gap_{0};
  Nanoseconds since_change_{0};
  Window main_;
  Window critical_;
};

}  // namespace triangulator
