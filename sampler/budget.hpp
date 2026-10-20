#pragma once

#include <algorithm>
#include <array>
#include <cstdint>

#include "io.hpp"

namespace triangulator
{

// Twenty fixed buckets cover at least five seconds at the fastest check
// cadence. Tick samples are added to the current bucket without allocation.
class CpuBudget final
{
 public:
  CpuBudget(double p_rate_hz, double p_budget_pct)
      : configured_rate_(p_rate_hz),
        effective_rate_(p_rate_hz),
        budget_pct_(p_budget_pct)
  {
  }

  void Add(Nanoseconds p_cpu, Nanoseconds p_elapsed)
  {
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
    if (percent > budget_pct_)
    {
      effective_rate_ =
          std::max(0.2, effective_rate_ * budget_pct_ / percent * 0.9);
      since_change_ = Nanoseconds{0};
    }
    else if (percent < budget_pct_ * 0.6 && effective_rate_ < configured_rate_)
    {
      effective_rate_ = std::min(configured_rate_, effective_rate_ * 1.25);
      since_change_ = Nanoseconds{0};
    }
  }

  [[nodiscard]] double RateHz() const noexcept
  {
    return effective_rate_;
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
  double configured_rate_;
  double effective_rate_;
  double budget_pct_;
  Nanoseconds since_change_{0};
  Nanoseconds total_elapsed_{0};
  std::array<Bucket, 20> buckets_{};
  std::size_t position_ = 0;
  Bucket current_;
  Nanoseconds cpu_{0};
  Nanoseconds elapsed_{0};
};

}  // namespace triangulator
