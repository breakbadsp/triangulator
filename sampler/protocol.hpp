#pragma once

#include <optional>

#include "../common/wire.hpp"
#include "parsing.hpp"

namespace triangulator::wire
{

[[nodiscard]] inline Record EncodeRecord(int p_tid, const ThreadStat& p_stat,
                                         const SchedulerCounters& p_counters,
                                         const std::optional<IoCounters>& p_io,
                                         const WaitChannel& p_wchan)
{
  Record record{};
  const std::span buffer{record};
  const auto io_values = p_io.value_or(IoCounters{});
  WriteLittleEndian(buffer.subspan<0, 4>(), static_cast<std::uint32_t>(p_tid));
  record[4] = static_cast<std::byte>(p_stat.state_);
  record[5] = static_cast<std::byte>(p_io ? RecordFlags::None
                                          : RecordFlags::IoUnavailable);
  WriteLittleEndian(buffer.subspan<6, 2>(), p_stat.processor_);
  WriteLittleEndian(buffer.subspan<8, 8>(), p_stat.utime_);
  WriteLittleEndian(buffer.subspan<16, 8>(), p_stat.stime_);
  WriteLittleEndian(buffer.subspan<24, 8>(), p_counters.run_delay_);
  WriteLittleEndian(buffer.subspan<32, 8>(), p_counters.timeslices_);
  WriteLittleEndian(buffer.subspan<40, 8>(), p_stat.major_faults_);
  WriteLittleEndian(buffer.subspan<48, 8>(), io_values.read_bytes_);
  WriteLittleEndian(buffer.subspan<56, 8>(), io_values.write_bytes_);
  std::ranges::copy(std::as_bytes(std::span{p_stat.name_}),
                    buffer.subspan<64, 16>().begin());
  std::ranges::copy(std::as_bytes(std::span{p_wchan}),
                    buffer.subspan<80, 32>().begin());
  return record;
}

}  // namespace triangulator::wire
