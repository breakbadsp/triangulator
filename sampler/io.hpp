#pragma once

#include <dirent.h>
#include <fcntl.h>
#include <sys/resource.h>
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

  // The next entry's name, or nullopt at the end or on a read error.
  [[nodiscard]] std::optional<std::string_view> Next()
  {
    if (offset_ == length_)
    {
      ssize_t length;
      do
      {
        length = ::getdents64(fd_.Get(), buffer_.data(), buffer_.size());
      } while (length < 0 && errno == EINTR);
      if (length <= 0)
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
    std::fprintf(stderr, "triangulator: %.*s\n", static_cast<int>(length),
                 message.data());
  }

 private:
  std::optional<Nanoseconds> last_warning_;
};

}  // namespace triangulator
