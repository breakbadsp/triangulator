#pragma once

#include <dirent.h>
#include <fcntl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cassert>
#include <cerrno>
#include <chrono>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <expected>
#include <format>
#include <limits>
#include <optional>
#include <span>
#include <string_view>
#include <utility>

#include "../common/fd.hpp"

namespace triangulator
{

// After startup the sampler does not allocate heap memory (TigerStyle; see
// docs/tigerstyle-adaption.md). These helpers keep that rule: text, paths
// and directory entries go into fixed storage.

// Text formatted into fixed storage, such as a /proc path. Text that does
// not fit becomes empty, so opening it as a path fails with ENOENT.
class FixedString
{
 public:
  static constexpr std::size_t kCapacity = 4096;  // PATH_MAX on Linux

  template <typename... TArgs>
  explicit FixedString(std::format_string<TArgs...> p_format, TArgs&&... p_args)
  {
    const auto result = std::format_to_n(text_.data(), kCapacity - 1, p_format,
                                         std::forward<TArgs>(p_args)...);
    const auto length = static_cast<std::size_t>(result.size);
    length_ = length < kCapacity ? length : 0;
    text_[length_] = '\0';
  }
  [[nodiscard]] const char* CStr() const noexcept
  {
    return text_.data();
  }
  [[nodiscard]] std::string_view View() const noexcept
  {
    return {text_.data(), length_};
  }

 private:
  std::array<char, kCapacity> text_{};
  std::size_t length_ = 0;
};

[[nodiscard]] inline FileDescriptor OpenReadonly(const char* p_path)
{
  return FileDescriptor{::open(p_path, O_RDONLY | O_CLOEXEC)};
}

// Reads a directory with getdents64 into its own buffer. opendir is not
// used because it allocates its buffer on the heap.
class Directory
{
 public:
  // Check with operator bool; on failure errno tells why, as for open().
  explicit Directory(const char* p_path)
      : fd_(::open(p_path, O_RDONLY | O_DIRECTORY | O_CLOEXEC))
  {
  }
  explicit operator bool() const noexcept
  {
    return static_cast<bool>(fd_);
  }
  [[nodiscard]] int Fd() const noexcept
  {
    return fd_.Get();
  }

  // The next entry's name, nullopt at the end, or errno when a read failed.
  // A failed read is not the end: the entries seen so far are incomplete.
  // ENOENT means that the directory of an exited process is gone.
  [[nodiscard]] std::expected<std::optional<std::string_view>, int> Next()
  {
    if (offset_ == length_)
    {
      ssize_t length;
      do
      {
        // glibc declared getdents64 only in 2.30; AlmaLinux 8 has 2.28.
        // The system call itself exists on every kernel we support.
        length = ::syscall(SYS_getdents64, fd_.Get(), buffer_.data(),
                           buffer_.size());
      } while (length < 0 && errno == EINTR);
      if (length < 0)
      {
        return std::unexpected(errno);
      }
      if (length == 0)
      {
        return std::nullopt;
      }
      offset_ = 0;
      length_ = static_cast<std::size_t>(length);
    }
    // Read the record length with memcpy: records are not always aligned
    // for dirent64.
    unsigned short record_length = 0;
    std::memcpy(&record_length,
                buffer_.data() + offset_ + offsetof(dirent64, d_reclen),
                sizeof(record_length));
    const char* name = buffer_.data() + offset_ + offsetof(dirent64, d_name);
    offset_ += record_length;
    return std::string_view{name};
  }

