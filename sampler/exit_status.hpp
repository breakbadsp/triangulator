#pragma once

// How did the target end? The kernel log names only the faults it handles
// and the out-of-memory killer. abort(), a crash handler that re-raises the
// signal, a runtime that catches SIGSEGV (Go, the JVM) and a signal from
// another process leave no kernel message. The exit status names the signal
// in every one of those cases.
//
// The sampler is not the target's parent, so it cannot wait() for the
// status. Since Linux 6.15, any process that holds a pidfd for a process when
// it ends can read the status with PIDFD_GET_INFO, even after the parent has
// reaped it. It needs no privileges. While the process is a zombie, the
// status is also field 52 of /proc/PID/stat (Linux 3.5 and later); the pidfd
// has it only once the parent has reaped the process.

#include <sys/ioctl.h>
#include <sys/syscall.h>
#include <unistd.h>

#include <array>
#include <cstdint>
#include <optional>
#include <string_view>

#include "../common/exit_wire.hpp"
#include "../common/fd.hpp"
#include "io.hpp"
#include "parsing.hpp"
#include "proc.hpp"

namespace triangulator
{

// The first published layout of struct pidfd_info in <linux/pidfd.h>
// (PIDFD_INFO_SIZE_VER0), which already has exit_code. The kernel reads the
// size from the ioctl number and fills only what fits, so this works with
// every kernel that has PIDFD_GET_INFO and builds with older kernel headers.
struct PidfdInfo
{
  std::uint64_t mask_{};
  std::uint64_t cgroup_id_{};
  // pid, tgid, ppid and the real, effective, saved and file-system user and
  // group IDs. Not used here.
  std::array<std::uint32_t, 11> ids_{};
  std::int32_t exit_code_{};
};
static_assert(sizeof(PidfdInfo) == 64);

// PIDFS_IOCTL_MAGIC, request 11.
inline constexpr unsigned long kPidfdGetInfo = _IOWR(0xFF, 11, PidfdInfo);
// PIDFD_INFO_EXIT: asks for exit_code, and is set in the returned mask only
// when the kernel filled it in.
inline constexpr std::uint64_t kPidfdInfoExit = 1U << 3;

// The exit status in field 52 of /proc/PID/stat, in waitpid(2) form. The
// kernel sets it when the process ends; it is zero while the process runs.
// nullopt when the field is missing (before Linux 3.5) or not a status.
[[nodiscard]] inline std::optional<std::int32_t> ParseExitCode(
    std::string_view p_stat)
{
  constexpr int kExitCodeField = 52;
  const auto name_end = p_stat.rfind(')');
  if (name_end == std::string_view::npos)
  {
    return std::nullopt;
  }
  // Field 3 follows the name, which may contain spaces and ')'.
  auto fields = p_stat.substr(name_end + 1);
  std::string_view token;
  for (int field = 3; field <= kExitCodeField; ++field)
  {
    token = NextToken(fields);
    if (token.empty())
    {
      return std::nullopt;
    }
  }
  const auto value = ParseNumber<std::int32_t>(token);
  if (!value || *value < 0 || *value > exit_wire::kMaxWaitStatus)
  {
    return std::nullopt;
  }
  return value;
}

// Holds a pidfd for the current target, so its exit status can be read
// after it ends. Allocates nothing.
class ExitStatusWatch final
{
 public:
  // Starts watching a newly found target. When pidfd_open fails (before
  // Linux 5.3, or under a seccomp filter), the status is read only while
  // the process is a zombie. The PID is checked again after the open: if it
  // was reused in between, the pidfd names another process and is dropped.
  void Watch(const TargetIdentity& p_target)
  {
    pidfd_.Reset(static_cast<int>(::syscall(SYS_pidfd_open, p_target.pid_, 0)));
    if (!pidfd_)
    {
      return;
    }
    const auto stat = ReadStat(p_target.pid_);
    if (!stat || stat->starttime_ != p_target.starttime_)
    {
      pidfd_.Reset();
    }
  }

  // Stops watching, for a target change while the old process still runs.
  void Stop() noexcept
  {
    pidfd_.Reset();
  }

  // The wait status of p_target, which has ended, or nullopt when it cannot
  // be read: a kernel before 6.15 and a process that is no longer a zombie.
  // Ends the watch.
  [[nodiscard]] std::optional<std::int32_t> Collect(
      const TargetIdentity& p_target)
  {
    const auto reaped = FromPidfd();
    pidfd_.Reset();
    if (reaped)
    {
      return reaped;
    }
    return FromZombie(p_target);
  }

 private:
  struct Stat
  {
    std::uint64_t starttime_{};
    char state_{};
    std::optional<std::int32_t> exit_code_;
  };

  [[nodiscard]] static std::optional<Stat> ReadStat(int p_pid)
  {
    std::array<char, 4096> buffer{};
    const auto descriptor =
        OpenReadonly(FixedString{"/proc/{}/stat", p_pid}.CStr());
    const auto text = ReadAtStart(descriptor, buffer);
    if (!text)
    {
      return std::nullopt;
    }
    const auto stat = ParseStat(*text);
    if (!stat)
    {
      return std::nullopt;
    }
    return Stat{.starttime_ = stat->starttime_,
                .state_ = stat->state_,
                .exit_code_ = ParseExitCode(*text)};
  }

  // The kernel fills exit_code once the parent has reaped the process.
  [[nodiscard]] std::optional<std::int32_t> FromPidfd() const
  {
    if (!pidfd_)
    {
      return std::nullopt;
    }
    PidfdInfo info{.mask_ = kPidfdInfoExit};
    if (::ioctl(pidfd_.Get(), kPidfdGetInfo, &info) != 0 ||
        (info.mask_ & kPidfdInfoExit) == 0 || info.exit_code_ < 0 ||
        info.exit_code_ > exit_wire::kMaxWaitStatus)
    {
      return std::nullopt;
    }
    return info.exit_code_;
  }

  [[nodiscard]] static std::optional<std::int32_t> FromZombie(
      const TargetIdentity& p_target)
  {
    const auto stat = ReadStat(p_target.pid_);
    if (!stat || stat->starttime_ != p_target.starttime_ || stat->state_ != 'Z')
    {
      return std::nullopt;
    }
    return stat->exit_code_;
  }

  FileDescriptor pidfd_;
};

}  // namespace triangulator
