#pragma once

// Deadlines of the sampler's periodic tasks, which ride on thread ticks.

#include <chrono>

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

}  // namespace triangulator
