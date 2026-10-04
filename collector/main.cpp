// Triangulator UDP collector and dashboard: the core collector. It decodes
// the sampler's datagrams, writes per-thread SQLite rollups and serves the
// dashboard and HTTP API. It does no alerting: alert rules and delivery
// belong in a separate program that reads the rollups or the HTTP API.

#include <poll.h>
#include <signal.h>
#include <sys/socket.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <exception>
#include <filesystem>
#include <format>
#include <span>
#include <string>
#include <string_view>

#include "config.hpp"
#include "engine.hpp"
#include "http.hpp"
#include "json.hpp"
#include "log.hpp"
#include "protocol.hpp"
#include "storage.hpp"

namespace
{

using namespace triangulator::collector;

std::atomic<bool> g_stopped = false;

void HandleStopSignal(int)
{
  g_stopped = true;
}

[[noreturn]] void Usage(std::string_view p_message)
{
  std::fprintf(stderr,
               "usage: triangulator-collector [-h] [--check-config] config\n"
               "triangulator-collector: error: %.*s\n",
               static_cast<int>(p_message.size()), p_message.data());
  std::exit(2);
}

[[nodiscard]] std::string PeerAddress(const sockaddr_storage& p_peer)
{
  std::array<char, INET6_ADDRSTRLEN> buffer{};
  const void* address =
      p_peer.ss_family == AF_INET6
          ? static_cast<const void*>(
                &reinterpret_cast<const sockaddr_in6&>(p_peer).sin6_addr)
          : static_cast<const void*>(
                &reinterpret_cast<const sockaddr_in&>(p_peer).sin_addr);
  ::inet_ntop(p_peer.ss_family, address, buffer.data(),
              static_cast<socklen_t>(buffer.size()));
  return buffer.data();
}

// Writes the rows the monitor produced since the last call. On failure the
// rows stay pending and the error is returned.
[[nodiscard]] SqliteResult WriteRows(Monitor& p_monitor, Storage& p_storage)
{
  for (const auto& row : p_monitor.PendingRollups())
  {
    if (auto written = p_storage.Rollup(row); !written)
    {
      return written;
    }
  }
  for (const auto& row : p_monitor.PendingRaw())
  {
    if (auto written = p_storage.Raw(row); !written)
    {
      return written;
    }
  }
  p_monitor.ClearRows();
  return {};
}

int Stopped(std::string_view p_reason)
{
  Log(LogLevel::Error, std::format("Collector stopped: {}", p_reason));
  return 1;
}

// Saves what was collected when an exception (a bug, or one from the
// standard library) leaves Run() on its way to main's last-resort handler.
// Without it the open transaction would roll back, losing the rows since
// the last flush and every unfinished window. A normal return shuts down
// explicitly instead, so storage errors can be reported; this does nothing
// then. Errors here are ignored: the exception is what gets reported.
class SaveOnUnwind
{
 public:
  SaveOnUnwind(DashboardServer& p_server, Monitor& p_monitor,
               Storage& p_storage) noexcept
      : server_(p_server), monitor_(p_monitor), storage_(p_storage)
  {
  }
  SaveOnUnwind(const SaveOnUnwind&) = delete;
  SaveOnUnwind& operator=(const SaveOnUnwind&) = delete;

  ~SaveOnUnwind()
  {
    if (std::uncaught_exceptions() <= exceptions_)
    {
      return;
    }
    server_.Stop();
    monitor_.Close();
    static_cast<void>(WriteRows(monitor_, storage_));
    static_cast<void>(storage_.Close());
  }

