#pragma once

#include <sys/inotify.h>
#include <unistd.h>

#include <array>
#include <cerrno>
#include <cstddef>
#include <cstring>
#include <span>
#include <string_view>

#include "../common/fd.hpp"
#include "io.hpp"

namespace triangulator
{

using namespace std::chrono_literals;

// At most one reload each second, however many edits, events, or SIGHUPs
// arrive. A pending reload waits for the limit; it is never dropped.
inline constexpr Nanoseconds kMinReloadInterval = 1s;
// A failed watch is set up again at most this often.
inline constexpr Nanoseconds kWatchRetryInterval = 10s;

struct WatchEvents
{
  bool changed_ = false;  // the file can differ from the loaded one
  bool lost_ = false;     // the watch no longer reports changes
};

// Reads a buffer of inotify events. An event for the file, and a queue
// overflow (which can have dropped an event for the file), both count as a
// change. A watch that ends, or a directory that moves, loses the watch.
[[nodiscard]] inline WatchEvents ParseWatchEvents(
    std::span<const std::byte> p_bytes, std::string_view p_file_name) noexcept
{
  WatchEvents events;
  std::size_t offset = 0;
  while (offset + sizeof(inotify_event) <= p_bytes.size())
  {
    inotify_event event{};
    std::memcpy(&event, p_bytes.data() + offset, sizeof(event));
    const auto name_offset = offset + sizeof(inotify_event);
    if (name_offset + event.len > p_bytes.size())
    {
      events.changed_ = true;  // a cut record: assume the worst
      break;
    }
    const auto* name =
        reinterpret_cast<const char*>(p_bytes.data()) + name_offset;
    const std::string_view name_text{name, ::strnlen(name, event.len)};
    if ((event.mask & IN_Q_OVERFLOW) != 0)
    {
      events.changed_ = true;
    }
    if ((event.mask & (IN_IGNORED | IN_DELETE_SELF | IN_MOVE_SELF)) != 0)
    {
      events.changed_ = true;
      events.lost_ = true;
    }
    if ((event.mask & (IN_CLOSE_WRITE | IN_MOVED_TO)) != 0 &&
        name_text == p_file_name)
    {
      events.changed_ = true;
    }
    offset = name_offset + event.len;
  }
  return events;
}

// Detects edits of the configuration file without reading it each tick:
// one non-blocking inotify descriptor on its directory, so both an edit in
// place and an atomic rename over the file are seen. A reload is pending
// until it happens, so a burst of events, an overflow, or a lost watch
// cannot leave a valid edit unapplied.
class ConfigWatch final
{
 public:
  explicit ConfigWatch(std::string_view p_path)
  {
    const auto slash = p_path.rfind('/');
    const auto directory = slash == std::string_view::npos
                               ? std::string_view{"."}
                           : slash == 0 ? std::string_view{"/"}
                                        : p_path.substr(0, slash);
    const auto name =
        slash == std::string_view::npos ? p_path : p_path.substr(slash + 1);
    std::memcpy(directory_.data(), directory.data(),
                std::min(directory.size(), directory_.size() - 1));
    std::memcpy(name_.data(), name.data(),
                std::min(name.size(), name_.size() - 1));
    watching_ = Setup();
  }

  // Called once each tick with whether SIGHUP arrived. True when a reload
  // is pending and the rate limit allows it now.
  [[nodiscard]] bool Poll(bool p_signal, Nanoseconds p_now,
                          RateLimitedLogger& p_logger)
  {
    pending_ = pending_ || p_signal;
    if (!watching_ && p_now >= next_setup_)
    {
      watching_ = Setup();
      // Edits made while there was no watch are not known.
      pending_ = pending_ || watching_;
      next_setup_ = p_now + kWatchRetryInterval;
    }
    if (watching_)
    {
      Drain(p_now);
    }
    if (!watching_)
    {
      p_logger.Warn(
          "cannot watch {} for changes; edits apply after SIGHUP until the "
          "watch is set up again",
          std::string_view{directory_.data()});
    }
    return pending_ &&
           (!reloaded_ || p_now - last_reload_ >= kMinReloadInterval);
  }

  // The file was read at p_now, whether it was valid or not.
  void Reloaded(Nanoseconds p_now) noexcept
  {
    pending_ = false;
    reloaded_ = true;
    last_reload_ = p_now;
  }

  // A rate-limited reload must wake the loop even at the 0.2 Hz tick rate.
  [[nodiscard]] Nanoseconds Deadline(Nanoseconds p_tick) const noexcept
  {
    return pending_ && reloaded_
               ? std::min(p_tick, last_reload_ + kMinReloadInterval)
               : p_tick;
  }

  [[nodiscard]] bool Watching() const noexcept
  {
    return watching_;
  }

 private:
  // Reads per tick. A queue with more is treated as an overflow.
  static constexpr int kMaxReads = 4;

  std::array<char, 4096> directory_{};
  std::array<char, 256> name_{};
  FileDescriptor descriptor_;
  bool watching_ = false;
  // The initial read can precede watch setup. Reconcile that gap once.
  bool pending_ = true;
  bool reloaded_ = false;
  Nanoseconds last_reload_{0};
  Nanoseconds next_setup_{0};
  alignas(inotify_event) std::array<std::byte, 4096> buffer_{};

  [[nodiscard]] bool Setup()
  {
    descriptor_ = FileDescriptor{::inotify_init1(IN_NONBLOCK | IN_CLOEXEC)};
    if (!descriptor_)
    {
      return false;
    }
    if (::inotify_add_watch(descriptor_.Get(), directory_.data(),
                            IN_CLOSE_WRITE | IN_MOVED_TO | IN_DELETE_SELF |
                                IN_MOVE_SELF | IN_ONLYDIR) < 0)
    {
      descriptor_.Reset();
      return false;
    }
    return true;
  }

  void Drain(Nanoseconds p_now)
  {
    for (int read = 0; read < kMaxReads; ++read)
    {
      const auto length =
          ::read(descriptor_.Get(), buffer_.data(), buffer_.size());
      if (length < 0 && (errno == EAGAIN || errno == EWOULDBLOCK))
      {
        return;
      }
      if (length < 0 && errno == EINTR)
      {
        continue;
      }
      const auto events =
          length > 0
              ? ParseWatchEvents(
                    std::span{buffer_}.first(static_cast<std::size_t>(length)),
                    std::string_view{name_.data()})
              : WatchEvents{true, true};
      pending_ = pending_ || events.changed_;
      if (events.lost_)
      {
        Lose(p_now);
        return;
      }
    }
    pending_ = true;  // more events wait than one tick reads
  }

  void Lose(Nanoseconds p_now)
  {
    descriptor_.Reset();
    watching_ = false;
    pending_ = true;
    next_setup_ = p_now + kWatchRetryInterval;
  }
};

}  // namespace triangulator
