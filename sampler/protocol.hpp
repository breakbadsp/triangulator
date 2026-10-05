#pragma once

#include <optional>

#include "../common/wire.hpp"
#include "parsing.hpp"

namespace triangulator::wire
{

// Packs one thread's /proc readings into the wire record.
[[nodiscard]] inline RecordBytes EncodeSample(
    int p_tid, const ThreadStat& p_stat, const SchedulerCounters& p_counters,
    const std::optional<IoCounters>& p_io, const WaitChannel& p_wchan)
{
  const auto io_values = p_io.value_or(IoCounters{});
  RecordBytes bytes{};
  EncodeRecord(bytes, Record{.tid_ = static_cast<std::uint32_t>(p_tid),
                             .state_ = p_stat.state_,
                             .flags_ = p_io ? RecordFlags::None
                                            : RecordFlags::IoUnavailable,
                             .processor_ = p_stat.processor_,
                             .utime_ = p_stat.utime_,
                             .stime_ = p_stat.stime_,
                             .run_delay_ = p_counters.run_delay_,
                             .timeslices_ = p_counters.timeslices_,
                             .major_faults_ = p_stat.major_faults_,
                             .read_bytes_ = io_values.read_bytes_,
                             .write_bytes_ = io_values.write_bytes_,
                             .comm_ = p_stat.name_,
                             .wchan_ = p_wchan});
  return bytes;
}

}  // namespace triangulator::wire
