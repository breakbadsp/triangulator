#pragma once

#include <poll.h>
#include <sys/socket.h>

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <expected>
#include <optional>
#include <span>
#include <string_view>
#include <system_error>
#include <utility>

#include "../common/fd.hpp"

namespace triangulator::collector
{

// Each connection has a total read deadline and a separate total write
// deadline. Nonblocking I/O lets shutdown interrupt either operation without
// closing a descriptor from another thread.
class HttpConnection final
{
 public:
  HttpConnection(FileDescriptor p_socket, const std::atomic<bool>& p_stopped)
      : socket_(std::move(p_socket)),
        stopped_(p_stopped),
        read_deadline_(std::chrono::steady_clock::now() + kTimeout)
  {
  }

  // The client's address, as the kernel reports it.
  [[nodiscard]] std::optional<sockaddr_storage> Client() const
  {
    sockaddr_storage peer{};
    socklen_t length = sizeof(peer);
    if (::getpeername(socket_.Get(), reinterpret_cast<sockaddr*>(&peer),
                      &length) != 0)
    {
      return std::nullopt;
    }
    return peer;
  }

  [[nodiscard]] std::expected<std::size_t, std::error_code> Read(
      std::span<char> p_buffer) const
  {
    for (;;)
    {
      if (auto ready = Wait(POLLIN, read_deadline_); !ready)
      {
        return std::unexpected(ready.error());
      }
      const auto count =
          ::recv(socket_.Get(), p_buffer.data(), p_buffer.size(), MSG_DONTWAIT);
      if (count >= 0)
      {
        return static_cast<std::size_t>(count);
      }
      const std::error_code error{errno, std::generic_category()};
      if (error.value() != EINTR && error.value() != EAGAIN &&
          error.value() != EWOULDBLOCK)
      {
        return std::unexpected(error);
      }
    }
  }

  [[nodiscard]] std::expected<void, std::error_code> Write(
      std::string_view p_text) const
  {
    const auto deadline = std::chrono::steady_clock::now() + kTimeout;
    while (!p_text.empty())
    {
      if (auto ready = Wait(POLLOUT, deadline); !ready)
      {
        return ready;
      }
      const auto count = ::send(socket_.Get(), p_text.data(), p_text.size(),
                                MSG_DONTWAIT | MSG_NOSIGNAL);
      if (count > 0)
      {
        p_text.remove_prefix(static_cast<std::size_t>(count));
        continue;
      }
      const std::error_code error{count == 0 ? EPIPE : errno,
                                  std::generic_category()};
      if (error.value() != EINTR && error.value() != EAGAIN &&
          error.value() != EWOULDBLOCK)
      {
        return std::unexpected(error);
      }
    }
    return {};
  }

 private:
  static constexpr auto kTimeout = std::chrono::seconds{5};
  FileDescriptor socket_;
  const std::atomic<bool>& stopped_;
  std::chrono::steady_clock::time_point read_deadline_;

  [[nodiscard]] std::expected<void, std::error_code> Wait(
      short p_events, std::chrono::steady_clock::time_point p_deadline) const
  {
    while (!stopped_)
    {
      const auto remaining = p_deadline - std::chrono::steady_clock::now();
      if (remaining <= std::chrono::steady_clock::duration::zero())
      {
        return std::unexpected(
            std::error_code{ETIMEDOUT, std::generic_category()});
      }
      pollfd ready{socket_.Get(), p_events, 0};
      const auto timeout =
          std::min(std::chrono::ceil<std::chrono::milliseconds>(remaining),
                   std::chrono::milliseconds{100});
      const int result = ::poll(&ready, 1, static_cast<int>(timeout.count()));
      if (result > 0)
      {
        return {};
      }
      if (result < 0 && errno != EINTR)
      {
        return std::unexpected(std::error_code{errno, std::generic_category()});
      }
    }
    return std::unexpected(std::error_code{ECANCELED, std::generic_category()});
  }
};

}  // namespace triangulator::collector
