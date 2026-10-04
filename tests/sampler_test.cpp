#include <stdexcept>
#include <type_traits>

#include "../sampler/proc.hpp"

namespace
{

using namespace triangulator;

void Require(bool p_condition, std::string_view p_message)
{
  if (!p_condition)
  {
    throw std::runtime_error(std::string{p_message});
  }
}

void TestParsing()
{
  std::string stat = "42 (worker ) ( name) S";
  for (int field = 4; field <= 52; ++field)
  {
    stat += std::format(" {}", field == 12   ? 7
                               : field == 14 ? 100
                               : field == 15 ? 50
                               : field == 22 ? 12345
                               : field == 39 ? 3
                                             : 0);
  }
  const auto parsed = ParseStat(stat);
  Require(parsed.has_value(), "stat with parentheses must parse");
  Require(std::string_view{parsed->name_.data()} == "worker ) ( name",
          "comm must use last closing parenthesis");
  Require(parsed->utime_ == 100 && parsed->stime_ == 50 &&
              parsed->starttime_ == 12345,
          "stat fields must retain their numbering");
  Require(parsed->major_faults_ == 7 && parsed->processor_ == 3,
          "major faults and last CPU");
  Require(!ParseStat("42 (bad) S 0"), "truncated stat must fail");
  Require(!ParseNumber<std::uint64_t>("-1"), "negative counters must fail");
  Require(!ParseNumber<std::uint64_t>("18446744073709551616"),
          "counter overflow must fail");
  Require(!ParseNumber<int>("12garbage"), "partially parsed numbers must fail");
  Require(
      std::string_view{ParseWchan("futex_do_wait").data()} == "futex_do_wait",
      "plain wchan");
  Require(
      std::string_view{
          ParseWchan("poll_schedule_timeout.constprop.0").data()} ==
          "poll_schedule_timeout",
      "compiler suffix is dropped");
  Require(ParseWchan("0").front() == '\0', "running or hidden wchan is empty");
  Require(ParseWchan(std::string(40, 'x')).back() == 'x',
          "long wchan is truncated without overflow");
  const auto io =
      ParseIo("rchar: 11\nwchar: 22\nsyscr: 3\nsyscw: 4\nread_bytes: 0\n");
  Require(io && io->read_bytes_ == 11 && io->write_bytes_ == 22, "io counters");
  Require(!ParseIo("rchar: 11\n"), "both io counters are required");
  const auto schedstat = ParseSchedstat("123 456 789\n");
  Require(schedstat && schedstat->run_delay_ == 456 &&
              schedstat->timeslices_ == 789,
          "scheduler counters");
  const auto status = ParseStatus(
      "Name:\tworker\nvoluntary_ctxt_switches:\t12\nnonvoluntary_ctxt_switches:"
      "\t34\n");
  Require(status && status->run_delay_ == 34 && status->timeslices_ == 12,
          "fallback counters must not be swapped");
  Require(!ParseStatus("nonvoluntary_ctxt_switches: 1\n"),
          "both fallback counters are required");
}

void TestConfig()
{
  const auto config = ParseConfig(
      "target_process = \"name #1\" # "
      "comment\nrate_hz=0.2\ncollector=\"[::1]:9400\"\nstatus_fallback=true\n");
  Require(config.has_value(), "valid configuration");
  Require(std::get<TargetName>(config->target_).value_ == "name #1",
          "quoted hash is part of process name");
  Require(config->Interval() == 5s && config->IntervalMs() == 5000,
          "rate converted to chrono duration");
  Require(config->status_fallback_, "fallback flag");
  for (const auto invalid : {
           "target_pid=1\ntarget_process=foo\ncollector=127.0.0.1:9400",
           "target_pid=1\ncollector=127.0.0.1:9400\nrate_hz=nan",
           "target_pid=1\ncollector=127.0.0.1:9400\nrate_hz=10.1",
           "target_pid=1\ncollector=127.0.0.1:9400\nrate_hz=0.19",
           "target_pid=1\ntarget_pid=2\ncollector=127.0.0.1:9400",
           "target_pid=1\ncollector=\"127.0.0.1:9400",
           "target_pid=-1\ncollector=127.0.0.1:9400",
           "target_pid=1\ncollector=127.0.0.1:9400\nunknown=true",
       })
  {
    Require(!ParseConfig(invalid), "invalid config must be rejected");
  }
  for (const auto invalid : {"localhost:9400", "127.0.0.1:65536", "127.0.0.1:0",
                             "[::1:9400", "127.0.0.1:no"})
  {
    Require(!MakeEndpoint(invalid),
            "invalid/non-numeric endpoint must be rejected");
  }
  const auto endpoint = MakeEndpoint("127.0.0.1:9400");
  Require(endpoint.has_value(), "numeric endpoint must work");
  Require((::fcntl(endpoint->socket_.Get(), F_GETFL) & O_NONBLOCK) != 0,
          "UDP socket must be nonblocking");
  Require((::fcntl(endpoint->socket_.Get(), F_GETFD) & FD_CLOEXEC) != 0,
          "UDP socket must be close-on-exec");
}

void RequireHex(std::span<const std::byte> p_bytes, std::string_view p_expected)
{
  Require(p_bytes.size() * 2 == p_expected.size(), "golden packet length");
  for (std::size_t index = 0; index < p_bytes.size(); ++index)
  {
    Require(std::to_integer<unsigned>(p_bytes[index]) ==
                ParseHex(p_expected.substr(index * 2, 2)),
            "wire bytes must match v2 golden packet");
  }
}

void TestWire()
{
  ThreadStat stat{.state_ = 'S',
                  .major_faults_ = 5,
                  .utime_ = 0x0102030405060708ULL,
                  .stime_ = 9,
                  .processor_ = 0x0102};
  std::ranges::copy(std::string_view{"worker"}, stat.name_.begin());
  const auto record =
      wire::EncodeRecord(0x01020304, stat, {10, 11}, IoCounters{12, 13},
                         ParseWchan("futex_do_wait"));
  RequireHex(
      record,
      "04030201530002010807060504030201090000000000000"
      "00a000000000000000b0000000000000005000000000000000c000000000000000d00000"
      "000000000"
      "776f726b657200000000000000000000"
      "66757465785f646f5f7761697400000000000000000000000000000000000000");
  const auto missing_io =
      wire::EncodeRecord(1, stat, {10, 11}, std::nullopt, WaitChannel{});
  Require(missing_io[5] == std::byte{1}, "unreadable io is flagged");
  std::array<std::byte, wire::kHeaderSize> header{};
  wire::EncodeHeader(header, {.flags_ = wire::Flags::StatusFallback,
                              .chunk_ = 1,
                              .chunks_ = 3,
                              .session_ = 0x0102030405060708ULL,
                              .sequence_ = 0x090a0b0c,
                              .records_ = 1,
                              .monotonic_ns_ = 12,
                              .wall_ns_ = 13,
                              .interval_ms_ = 1000,
                              .pid_ = 0x01020304});
  RequireHex(header,
             "544d4f4e0202010308070605040302010c0b0a09010000000c000000000000000"
             "d00000000000000e803000004030201");
}

void TestRaii()
{
  static_assert(!std::is_copy_constructible_v<FileDescriptor>);
  static_assert(std::is_nothrow_move_constructible_v<FileDescriptor>);
  static_assert(!std::is_copy_constructible_v<Thread>);
  static_assert(std::is_nothrow_move_assignable_v<Thread>);
  int closed_descriptor;
  {
    auto original = OpenReadonly("/dev/null");
    Require(static_cast<bool>(original), "open descriptor");
    closed_descriptor = original.Get();
    auto moved = std::move(original);
    Require(!original && moved.Get() == closed_descriptor,
            "move must transfer ownership");
    auto destination = OpenReadonly("/dev/null");
    const auto replaced_descriptor = destination.Get();
    destination = std::move(moved);
    Require(!moved && destination.Get() == closed_descriptor,
            "move assignment transfers ownership");
    Require(::fcntl(replaced_descriptor, F_GETFD) == -1 && errno == EBADF,
            "move assignment closes old descriptor");
  }
  Require(::fcntl(closed_descriptor, F_GETFD) == -1 && errno == EBADF,
          "destructor closes descriptor");
}

}  // namespace

