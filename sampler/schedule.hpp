#pragma once

// Deadlines and cycles of the sampler's periodic tasks, which ride on
// thread ticks.

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <optional>

namespace triangulator
{

// The next deadline of a periodic task that ran at p_now: one interval after
// the previous deadline, or after p_now when the task fell behind or runs
// for the first time (p_previous is zero).
[[nodiscard]] constexpr std::chrono::nanoseconds NextDeadline(
    std::chrono::nanoseconds p_previous, std::chrono::nanoseconds p_now,
    std::chrono::nanoseconds p_interval) noexcept
{
  return p_previous == std::chrono::nanoseconds{0} ||
                 p_now - p_previous >= p_interval
             ? p_now + p_interval
             : p_previous + p_interval;
}

// Whole ticks in p_interval, rounded up so that a resource scan never comes
// more often than configured. Zero when the interval is zero (off).
[[nodiscard]] constexpr std::size_t IntervalTicks(
    std::chrono::nanoseconds p_interval,
    std::chrono::nanoseconds p_tick) noexcept
{
  return static_cast<std::size_t>(
      (p_interval + p_tick - std::chrono::nanoseconds{1}) / p_tick);
}

// The heavy-scan cycle. One tick runs at most one heavy scan, so the
// capacity is one scan per tick for all targets together. A cycle gives
// each live target one resource scan in a fixed position, which keeps
// their gaps equal, and gives memory maps one more position only when a
// memory sample waits. When capacity is left, the cycle is the configured
// interval long and the free positions are memory turns.
class HeavySchedule final
{
 public:
  // The cycle as it is set when it starts.
  struct Cycle
  {
    std::size_t resource_targets_{};  // live targets, 0 when resources are off
    bool memory_waiting_{};           // a memory sample is busy or due
    std::size_t interval_ticks_{};    // IntervalTicks of the resource interval
  };

  // The live-target number whose resources this tick scans, or nullopt for
  // a memory turn. p_cycle is read only when a new cycle starts, so a
  // change of the target count or the tick rate never breaks a cycle.
  [[nodiscard]] std::optional<std::size_t> Next(const Cycle& p_cycle) noexcept
  {
    if (position_ == 0)
    {
      resource_targets_ = p_cycle.resource_targets_;
      length_ = std::max(
          {p_cycle.resource_targets_ + (p_cycle.memory_waiting_ ? 1U : 0U),
           p_cycle.interval_ticks_, std::size_t{1}});
    }
    const auto position = position_;
    position_ = (position_ + 1) % length_;
    if (position < resource_targets_)
    {
      return position;
    }
    return std::nullopt;
  }

  void Reset() noexcept
  {
    position_ = 0;
  }

 private:
  std::size_t position_ = 0;
  std::size_t length_ = 1;
  std::size_t resource_targets_ = 0;
};

}  // namespace triangulator
