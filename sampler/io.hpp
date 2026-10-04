#pragma once

#include <dirent.h>
#include <fcntl.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <limits>
#include <memory>
#include <optional>
#include <span>
#include <string_view>
#include <system_error>
#include <utility>

namespace triangulator
{

class FileDescriptor
{
 public:
  FileDescriptor() = default;
  explicit FileDescriptor(int p_descriptor) noexcept : descriptor_(p_descriptor)
  {
  }
  ~FileDescriptor()
  {
    Reset();
  }
  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;
  FileDescriptor(FileDescriptor&& p_other) noexcept
      : descriptor_(std::exchange(p_other.descriptor_, -1))
  {
  }
  FileDescriptor& operator=(FileDescriptor&& p_other) noexcept
  {
    if (this != &p_other)
    {
      Reset(std::exchange(p_other.descriptor_, -1));
    }
    return *this;
  }
  [[nodiscard]] int Get() const noexcept
  {
    return descriptor_;
  }
  [[nodiscard]] explicit operator bool() const noexcept
  {
    return descriptor_ >= 0;
  }
  void Reset(int p_descriptor = -1) noexcept
  {
    if (descriptor_ >= 0)
    {
      ::close(descriptor_);
    }
    descriptor_ = p_descriptor;
  }

 private:
  int descriptor_ = -1;
};

struct DirectoryCloser
{
  void operator()(DIR* p_directory) const noexcept
  {
    ::closedir(p_directory);
  }
};
using Directory = std::unique_ptr<DIR, DirectoryCloser>;

[[nodiscard]] inline FileDescriptor OpenReadonly(const char* p_path)
{
  return FileDescriptor{::open(p_path, O_RDONLY | O_CLOEXEC)};
}

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

[[nodiscard]] inline Nanoseconds ClockNow(clockid_t p_clock)
{
  timespec value{};
  if (::clock_gettime(p_clock, &value) != 0)
  {
    throw std::system_error(errno, std::generic_category(), "clock_gettime");
  }
  return std::chrono::seconds{value.tv_sec} + Nanoseconds{value.tv_nsec};
}

class RateLimitedLogger
{
 public:
  void Warn(std::string_view p_message)
  {
    const auto now = ClockNow(CLOCK_MONOTONIC);
    if (!last_warning_ || now - *last_warning_ >= 60s)
    {
      std::fprintf(stderr, "triangulator: %.*s\n",
                   static_cast<int>(p_message.size()), p_message.data());
      last_warning_ = now;
    }
  }

 private:
  std::optional<Nanoseconds> last_warning_;
};

}  // namespace triangulator