 private:
  FileDescriptor fd_;
  std::array<char, 8192> buffer_{};
  std::size_t offset_ = 0;
  std::size_t length_ = 0;
};

[[nodiscard]] inline std::optional<std::string_view> ReadAtStart(
    const FileDescriptor& p_descriptor, std::span<char> p_buffer)
{
  if (!p_descriptor || p_buffer.empty())
  {
    return std::nullopt;
  }
  ssize_t length;
  do
  {
    length = ::pread(p_descriptor.Get(), p_buffer.data(), p_buffer.size(), 0);
  } while (length < 0 && errno == EINTR);
  if (length <= 0 || static_cast<std::size_t>(length) == p_buffer.size())
  {
    return std::nullopt;
  }
  return std::string_view{p_buffer.data(), static_cast<std::size_t>(length)};
}

// open() failed because this process or the whole system ran out of file
// descriptors. That is our resource problem, not a sign the file is gone.
[[nodiscard]] inline bool DescriptorsExhausted(int p_error) noexcept
{
  return p_error == EMFILE || p_error == ENFILE;
}

// Raises the soft RLIMIT_NOFILE to the hard limit (allowed without privileges)
// and returns the soft limit now in effect.
[[nodiscard]] inline std::size_t RaiseDescriptorLimit() noexcept
{
  rlimit limit{};
  if (::getrlimit(RLIMIT_NOFILE, &limit) != 0)
  {
    return 1024;
  }
  if (limit.rlim_cur < limit.rlim_max)
  {
    rlimit raised = limit;
    raised.rlim_cur = limit.rlim_max;
    if (::setrlimit(RLIMIT_NOFILE, &raised) == 0)
    {
      limit = raised;
    }
  }
  if (limit.rlim_cur == RLIM_INFINITY ||
      limit.rlim_cur > std::numeric_limits<std::size_t>::max())
  {
    return std::numeric_limits<std::size_t>::max();
  }
  return static_cast<std::size_t>(limit.rlim_cur);
}

using Nanoseconds = std::chrono::nanoseconds;
using namespace std::chrono_literals;

// clock_gettime fails only for an unknown clock id or a bad pointer. We
// pass constants and a local, so a failure is a bug, not an operating error.
[[nodiscard]] inline Nanoseconds ClockNow(clockid_t p_clock) noexcept
{
  timespec value{};
  [[maybe_unused]] const int result = ::clock_gettime(p_clock, &value);
  assert(result == 0);
  return std::chrono::seconds{value.tv_sec} + Nanoseconds{value.tv_nsec};
}

// Length of "YYYY-MM-DDTHH:MM:SS.mmmZ ", the UTC time at the start of each log
// line, with the trailing space.
inline constexpr std::size_t kTimestampSize = 25;

// Formats p_wall (time since the Unix epoch) as a UTC timestamp. It uses
// integer arithmetic only, not gmtime_r: glibc can read /etc/localtime and
// allocate on the first call, and the tick path may do neither. The date
// follows the civil-from-days method of Howard Hinnant. A time before the
// epoch gives the epoch.
[[nodiscard]] inline std::array<char, kTimestampSize> FormatTimestamp(
    Nanoseconds p_wall) noexcept
{
  constexpr std::int64_t kMillisecondsPerDay = 86'400'000;
  constexpr std::int64_t kDaysFromYearZeroToEpoch = 719'468;
  constexpr std::int64_t kDaysPerEra = 146'097;  // 400 years
  const auto total_ms = std::max<std::int64_t>(
      0, std::chrono::duration_cast<std::chrono::milliseconds>(p_wall).count());
  const auto days = total_ms / kMillisecondsPerDay;
  const auto day_ms = total_ms % kMillisecondsPerDay;

  const auto shifted = days + kDaysFromYearZeroToEpoch;
  const auto era = shifted / kDaysPerEra;
  const auto day_of_era = shifted % kDaysPerEra;
  const auto year_of_era = (day_of_era - day_of_era / 1460 +
                            day_of_era / 36'524 - day_of_era / 146'096) /
                           365;
  const auto day_of_year =
      day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
  const auto month_index = (5 * day_of_year + 2) / 153;  // 0 is March
  const auto day = day_of_year - (153 * month_index + 2) / 5 + 1;
  const auto month = month_index < 10 ? month_index + 3 : month_index - 9;
  const auto year = year_of_era + era * 400 + (month <= 2 ? 1 : 0);

  std::array<char, kTimestampSize> text{};
  std::size_t position = 0;
  const auto put_digits = [&](std::int64_t p_value, int p_count)
  {
    for (int digit = p_count - 1; digit >= 0; --digit)
    {
      text[position + static_cast<std::size_t>(digit)] =
          static_cast<char>('0' + p_value % 10);
      p_value /= 10;
    }
    position += static_cast<std::size_t>(p_count);
  };
  const auto put_character = [&](char p_character)
  {
    text[position++] = p_character;
  };
  put_digits(year % 10'000, 4);
  put_character('-');
  put_digits(month, 2);
  put_character('-');
  put_digits(day, 2);
  put_character('T');
  put_digits(day_ms / 3'600'000, 2);
  put_character(':');
  put_digits(day_ms / 60'000 % 60, 2);
  put_character(':');
  put_digits(day_ms / 1000 % 60, 2);
  put_character('.');
  put_digits(day_ms % 1000, 3);
  put_character('Z');
  put_character(' ');
  return text;
}

// Writes warnings to stderr (fd 2) without waiting for a reader. fd 2 often
// shares its open file description with the shell or supervisor, so its
// flags are not changed. The way to write is chosen once, at startup:
// - pipe, FIFO or terminal: a private O_NONBLOCK description of the same
//   file. A line below PIPE_BUF then goes whole or fails with EAGAIN, also
//   while other processes write to the pipe;
// - socket, such as a journald stream: send() with MSG_DONTWAIT;
// - regular file or another device: a plain write, which only waits for
//   the page cache. RateLimitedLogger allows one per minute.
// A line that cannot be written at once is dropped.
class WarningSink final
{
 public:
  // One line, prefix included. Below PIPE_BUF (4096).
  static constexpr std::size_t kLineSize = 640;

  explicit WarningSink(int p_descriptor = STDERR_FILENO) noexcept
      : descriptor_(p_descriptor)
  {
    struct stat status{};
    if (::fstat(p_descriptor, &status) != 0)
    {
      return;
    }
    if (S_ISSOCK(status.st_mode))
    {
      mode_ = Mode::Socket;
    }
    else if (S_ISFIFO(status.st_mode) || ::isatty(p_descriptor) == 1)
    {
      // O_NOCTTY: opening a terminal must not make it the controlling one.
      private_.Reset(
          ::open(FixedString{"/proc/self/fd/{}", p_descriptor}.CStr(),
                 O_WRONLY | O_NONBLOCK | O_NOCTTY | O_CLOEXEC));
      mode_ = private_ ? Mode::Private : Mode::Drop;
    }
    else
    {
      mode_ = Mode::Plain;
    }
  }

  // p_message has no prefix and no newline. The line starts with the UTC
  // time, so an operator can tell when it was written. False when the line
  // was not written whole.
  bool Write(std::string_view p_message) noexcept
  {
    std::array<char, kLineSize> line{};
    const auto timestamp = FormatTimestamp(ClockNow(CLOCK_REALTIME));
    std::ranges::copy(timestamp, line.begin());
    const auto result = std::format_to_n(line.data() + kTimestampSize,
                                         line.size() - 1 - kTimestampSize,
                                         "triangulator: {}", p_message);
    const auto length =
        std::min(kTimestampSize + static_cast<std::size_t>(result.size),
                 line.size() - 1);
    line[length] = '\n';
    const std::string_view text{line.data(), length + 1};
    ssize_t written = -1;
    switch (mode_)
    {
      case Mode::Drop:
        break;
      case Mode::Plain:
        written = ::write(descriptor_, text.data(), text.size());
        break;
      case Mode::Private:
        written = ::write(private_.Get(), text.data(), text.size());
        break;
      case Mode::Socket:
        written = ::send(descriptor_, text.data(), text.size(),
                         MSG_DONTWAIT | MSG_NOSIGNAL);
        break;
    }
    return written == static_cast<ssize_t>(text.size());
  }

 private:
  enum class Mode : std::uint8_t
  {
    Drop = 0,  // fd 2 is closed, or a pipe or terminal cannot be reopened
    Plain,
    Private,
    Socket
  };

  int descriptor_;
  FileDescriptor private_;
  Mode mode_ = Mode::Drop;
};

// The process's one stderr sink. Call it once at startup, before the
// sampling loop, so its open() is not part of a tick.
[[nodiscard]] inline WarningSink& StderrSink() noexcept
{
  static WarningSink sink;
  return sink;
}

class RateLimitedLogger
{
 public:
  // Formats the message only when it is printed, into fixed storage. A long
  // message is cut.
  template <typename... TArgs>
  void Warn(std::format_string<TArgs...> p_format, TArgs&&... p_args)
  {
    const auto now = ClockNow(CLOCK_MONOTONIC);
    if (last_warning_ && now - *last_warning_ < 60s)
    {
      return;
    }
    last_warning_ = now;
    std::array<char, 512> message{};
    const auto result =
        std::format_to_n(message.data(), message.size(), p_format,
                         std::forward<TArgs>(p_args)...);
    const auto length =
        std::min(static_cast<std::size_t>(result.size), message.size());
    StderrSink().Write({message.data(), length});
  }

  // The next Warn() prints even when one was printed in the last 60 s. For
  // a rare warning that an operator's own action causes and waits for.
  void AllowNext() noexcept
  {
    last_warning_.reset();
  }

 private:
  std::optional<Nanoseconds> last_warning_;
};

// Allows at most 10 lines in any 60 s. A burst limit, not a fixed gap, so a
// short-lived process still gets its start and end lines while a crash loop
// cannot flood the log.
class BurstLimiter
{
 public:
  static constexpr std::size_t kLines = 10;

  [[nodiscard]] bool Allow(Nanoseconds p_now) noexcept
  {
    auto& oldest = times_[next_];
    if (count_ == kLines && p_now - oldest < 60s)
    {
      return false;
    }
    oldest = p_now;
    next_ = (next_ + 1) % kLines;
    count_ = std::min(count_ + 1, kLines);
    return true;
  }

 private:
  std::array<Nanoseconds, kLines> times_{};
  std::size_t next_ = 0;
  std::size_t count_ = 0;
};

// Lines about what the sampler monitors, such as a target's process start and
// end. Apart from RateLimitedLogger so that these lines and warnings do not
// hide each other.
class LifecycleLogger
{
 public:
  template <typename... TArgs>
  void Log(std::format_string<TArgs...> p_format, TArgs&&... p_args)
  {
    if (!limiter_.Allow(ClockNow(CLOCK_MONOTONIC)))
    {
      return;
    }
    std::array<char, 512> message{};
    const auto result =
        std::format_to_n(message.data(), message.size(), p_format,
                         std::forward<TArgs>(p_args)...);
    StderrSink().Write(
        {message.data(),
         std::min(static_cast<std::size_t>(result.size), message.size())});
  }

 private:
  BurstLimiter limiter_;
};

}  // namespace triangulator