std::size_t OpenDescriptors()
{
  std::size_t count = 0;
  const Directory directory{::opendir("/proc/self/fd")};
  while (::readdir(directory.get()))
  {
    ++count;
  }
  return count;
}

void TestDescriptorBudget()
{
  Require(ThreadCache{10}.MaxKept() == 0,
          "a tiny limit keeps no descriptors open");
  Require(ThreadCache{ThreadCache::kReservedDescriptors +
                      2 * Thread::kDescriptorsPerThread}
                  .MaxKept() == 2,
          "budget is the limit minus the reserve, divided per thread");
  RateLimitedLogger logger;
  const int pid = ::getpid();
  Thread transient{pid, false};
  const auto before = OpenDescriptors();
  Require(transient.TakeSample(pid, false, logger).has_value(),
          "transient thread samples");
  Require(OpenDescriptors() == before,
          "a thread over the budget holds no descriptors between ticks");
  Thread kept{pid, true};
  Require(kept.TakeSample(pid, false, logger).has_value(),
          "kept thread samples");
  Require(OpenDescriptors() == before + Thread::kDescriptorsPerThread,
          "a thread within the budget keeps its files open");
  Require(RaiseDescriptorLimit() >= 64, "descriptor limit is readable");
}

int main()
{
  try
  {
    TestParsing();
    TestConfig();
    TestWire();
    TestRaii();
    TestDescriptorBudget();
    std::puts(
        "C++ sampler tests passed (parsing, configuration, wire compatibility, "
        "RAII, descriptor budget)");
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
