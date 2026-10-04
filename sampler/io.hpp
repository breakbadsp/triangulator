#pragma once

#include <array>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <dirent.h>
#include <fcntl.h>
#include <memory>
#include <optional>
#include <limits>
#include <span>
#include <string_view>
#include <sys/resource.h>
#include <system_error>
#include <time.h>
#include <unistd.h>
#include <utility>

namespace triangulator {

class FileDescriptor {
public:
    FileDescriptor() = default;
    explicit FileDescriptor(int descriptor) noexcept : descriptor_(descriptor) {}
    ~FileDescriptor() { reset(); }
    FileDescriptor(const FileDescriptor&) = delete;
    FileDescriptor& operator=(const FileDescriptor&) = delete;
    FileDescriptor(FileDescriptor&& other) noexcept
        : descriptor_(std::exchange(other.descriptor_, -1)) {}
    FileDescriptor& operator=(FileDescriptor&& other) noexcept {
        if (this != &other) reset(std::exchange(other.descriptor_, -1));
        return *this;
    }
    [[nodiscard]] int get() const noexcept { return descriptor_; }
    [[nodiscard]] explicit operator bool() const noexcept { return descriptor_ >= 0; }
    void reset(int descriptor = -1) noexcept {
        if (descriptor_ >= 0) ::close(descriptor_);
        descriptor_ = descriptor;
    }

private:
    int descriptor_ = -1;
};

struct DirectoryCloser {
    void operator()(DIR* directory) const noexcept { ::closedir(directory); }
};
using Directory = std::unique_ptr<DIR, DirectoryCloser>;

[[nodiscard]] inline FileDescriptor open_readonly(const char* path) {
    return FileDescriptor{::open(path, O_RDONLY | O_CLOEXEC)};
}

[[nodiscard]] inline std::optional<std::string_view> read_at_start(
    const FileDescriptor& descriptor, std::span<char> buffer) {
    if (!descriptor || buffer.empty()) return std::nullopt;
    ssize_t length;
    do {
        length = ::pread(descriptor.get(), buffer.data(), buffer.size(), 0);
    } while (length < 0 && errno == EINTR);
    if (length <= 0 || static_cast<std::size_t>(length) == buffer.size()) return std::nullopt;
    return std::string_view{buffer.data(), static_cast<std::size_t>(length)};
}

// open() failed because this process or the whole system ran out of file
// descriptors. That is our resource problem, not a sign the file is gone.
[[nodiscard]] inline bool descriptors_exhausted(int error) noexcept {
    return error == EMFILE || error == ENFILE;
}

// Raises the soft RLIMIT_NOFILE to the hard limit (allowed without privileges)
// and returns the soft limit now in effect.
[[nodiscard]] inline std::size_t raise_descriptor_limit() noexcept {
    rlimit limit{};
    if (::getrlimit(RLIMIT_NOFILE, &limit) != 0) return 1024;
    if (limit.rlim_cur < limit.rlim_max) {
        rlimit raised = limit;
        raised.rlim_cur = limit.rlim_max;
        if (::setrlimit(RLIMIT_NOFILE, &raised) == 0) limit = raised;
    }
    if (limit.rlim_cur == RLIM_INFINITY || limit.rlim_cur > std::numeric_limits<std::size_t>::max()) {
        return std::numeric_limits<std::size_t>::max();
    }
    return static_cast<std::size_t>(limit.rlim_cur);
}

using Nanoseconds = std::chrono::nanoseconds;
using namespace std::chrono_literals;

[[nodiscard]] inline Nanoseconds clock_now(clockid_t clock) {
    timespec value{};
    if (::clock_gettime(clock, &value) != 0) {
        throw std::system_error(errno, std::generic_category(), "clock_gettime");
    }
    return std::chrono::seconds{value.tv_sec} + Nanoseconds{value.tv_nsec};
}

class RateLimitedLogger {
public:
    void warn(std::string_view message) {
        const auto now = clock_now(CLOCK_MONOTONIC);
        if (!last_warning_ || now - *last_warning_ >= 60s) {
            std::fprintf(stderr, "triangulator: %.*s\n", static_cast<int>(message.size()), message.data());
            last_warning_ = now;
        }
    }

private:
    std::optional<Nanoseconds> last_warning_;
};

}
