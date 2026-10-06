#pragma once

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>

#include <array>
#include <chrono>
#include <expected>
#include <filesystem>
#include <optional>
#include <string>

#include "../common/fd.hpp"
#include "json.hpp"

extern char** environ;

namespace triangulator::collector
{

// Optional local development control, using the same helper as set-target.sh.
// The helper owns /proc inspection, config validation and SIGHUP. Nothing runs
// in the UDP loop, and installations without the script need no Python.
[[nodiscard]] inline std::expected<Json, std::string> RunTargetControl(
    const std::string& p_host, std::int64_t p_port,
    const std::optional<std::string>& p_target)
{
  std::array<char, 4096> executable{};
  const auto length =
      ::readlink("/proc/self/exe", executable.data(), executable.size());
  if (length <= 0 || static_cast<std::size_t>(length) == executable.size())
  {
    return std::unexpected("cannot locate the sampler control helper");
  }
  const auto script =
      (std::filesystem::path{
           std::string{executable.data(), static_cast<std::size_t>(length)}}
           .parent_path()
           .parent_path() /
       "scripts/sampler_control.py")
          .string();
  std::error_code error;
  if (!std::filesystem::is_regular_file(script, error))
  {
    return JsonObject{{"enabled", false}};
  }
  int descriptors[2]{};
  if (::pipe2(descriptors, O_CLOEXEC | O_NONBLOCK) != 0)
  {
    return std::unexpected("cannot open the sampler control pipe");
  }
  FileDescriptor reader{descriptors[0]};
  FileDescriptor writer{descriptors[1]};
  posix_spawn_file_actions_t actions{};
  if (::posix_spawn_file_actions_init(&actions) != 0)
  {
    return std::unexpected("cannot prepare sampler control");
  }
  const int action_status =
      ::posix_spawn_file_actions_adddup2(&actions, writer.Get(), STDOUT_FILENO);
  std::string interpreter = "python3";
  std::string command = "dashboard-target";
  std::string host = p_host;
  std::string port = std::to_string(p_port);
  std::string target = p_target.value_or("");
  std::array<char*, 7> arguments{interpreter.data(),
                                 const_cast<char*>(script.c_str()),
                                 command.data(),
                                 host.data(),
                                 port.data(),
                                 p_target ? target.data() : nullptr,
                                 nullptr};
  pid_t child = -1;
  const int spawned =
      action_status ? action_status
                    : ::posix_spawnp(&child, interpreter.c_str(), &actions,
                                     nullptr, arguments.data(), environ);
  ::posix_spawn_file_actions_destroy(&actions);
  writer.Reset();
  if (spawned != 0)
  {
    return std::unexpected(
        "cannot start sampler control; Python 3 is required");
  }
  class ChildProcess final
  {
   public:
    explicit ChildProcess(pid_t p_pid) noexcept : pid_(p_pid)
    {
    }
    ~ChildProcess()
    {
      if (pid_ > 0)
      {
        ::kill(pid_, SIGKILL);
        while (::waitpid(pid_, nullptr, 0) < 0 && errno == EINTR)
        {
        }
      }
    }
    ChildProcess(const ChildProcess&) = delete;
    ChildProcess& operator=(const ChildProcess&) = delete;
    ChildProcess(ChildProcess&&) = delete;
    ChildProcess& operator=(ChildProcess&&) = delete;
    void Release() noexcept
    {
      pid_ = -1;
    }

   private:
    pid_t pid_;
  } process{child};
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds{12};
  std::string output;
  std::array<char, 4096> buffer{};
  bool eof = false;
  while (std::chrono::steady_clock::now() < deadline)
  {
    if (!eof)
    {
      pollfd ready{reader.Get(), POLLIN, 0};
      if (::poll(&ready, 1, 50) > 0)
      {
        const auto count = ::read(reader.Get(), buffer.data(), buffer.size());
        if (count > 0)
        {
          output.append(buffer.data(), static_cast<std::size_t>(count));
          if (output.size() > 65536)
          {
            return std::unexpected("sampler control response is too large");
          }
        }
        else if (count == 0)
        {
          eof = true;
        }
        else if (errno != EINTR && errno != EAGAIN)
        {
          return std::unexpected("cannot read sampler control response");
        }
      }
      continue;
    }
    int status = 0;
    const auto waited = ::waitpid(child, &status, WNOHANG);
    if (waited == child)
    {
      process.Release();
      if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
      {
        return std::unexpected(
            "sampler control failed; check the collector log");
      }
      return ParseJson(output);
    }
    if (waited < 0 && errno != EINTR)
    {
      return std::unexpected("cannot wait for sampler control");
    }
    ::poll(nullptr, 0, 10);
  }
  return std::unexpected(
      "sampler control timed out; check the dashboard before retrying");
}

}  // namespace triangulator::collector
