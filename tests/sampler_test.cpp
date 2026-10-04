#include "../sampler/proc.hpp"

#include <stdexcept>
#include <type_traits>

namespace {

using namespace triangulator;

void require(bool condition, std::string_view message) {
    if (!condition) throw std::runtime_error(std::string{message});
}

void test_parsing() {
    std::string stat = "42 (worker ) ( name) S";
    for (int field = 4; field <= 52; ++field) {
        stat += std::format(" {}", field == 12 ? 7 : field == 14 ? 100 : field == 15 ? 50 : field == 22 ? 12345 : field == 39 ? 3 : 0);
    }
    const auto parsed = parse_stat(stat);
    require(parsed.has_value(), "stat with parentheses must parse");
    require(std::string_view{parsed->name.data()} == "worker ) ( name", "comm must use last closing parenthesis");
    require(parsed->utime == 100 && parsed->stime == 50 && parsed->starttime == 12345, "stat fields must retain their numbering");
    require(parsed->major_faults == 7 && parsed->processor == 3, "major faults and last CPU");
    require(!parse_stat("42 (bad) S 0"), "truncated stat must fail");
    require(!parse_number<std::uint64_t>("-1"), "negative counters must fail");
    require(!parse_number<std::uint64_t>("18446744073709551616"), "counter overflow must fail");
    require(!parse_number<int>("12garbage"), "partially parsed numbers must fail");
    require(std::string_view{parse_wchan("futex_do_wait").data()} == "futex_do_wait", "plain wchan");
    require(std::string_view{parse_wchan("poll_schedule_timeout.constprop.0").data()} == "poll_schedule_timeout",
            "compiler suffix is dropped");
    require(parse_wchan("0").front() == '\0', "running or hidden wchan is empty");
    require(parse_wchan(std::string(40, 'x')).back() == 'x', "long wchan is truncated without overflow");
    const auto io = parse_io("rchar: 11\nwchar: 22\nsyscr: 3\nsyscw: 4\nread_bytes: 0\n");
    require(io && io->read_bytes == 11 && io->write_bytes == 22, "io counters");
    require(!parse_io("rchar: 11\n"), "both io counters are required");
    const auto schedstat = parse_schedstat("123 456 789\n");
    require(schedstat && schedstat->run_delay == 456 && schedstat->timeslices == 789, "scheduler counters");
    const auto status = parse_status("Name:\tworker\nvoluntary_ctxt_switches:\t12\nnonvoluntary_ctxt_switches:\t34\n");
    require(status && status->run_delay == 34 && status->timeslices == 12, "fallback counters must not be swapped");
    require(!parse_status("nonvoluntary_ctxt_switches: 1\n"), "both fallback counters are required");
}

void test_config() {
    const auto config = parse_config("target_process = \"name #1\" # comment\nrate_hz=0.2\ncollector=\"[::1]:9400\"\nstatus_fallback=true\n");
    require(config.has_value(), "valid configuration");
    require(std::get<TargetName>(config->target).value == "name #1", "quoted hash is part of process name");
    require(config->interval() == 5s && config->interval_ms() == 5000, "rate converted to chrono duration");
    require(config->status_fallback, "fallback flag");
    for (const auto invalid : {
        "target_pid=1\ntarget_process=foo\ncollector=127.0.0.1:9400",
        "target_pid=1\ncollector=127.0.0.1:9400\nrate_hz=nan",
        "target_pid=1\ncollector=127.0.0.1:9400\nrate_hz=10.1",
        "target_pid=1\ncollector=127.0.0.1:9400\nrate_hz=0.19",
        "target_pid=1\ntarget_pid=2\ncollector=127.0.0.1:9400",
        "target_pid=1\ncollector=\"127.0.0.1:9400",
        "target_pid=-1\ncollector=127.0.0.1:9400",
        "target_pid=1\ncollector=127.0.0.1:9400\nunknown=true",
    }) require(!parse_config(invalid), "invalid config must be rejected");
    for (const auto invalid : {"localhost:9400", "127.0.0.1:65536", "127.0.0.1:0", "[::1:9400", "127.0.0.1:no"}) {
        require(!make_endpoint(invalid), "invalid/non-numeric endpoint must be rejected");
    }
    const auto endpoint = make_endpoint("127.0.0.1:9400");
    require(endpoint.has_value(), "numeric endpoint must work");
    require((::fcntl(endpoint->socket.get(), F_GETFL) & O_NONBLOCK) != 0, "UDP socket must be nonblocking");
    require((::fcntl(endpoint->socket.get(), F_GETFD) & FD_CLOEXEC) != 0, "UDP socket must be close-on-exec");
}

void require_hex(std::span<const std::byte> bytes, std::string_view expected) {
    require(bytes.size() * 2 == expected.size(), "golden packet length");
    for (std::size_t index = 0; index < bytes.size(); ++index) {
        require(std::to_integer<unsigned>(bytes[index]) == parse_hex(expected.substr(index * 2, 2)), "wire bytes must match v2 golden packet");
    }
}

void test_wire() {
    ThreadStat stat{.state = 'S', .major_faults = 5, .utime = 0x0102030405060708ULL, .stime = 9, .processor = 0x0102};
    std::ranges::copy(std::string_view{"worker"}, stat.name.begin());
    const auto record = wire::encode_record(0x01020304, stat, {10, 11}, IoCounters{12, 13}, parse_wchan("futex_do_wait"));
    require_hex(record,
        "04030201530002010807060504030201090000000000000"
        "00a000000000000000b0000000000000005000000000000000c000000000000000d00000000000000"
        "776f726b657200000000000000000000"
        "66757465785f646f5f7761697400000000000000000000000000000000000000");
    const auto missing_io = wire::encode_record(1, stat, {10, 11}, std::nullopt, WaitChannel{});
    require(missing_io[5] == std::byte{1}, "unreadable io is flagged");
    std::array<std::byte, wire::header_size> header{};
    wire::encode_header(header, {.flags = wire::Flags::status_fallback, .chunk = 1, .chunks = 3,
        .session = 0x0102030405060708ULL, .sequence = 0x090a0b0c, .records = 1, .monotonic_ns = 12,
        .wall_ns = 13, .interval_ms = 1000, .pid = 0x01020304});
    require_hex(header, "544d4f4e0202010308070605040302010c0b0a09010000000c000000000000000d00000000000000e803000004030201");
}

void test_raii() {
    static_assert(!std::is_copy_constructible_v<FileDescriptor>);
    static_assert(std::is_nothrow_move_constructible_v<FileDescriptor>);
    static_assert(!std::is_copy_constructible_v<Thread>);
    static_assert(std::is_nothrow_move_assignable_v<Thread>);
    int closed_descriptor;
    {
        auto original = open_readonly("/dev/null");
        require(static_cast<bool>(original), "open descriptor");
        closed_descriptor = original.get();
        auto moved = std::move(original);
        require(!original && moved.get() == closed_descriptor, "move must transfer ownership");
        auto destination = open_readonly("/dev/null");
        const auto replaced_descriptor = destination.get();
        destination = std::move(moved);
        require(!moved && destination.get() == closed_descriptor, "move assignment transfers ownership");
        require(::fcntl(replaced_descriptor, F_GETFD) == -1 && errno == EBADF, "move assignment closes old descriptor");
    }
    require(::fcntl(closed_descriptor, F_GETFD) == -1 && errno == EBADF, "destructor closes descriptor");
}

}

int main() {
    try {
        test_parsing();
        test_config();
        test_wire();
        test_raii();
        std::puts("C++ sampler tests passed (parsing, configuration, wire compatibility, RAII)");
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
