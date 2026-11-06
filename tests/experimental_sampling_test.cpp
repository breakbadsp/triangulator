#include <linux/filter.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/wait.h>

#include <array>
#include <atomic>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>

#include "../sampler/experimental/uring.hpp"

namespace
{
std::size_t allocations{};
bool track_allocations{};
}  // namespace

// glibc interposition also observes allocations inside dynamic liburing.
#ifdef __GLIBC__
extern "C"
{
  void* __libc_malloc(std::size_t);
  void* __libc_calloc(std::size_t, std::size_t);
  void* __libc_realloc(void*, std::size_t);
  void __libc_free(void*);
  void* malloc(std::size_t p_size) noexcept
  {
    allocations += track_allocations;
    return __libc_malloc(p_size);
  }
  void* calloc(std::size_t p_count, std::size_t p_size) noexcept
  {
    allocations += track_allocations;
    return __libc_calloc(p_count, p_size);
  }
  void* realloc(void* p_pointer, std::size_t p_size) noexcept
  {
    allocations += track_allocations;
    return __libc_realloc(p_pointer, p_size);
  }
  void free(void* p_pointer) noexcept
  {
    __libc_free(p_pointer);
  }
}
#endif

namespace triangulator::experimental
{
namespace
{
void Require(bool p_condition, std::string_view p_message)
{
  if (!p_condition)
  {
    throw std::runtime_error(std::string{p_message});
  }
}

class Fixture final
{
 public:
  Fixture()
  {
    std::array<char, 64> pattern{};
    std::string_view{"/tmp/triangulator-uring-test-XXXXXX"}.copy(
        pattern.data(), pattern.size() - 1);
    const auto* const directory = ::mkdtemp(pattern.data());
    Require(directory != nullptr, "temporary directory");
    root_ = directory;
    for (int tid = 1; tid <= 65; ++tid)
    {
      std::filesystem::create_directories(Path(tid, ""));
      Write(tid, "stat", Stat(10));
      Write(tid, "schedstat", "100 20 30\n");
      Write(tid, "wchan", "futex_wait\n");
      Write(tid, "io",
            std::format("rchar: {}\nwchar: {}\n", tid * 11, tid * 22));
    }
  }
  ~Fixture()
  {
    std::error_code error;
    std::filesystem::remove_all(root_, error);
  }
  Fixture(const Fixture&) = delete;
  Fixture& operator=(const Fixture&) = delete;
  Fixture(Fixture&&) = delete;
  Fixture& operator=(Fixture&&) = delete;
  [[nodiscard]] const char* Root() const
  {
    return root_.c_str();
  }
  [[nodiscard]] std::filesystem::path Path(int p_tid, const char* p_file) const
  {
    return std::filesystem::path{root_} / "1" / "task" / std::to_string(p_tid) /
           p_file;
  }
  void Write(int p_tid, const char* p_file, const std::string& p_text) const
  {
    std::ofstream file{Path(p_tid, p_file)};
    file << p_text;
    Require(file.good(), "write fixture");
  }
  [[nodiscard]] static std::string Stat(int p_starttime)
  {
    auto stat = std::string{"1 (fixture) S"};
    for (int field = 4; field <= 52; ++field)
    {
      stat += std::format(" {}", field == 22 ? p_starttime : 0);
    }
    return stat + "\n";
  }

