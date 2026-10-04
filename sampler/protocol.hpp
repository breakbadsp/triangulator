#pragma once

#include "parsing.hpp"

#include <bit>
#include <cstddef>
#include <concepts>
#include <span>
#include <utility>

namespace triangulator::wire {

inline constexpr std::size_t header_size = 48;
inline constexpr std::uint8_t version = 2;
inline constexpr std::size_t record_size = 112;
inline constexpr std::size_t records_per_packet = 10;
inline constexpr std::size_t max_threads = records_per_packet * 255;
inline constexpr std::size_t packet_size = header_size + records_per_packet * record_size;
using Record = std::array<std::byte, record_size>;
using Packet = std::array<std::byte, packet_size>;
static_assert(packet_size == 1168);

enum class Flags : std::uint8_t { none = 0, target_absent = 1, status_fallback = 2 };
enum class RecordFlags : std::uint8_t { none = 0, io_unavailable = 1 };
constexpr Flags operator|(Flags left, Flags right) noexcept {
    return static_cast<Flags>(std::to_underlying(left) | std::to_underlying(right));
}

template <std::unsigned_integral Number>
void write_little_endian(std::span<std::byte, sizeof(Number)> destination, Number value) {
    if constexpr (std::endian::native == std::endian::big) value = std::byteswap(value);
    const auto bytes = std::bit_cast<std::array<std::byte, sizeof(Number)>>(value);
    std::ranges::copy(bytes, destination.begin());
}

[[nodiscard]] inline Record encode_record(int tid, const ThreadStat& stat, const SchedulerCounters& counters,
                                          const std::optional<IoCounters>& io, const WaitChannel& wchan) {
    Record record{};
    const std::span buffer{record};
    const auto io_values = io.value_or(IoCounters{});
    write_little_endian(buffer.subspan<0, 4>(), static_cast<std::uint32_t>(tid));
    record[4] = static_cast<std::byte>(stat.state);
    record[5] = static_cast<std::byte>(io ? RecordFlags::none : RecordFlags::io_unavailable);
    write_little_endian(buffer.subspan<6, 2>(), stat.processor);
    write_little_endian(buffer.subspan<8, 8>(), stat.utime);
    write_little_endian(buffer.subspan<16, 8>(), stat.stime);
    write_little_endian(buffer.subspan<24, 8>(), counters.run_delay);
    write_little_endian(buffer.subspan<32, 8>(), counters.timeslices);
    write_little_endian(buffer.subspan<40, 8>(), stat.major_faults);
    write_little_endian(buffer.subspan<48, 8>(), io_values.read_bytes);
    write_little_endian(buffer.subspan<56, 8>(), io_values.write_bytes);
    std::ranges::copy(std::as_bytes(std::span{stat.name}), buffer.subspan<64, 16>().begin());
    std::ranges::copy(std::as_bytes(std::span{wchan}), buffer.subspan<80, 32>().begin());
    return record;
}

struct Header {
    Flags flags{};
    std::uint8_t chunk{};
    std::uint8_t chunks{};
    std::uint64_t session{};
    std::uint32_t sequence{};
    std::uint16_t records{};
    std::uint64_t monotonic_ns{};
    std::uint64_t wall_ns{};
    std::uint32_t interval_ms{};
    std::uint32_t pid{};
};

inline void encode_header(std::span<std::byte, header_size> buffer, const Header& header) {
    std::ranges::fill(buffer, std::byte{0});
    constexpr std::array magic{std::byte{'T'}, std::byte{'M'}, std::byte{'O'}, std::byte{'N'}};
    std::ranges::copy(magic, buffer.begin());
    buffer[4] = std::byte{version};
    buffer[5] = static_cast<std::byte>(header.flags);
    buffer[6] = static_cast<std::byte>(header.chunk);
    buffer[7] = static_cast<std::byte>(header.chunks);
    write_little_endian(buffer.subspan<8, 8>(), header.session);
    write_little_endian(buffer.subspan<16, 4>(), header.sequence);
    write_little_endian(buffer.subspan<20, 2>(), header.records);
    write_little_endian(buffer.subspan<24, 8>(), header.monotonic_ns);
    write_little_endian(buffer.subspan<32, 8>(), header.wall_ns);
    write_little_endian(buffer.subspan<40, 4>(), header.interval_ms);
    write_little_endian(buffer.subspan<44, 4>(), header.pid);
}

}
