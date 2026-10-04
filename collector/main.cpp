// Triangulator UDP collector and dashboard: the C++ core collector. It reads
// the Python collector's configuration and wire format and writes the same
// SQLite rollups and HTTP API. It does no alerting: alert rules and delivery
// belong in a separate program that reads the rollups or the HTTP API.

#include <poll.h>
#include <signal.h>
#include <sys/socket.h>

#include <atomic>
#include <chrono>
#include <cstdio>
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
    Log(LogLevel::Error,
        "Alerting is not part of the C++ collector; alert thresholds, "
        "webhook_url, deadman_url and [alerts.smtp] are ignored");
  }

  Storage storage{config.data_dir_, config.retention_days_, config.store_raw_};
  storage.Flush(WallNow());
  Monitor monitor{config, storage, WallNow()};
  auto receiver = BindSocket(config.udp_host_, config.udp_port_, SOCK_DGRAM);
  const int buffer_size = 4 * 1024 * 1024;
  ::setsockopt(receiver.Get(), SOL_SOCKET, SO_RCVBUF, &buffer_size,
               sizeof(buffer_size));
  SharedState state;
  DashboardServer server{config, state};

  struct sigaction action{};
  action.sa_handler = HandleStopSignal;
  ::sigaction(SIGINT, &action, nullptr);
  ::sigaction(SIGTERM, &action, nullptr);
  ::signal(SIGPIPE, SIG_IGN);

  auto sampler_ip = config.sampler_ip_;
  auto next_refresh = std::chrono::steady_clock::time_point{};
  Log(LogLevel::Info,
      std::format("UDP {}:{}; dashboard http://{}:{}", config.udp_host_,
                  config.udp_port_, config.http_host_, config.http_port_));
  std::array<std::byte, 1201> buffer{};
  try
  {
    while (!g_stopped)
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
        if (!sampler_ip || peer_ip == *sampler_ip)
        {
          auto packet = Decode(
              std::span{buffer.data(), static_cast<std::size_t>(length)});
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
          }
        }
      }
      if (std::chrono::steady_clock::now() >= next_refresh)
      {
        auto health = monitor.Health(now);
        health.Set("sampler_ip", Json(sampler_ip));
        auto live = monitor.Snapshot(now);
        live.Set("health", std::move(health));
        state.SetLive(DumpJson(live));
        storage.Flush(now);
        next_refresh =
            std::chrono::steady_clock::now() + std::chrono::milliseconds{500};
      }
    }
  }
  catch (...)
  {
    server.Stop();
    monitor.Close();
    storage.Close();
    throw;
  }
  server.Stop();
  monitor.Close();
  storage.Close();
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
    Log(LogLevel::Error, std::format("Collector stopped: {}", error.what()));
    return 1;
  }
}
