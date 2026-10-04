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
    for (int field = 4; field <= 22; ++field) {
        stat += std::format(" {}", field == 14 ? 100 : field == 15 ? 50 : field == 22 ? 12345 : 0);
    }
    const auto parsed = parse_stat(stat);
    require(parsed.has_value(), "stat with parentheses must parse");
    require(std::string_view{parsed->name.data()} == "worker ) ( name", "comm must use last closing parenthesis");
    require(parsed->utime == 100 && parsed->stime == 50 && parsed->starttime == 12345, "stat fields must retain their numbering");
    require(!parse_stat("42 (bad) S 0"), "truncated stat must fail");
    require(!parse_number<std::uint64_t>("-1"), "negative counters must fail");
    require(!parse_number<std::uint64_t>("18446744073709551616"), "counter overflow must fail");
    require(!parse_number<int>("12garbage"), "partially parsed numbers must fail");
    require(parse_syscall("running\n").number == -2, "running syscall sentinel");
    require(parse_syscall("-1 0x0 0x0\n").number == -1, "not-in-syscall sentinel");
    require(parse_syscall("denied").unreadable(), "invalid syscall is unreadable");
    const auto syscall = parse_syscall(std::format("{} 0x123 0x189 0x0 0x1234 0x0", SYS_futex));
    require(syscall.number == SYS_futex && syscall.futex_op == 393 && syscall.timeout_set, "futex flags and timeout pointer");
    require(parse_syscall(std::format("{} 0x123 0x80", SYS_futex)).unreadable(), "incomplete futex must not look like a lock wait");
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
        require(std::to_integer<unsigned>(bytes[index]) == parse_hex(expected.substr(index * 2, 2)), "wire bytes must match v1 golden packet");
    }
}

void test_wire() {
    ThreadStat stat{.state = 'S', .utime = 0x0102030405060708ULL, .stime = 9};
    std::ranges::copy(std::string_view{"worker"}, stat.name.begin());
    const auto record = wire::encode_record(0x01020304, stat, {.number = 202, .futex_op = 393, .timeout_set = true}, {10, 11});
    require_hex(record, "040302015301ca0089010000080706050403020109000000000000000a000000000000000b00000000000000776f726b657200000000000000000000");
    std::array<std::byte, wire::header_size> header{};
    wire::encode_header(header, {.flags = wire::Flags::status_fallback, .chunk = 1, .chunks = 3,
        .session = 0x0102030405060708ULL, .sequence = 0x090a0b0c, .records = 1, .monotonic_ns = 12,
        .wall_ns = 13, .interval_ms = 1000, .pid = 0x01020304});
    require_hex(header, "544d4f4e0102010308070605040302010c0b0a09010000000c000000000000000d00000000000000e803000004030201");
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
