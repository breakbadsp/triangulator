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

// Writes warnings to stderr (fd 2) without blocking the sampling loop. fd 2
// often shares its open file description with the shell or supervisor, so
// its flags are not changed. The way to write is chosen once, at startup:
// - pipe, FIFO or terminal: a private O_NONBLOCK description of the same
//   file. A pipe write of at most PIPE_BUF bytes then completes or fails
//   with EAGAIN, also while other processes write to the pipe;
// - socket, such as a journald stream: send() with MSG_DONTWAIT;
// - anything else, such as a regular file: no write can be made
//   non-blocking, so warnings are held in fixed storage and written by
//   Flush(), which runs only at reload and at exit.
// A warning that cannot be written is counted, and the next written one
// says how many were lost.
class WarningSink final
{
 public:
  // One line, prefix and lost count included. Below PIPE_BUF (4096), so a
  // pipe takes it whole or not at all.
  static constexpr std::size_t kLineSize = 640;
  static constexpr std::size_t kMessageSize = 512;

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
    else if (S_ISFIFO(status.st_mode) ||
             (S_ISCHR(status.st_mode) && ::isatty(p_descriptor) == 1))
    {
      // O_NOCTTY: opening a terminal must not make it the controlling one.
      private_.Reset(
          ::open(FixedString{"/proc/self/fd/{}", p_descriptor}.CStr(),
                 O_WRONLY | O_NONBLOCK | O_NOCTTY | O_CLOEXEC));
      mode_ = private_ ? Mode::NonBlocking : Mode::Hold;
    }
  }

  // Steady state: never blocks. p_message has no prefix and no newline.
  void Write(std::string_view p_message) noexcept
  {
    if (mode_ == Mode::Hold)
    {
      Hold(p_message);
      return;
    }
    std::array<char, kLineSize> line{};
    const auto text = Compose(line, p_message);
    const ssize_t written =
        mode_ == Mode::Socket
            ? ::send(descriptor_, text.data(), text.size(),
                     MSG_DONTWAIT | MSG_NOSIGNAL)
            : ::write(private_.Get(), text.data(), text.size());
    if (written < 0)
    {
      ++lost_;
      return;
    }
    lost_ = 0;
    // A terminal or a stream socket can take part of the line. The next
    // line then starts on a new one.
    cut_ = static_cast<std::size_t>(written) < text.size();
  }

  // Reload and exit only: writes the held warnings, and can block.
  void Flush() noexcept
  {
    if (held_ == 0)
    {
      return;
    }
    std::array<char, kLineSize> line{};
    WriteAll(Compose(line, Text(first_)));
    if (held_ > 2)
    {
      Message count{};
      std::format_to_n(count.data(), count.size() - 1,
                       "{} more warnings were held while stderr could block",
                       held_ - 2);
      WriteAll(Compose(line, Text(count)));
    }
    if (held_ > 1)
    {
      WriteAll(Compose(line, Text(latest_)));
    }
    held_ = 0;
  }

  // Warnings not written since the last written one.
  [[nodiscard]] std::uint64_t Lost() const noexcept
  {
    return lost_;
  }
  // Warnings waiting for Flush().
  [[nodiscard]] std::uint64_t Held() const noexcept
  {
    return held_;
  }

 private:
  enum class Mode : std::uint8_t
  {
    Hold = 0,
    NonBlocking,
    Socket
  };
  using Message = std::array<char, kMessageSize>;

  [[nodiscard]] static std::string_view Text(const Message& p_message) noexcept
  {
    return {p_message.data(), ::strnlen(p_message.data(), p_message.size())};
  }

  [[nodiscard]] std::string_view Compose(std::span<char, kLineSize> p_line,
                                         std::string_view p_message) const
  {
    const auto start = cut_ ? std::string_view{"\n"} : std::string_view{};
    const auto result =
        lost_ == 0
            ? std::format_to_n(p_line.data(), p_line.size() - 1,
                               "{}triangulator: {}", start, p_message)
            : std::format_to_n(p_line.data(), p_line.size() - 1,
                               "{}triangulator: ({} earlier warnings were "
                               "lost) {}",
                               start, lost_, p_message);
    const auto length =
        std::min(static_cast<std::size_t>(result.size), p_line.size() - 1);
    p_line[length] = '\n';
    return {p_line.data(), length + 1};
  }

  void Hold(std::string_view p_message) noexcept
  {
    auto& slot = held_ == 0 ? first_ : latest_;
    slot = {};
    std::ranges::copy(p_message.substr(0, slot.size() - 1), slot.begin());
    ++held_;
  }

  void WriteAll(std::string_view p_text) const noexcept
  {
    while (!p_text.empty())
    {
      const ssize_t written =
          ::write(descriptor_, p_text.data(), p_text.size());
      if (written < 0 && errno == EINTR)
      {
        continue;
      }
      if (written <= 0)
      {
        return;
      }
      p_text.remove_prefix(static_cast<std::size_t>(written));
    }
  }

  int descriptor_;
  FileDescriptor private_;
  Mode mode_ = Mode::Hold;
  std::uint64_t lost_ = 0;
  bool cut_ = false;
  std::uint64_t held_ = 0;
  Message first_{};
  Message latest_{};
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

}  // namespace triangulator