 private:
  std::string root_;
};

[[nodiscard]] std::unique_ptr<Sampler> Make(const Fixture& p_fixture,
                                            std::span<const int> p_tids)
{
  auto made = Sampler::Create();
  Require(made.has_value(), "ring setup");
  auto sampler = std::move(*made);
  Require(sampler->Admit(1, p_tids, p_fixture.Root()).has_value(), "admission");
  return sampler;
}

[[nodiscard]] TickCounts Take(Sampler& p_sampler)
{
  const auto tick =
      p_sampler.Tick(ClockNow(CLOCK_MONOTONIC) + std::chrono::seconds{2});
  Require(tick.has_value(), "tick returned a fatal error");
  return *tick;
}

void TestCompletions()
{
  // Queued but unaccepted requests keep ownership through partial completion.
  Completions completions;
  completions.Prepare(4);
  Require(completions.Complete(3), "out-of-order completion");
  Require(completions.Complete(1), "second completion");
  Require(completions.Remaining() == 2, "unsubmitted/unfinished ownership");
  Require(!completions.Complete(3), "duplicate completion rejected");
  Require(!completions.Complete(100), "invalid tag rejected");
  Require(completions.Complete(0), "third completion");
  Require(completions.Complete(2), "final completion");
  Require(completions.Remaining() == 0, "all requests retired");
  completions.Prepare(1);
  Require(completions.Complete(0), "new stage starts after drain");
}

void TestReuseAndErrors()
{
  // Stable synthetic files match production records and preserve reuse rules.
  Fixture fixture;
  const std::array tids{1};
  auto sampler = Make(fixture, tids);
  Require(Take(*sampler).published_ == 1, "initial full record");
  const auto& actual = sampler->Output()[0]->record_;
  Require(actual.comm_[0] == 'f' && actual.state_ == 'S' &&
              actual.read_bytes_ == 11 && actual.write_bytes_ == 22 &&
              actual.run_delay_ == 20 && actual.timeslices_ == 30 &&
              actual.wchan_[0] == 'f',
          "full record matches fixture values");
  fixture.Write(1, "stat", "truncated");
  Require(Take(*sampler).reused_ == 1, "quiet thread skips dependent stat");
  fixture.Write(1, "schedstat", "101 20 30\n");
  Require(Take(*sampler).published_ == 0,
          "a run forces invalid stat rejection");
  Require(Take(*sampler).published_ == 0, "retired generation never revives");

  fixture.Write(1, "stat", Fixture::Stat(10));
  sampler = Make(fixture, tids);
  fixture.Write(1, "wchan", "0");
  Require(Take(*sampler).published_ == 1,
          "hidden wchan still permits full read");
  Require(Take(*sampler).reused_ == 0, "hidden wchan prevents reuse");
  fixture.Write(1, "schedstat", "0 0 0\n");
  fixture.Write(1, "wchan", "futex_wait");
  Require(Take(*sampler).reused_ == 0, "zero counters never permit reuse");
  fixture.Write(1, "io", "rchar: 11\n");
  Require(Take(*sampler).optional_errors_ == 1, "truncated io is unavailable");
  Require(
      sampler->Output()[0]->record_.flags_ == wire::RecordFlags::IoUnavailable,
      "optional io failure cannot emit invented counters");
  fixture.Write(1, "schedstat", "100 20\n");
  Require(Take(*sampler).published_ == 0, "short schedstat rejected");
  fixture.Write(1, "schedstat", std::string(kBufferBytes, '1'));
  Require(Take(*sampler).published_ == 0, "full buffer rejected");
  Require(sampler->ReadErrors() > 0, "truncation counted");
  fixture.Write(1, "schedstat", "200 20 30\n");
  fixture.Write(1, "stat", Fixture::Stat(11));
  Require(Take(*sampler).published_ == 0, "changed starttime cannot publish");
  fixture.Write(1, "stat", Fixture::Stat(10));
  Require(Take(*sampler).published_ == 0, "changed generation stays retired");

  fixture.Write(1, "stat", Fixture::Stat(11));
  sampler = Make(fixture, tids);
  Require(Take(*sampler).published_ == 1, "new run admits changed generation");
  std::filesystem::remove(fixture.Path(1, "wchan"));
  std::filesystem::remove(fixture.Path(1, "io"));
  sampler = Make(fixture, tids);
  Require(Take(*sampler).published_ == 1, "unreadable optional files");
  Require(Take(*sampler).reused_ == 0, "unreadable wchan disables reuse");
  Require(sampler->ReadErrors() >= 4, "completion errors counted");
}

void TestDeadlineAndAllocation()
{
  // Expired chunks keep buffers reserved and later chunks are counted.
  Fixture fixture;
  std::array<int, 65> tids{};
  for (std::size_t index = 0; index < tids.size(); ++index)
  {
    tids[index] = static_cast<int>(index + 1);
  }
  auto sampler = Make(fixture, tids);
  const auto expired = sampler->Tick(Nanoseconds{0});
  Require(expired.has_value(), "expired tick");
  Require(expired->published_ == 0, "late records never publish");
  Require(expired->pending_completion_ + expired->deadline_before_chunk_ == 65,
          "every unserved thread is counted");
  const auto next = sampler->Tick(Nanoseconds{0});
  Require(next.has_value(), "pending chunk survives next tick");
  Require(next->published_ + next->pending_completion_ +
                  next->blocked_by_pending_chunk_ +
                  next->deadline_before_chunk_ ==
              65,
          "later tick omissions are complete");
  std::size_t recovered = 0;
  for (int attempt = 0; attempt < 1000 && recovered != 65; ++attempt)
  {
    recovered = Take(*sampler).published_;
    if (recovered != 65)
    {
      ::usleep(1000);
    }
  }
  Require(recovered == 65, "all chunks recover after drain");
  for (const auto tid : tids)
  {
    fixture.Write(tid, "schedstat", "200 20 30\n");
  }
  for (std::size_t index = 0; index < tids.size(); ++index)
  {
    const auto& sample = sampler->Output()[index];
    Require(sample && sample->record_.tid_ == index + 1 &&
                sample->record_.read_bytes_ == (index + 1) * 11,
            "recovered buffers retain the correct thread identity and data");
  }
  const auto before = allocations;
  track_allocations = true;
  const auto sampled =
      sampler->Tick(ClockNow(CLOCK_MONOTONIC) + std::chrono::seconds{2});
  const auto reused =
      sampler->Tick(ClockNow(CLOCK_MONOTONIC) + std::chrono::seconds{2});
  track_allocations = false;
  Require(sampled && sampled->published_ == 65 && sampled->reused_ == 0,
          "steady full-read tick executes");
  Require(reused && reused->reused_ == 65, "steady reuse tick executes");
#ifdef __GLIBC__
  Require(allocations == before, "steady tick has no userspace allocation");
#else
  static_cast<void>(before);
#endif
}

void TestLiveExit()
{
  // Held proc descriptors cannot turn an exited target into a replacement.
  const auto child = ::fork();
  Require(child >= 0, "fork target");
  if (child == 0)
  {
    ::pause();
    std::_Exit(0);
  }
  auto made = Sampler::Create();
  Require(made.has_value(), "live ring");
  auto sampler = std::move(*made);
  const std::array tids{child};
  const auto admitted = sampler->Admit(child, tids);
  ::kill(child, SIGKILL);
  ::waitpid(child, nullptr, 0);
  Require(admitted.has_value(), "live admission");
  Require(Take(*sampler).published_ == 0, "exited target omitted");
  Require(sampler->ReadErrors() > 0, "exit errors counted");
}
void TestAdmissionAndDeniedSetup()
{
  // A constrained process rejects admission without exceeding its fd budget.
  const auto child = ::fork();
  Require(child >= 0, "fork fd budget test");
  if (child == 0)
  {
    const rlimit limit{38, 38};
    if (::setrlimit(RLIMIT_NOFILE, &limit) != 0)
    {
      std::_Exit(1);
    }
    auto made = Sampler::Create();
    if (!made)
    {
      std::_Exit(1);
    }
    const std::array tids{1, 2};
    const auto result = (*made)->Admit(1, tids);
    std::_Exit(!result && result.error() == EMFILE ? 0 : 1);
  }
  int status{};
  ::waitpid(child, &status, 0);
  Require(WIFEXITED(status) && WEXITSTATUS(status) == 0, "fd admission budget");

  // A real syscall denial reports setup failure rather than synchronous
  // fallback.
  const auto denied = ::fork();
  Require(denied >= 0, "fork denied setup test");
  if (denied == 0)
  {
    std::array<sock_filter, 4> filter{
        {BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(seccomp_data, nr)),
         BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_io_uring_setup, 0, 1),
         BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
         BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW)}};
    sock_fprog program{static_cast<unsigned short>(filter.size()),
                       filter.data()};
    if (::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
        ::prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program))
    {
      std::_Exit(1);
    }
    const auto made = Sampler::Create();
    std::_Exit(!made && made.error() == EPERM ? 0 : 1);
  }
  ::waitpid(denied, &status, 0);
  Require(WIFEXITED(status) && WEXITSTATUS(status) == 0,
          "denied setup is explicit");
}