 private:
  DashboardServer& server_;
  Monitor& monitor_;
  Storage& storage_;
  int exceptions_ = std::uncaught_exceptions();
};

int Run(const std::filesystem::path& p_config_path, bool p_check_config)
{
  auto loaded = LoadConfig(p_config_path);
  if (!loaded)
  {
    Usage(loaded.error());
  }
  const Config config = std::move(*loaded);
  if (p_check_config)
  {
    std::puts("Collector configuration is valid");
    return 0;
  }
  if (config.alerting_ignored_)
  {
    Log(LogLevel::Warning,
        "Alerting is not part of the C++ collector; alert thresholds, "
        "webhook_url, deadman_url and [alerts.smtp] are ignored");
  }

  auto created = Storage::Create(config.data_dir_, config.retention_days_);
  if (!created)
  {
    return Stopped(created.error());
  }
  Storage storage = std::move(*created);
  if (auto flushed = storage.Flush(WallNow()); !flushed)
  {
    return Stopped(flushed.error());
  }
  Monitor monitor{config, WallNow()};
  auto bound = BindSocket(config.udp_host_, config.udp_port_, SOCK_DGRAM);
  if (!bound)
  {
    return Stopped(bound.error());
  }
  const triangulator::FileDescriptor receiver = std::move(*bound);
  const int buffer_size = 4 * 1024 * 1024;
  ::setsockopt(receiver.Get(), SOL_SOCKET, SO_RCVBUF, &buffer_size,
               sizeof(buffer_size));
  SharedState state;
  auto listener = Listen(config.http_host_, config.http_port_);
  if (!listener)
  {
    return Stopped(listener.error());
  }
  DashboardServer server{config, state, std::move(*listener)};
  if (auto started = server.Start(); !started)
  {
    return Stopped(started.error());
  }

  struct sigaction action{};
  action.sa_handler = HandleStopSignal;
  ::sigaction(SIGINT, &action, nullptr);
  ::sigaction(SIGTERM, &action, nullptr);
  ::signal(SIGPIPE, SIG_IGN);

  auto sampler_ip = config.sampler_ip_;
  auto socket_sampler_ip = config.sampler_ip_;
  auto next_refresh = std::chrono::steady_clock::time_point{};
  Log(LogLevel::Info,
      std::format("UDP {}:{}; dashboard http://{}:{}", config.udp_host_,
                  config.udp_port_, config.http_host_, config.http_port_));
  std::array<std::byte, 1201> buffer{};
  const SaveOnUnwind save_on_unwind{server, monitor, storage};
  // The first storage failure. It stops the loop: rows that can't be saved
  // shouldn't be dropped silently.
  SqliteResult storage_ok;
  while (!g_stopped && storage_ok)
  {
    pollfd ready{receiver.Get(), POLLIN, 0};
    ssize_t length = -1;
    sockaddr_storage peer{};
    if (::poll(&ready, 1, 200) > 0)
    {
      socklen_t peer_length = sizeof(peer);
      length = ::recvfrom(receiver.Get(), buffer.data(), buffer.size(), 0,
                          reinterpret_cast<sockaddr*>(&peer), &peer_length);
    }
    const double now = WallNow();
    if (length >= 0)
    {
      const auto peer_ip = PeerAddress(peer);
      const auto data =
          std::span{buffer.data(), static_cast<std::size_t>(length)};
      if (data.size() >= 4 && std::memcmp(data.data(), "TSIO", 4) == 0)
      {
        if (!socket_sampler_ip || peer_ip == *socket_sampler_ip)
        {
          if (const auto observation =
                  triangulator::socket_metrics::Decode(data))
          {
            socket_sampler_ip = peer_ip;
            storage_ok = storage.Socket(now, *observation, data);
          }
          else
          {
            ++monitor.bad_packets_;
          }
        }
      }
      else if (!sampler_ip || peer_ip == *sampler_ip)
      {
        auto packet = Decode(data);
        if (!packet)
        {
          ++monitor.bad_packets_;
        }
        else
        {
          if (!sampler_ip)
          {
            sampler_ip = peer_ip;
            Log(LogLevel::Info,
                std::format("Pinned sampler source to {}", peer_ip));
          }
          monitor.Accept(std::move(*packet), now);
          storage_ok = WriteRows(monitor, storage);
        }
      }
    }
    if (storage_ok && std::chrono::steady_clock::now() >= next_refresh)
    {
      auto health = monitor.Health(now);
      health.Set("sampler_ip", Json(sampler_ip));
      auto live = monitor.Snapshot(now);
      live.Set("health", std::move(health));
      state.SetLive(DumpJson(live));
      storage_ok = WriteRows(monitor, storage);
      if (storage_ok)
      {
        storage_ok = storage.Flush(now);
      }
      next_refresh =
          std::chrono::steady_clock::now() + std::chrono::milliseconds{500};
    }
  }
  server.Stop();
  monitor.Close();
  if (storage_ok)
  {
    storage_ok = WriteRows(monitor, storage);
  }
  // Close even after a failure, so rows from other day files still commit.
  const auto closed = storage.Close();
  if (!storage_ok)
  {
    return Stopped(storage_ok.error());
  }
  if (!closed)
  {
    return Stopped(closed.error());
  }
  return 0;
}

}  // namespace

int main(int p_argc, char** p_argv)
{
  std::optional<std::filesystem::path> config_path;
  bool check_config = false;
  for (int index = 1; index < p_argc; ++index)
  {
    const std::string_view argument = p_argv[index];
    if (argument == "--check-config")
    {
      check_config = true;
    }
    else if (argument == "-h" || argument == "--help")
    {
      std::puts(
          "usage: triangulator-collector [-h] [--check-config] config\n\n"
          "Triangulator UDP collector and dashboard (C++)");
      return 0;
    }
    else if (argument.starts_with('-') || config_path)
    {
      Usage(std::format("unrecognized arguments: {}", argument));
    }
    else
    {
      config_path = argument;
    }
  }
  if (!config_path)
  {
    Usage("the following arguments are required: config");
  }
  try
  {
    return Run(*config_path, check_config);
  }
  catch (const std::exception& error)
  {
    // Last resort for a bug or an exception from the standard library.
    return Stopped(error.what());
  }
}