void TestLiveThreadExit()
{
  // A thread exit omits its record while its process remains alive.
  std::atomic<int> tid{};
  std::atomic<bool> stop{};
  std::jthread target{
      [tid_pointer = &tid, stop_pointer = &stop](std::stop_token p_stop)
      {
        tid_pointer->store(static_cast<int>(::syscall(SYS_gettid)));
        while (!stop_pointer->load() && !p_stop.stop_requested())
        {
          ::usleep(1000);
        }
      }};
  for (int attempt = 0; attempt < 1000 && tid.load() == 0; ++attempt)
  {
    ::usleep(1000);
  }
  const std::array tids{tid.load()};
  auto made = Sampler::Create();
  Require(made.has_value(), "thread exit ring");
  auto sampler = std::move(*made);
  const auto admitted = sampler->Admit(::getpid(), tids);
  stop.store(true);
  target.join();
  Require(admitted.has_value(), "thread exit admission");
  Require(Take(*sampler).published_ == 0, "exited thread cannot publish");
}

}  // namespace
}  // namespace triangulator::experimental

int main()
{
  using namespace triangulator::experimental;
  try
  {
    TestCompletions();
    const auto probe = Sampler::Create();
    if (!probe)
    {
      std::fprintf(stderr, "SKIP_SETUP: io_uring errno %d\n", probe.error());
      return 77;
    }
    TestReuseAndErrors();
    TestDeadlineAndAllocation();
    TestLiveExit();
    TestAdmissionAndDeniedSetup();
    TestLiveThreadExit();
    std::puts("experimental: 6 test groups passed; live ring executed");
    return 0;
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "experimental test: %s\n", error.what());
    return 1;
  }
}
