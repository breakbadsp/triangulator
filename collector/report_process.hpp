#pragma once

#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <sys/wait.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <filesystem>
#include <format>
#include <optional>
#include <span>
#include <string>
#include <system_error>
#include <vector>

#include "../common/fd.hpp"

extern char** environ;

namespace triangulator::collector
{
// Reports live in a separate process. Only this bounded stdout bridge runs in
// the HTTP worker; helper failures/timeouts cannot delay UDP ingestion. The
// helper is the executable named p_name in the collector's own directory.
inline std::optional<std::string> RunReportHelper(
    std::string_view p_name, std::span<const std::string> p_arguments)
{
  std::array<char, 4096> executable{};
  const auto length =
      ::readlink("/proc/self/exe", executable.data(), executable.size());
  if (length <= 0 || static_cast<std::size_t>(length) == executable.size())
  {
    return std::nullopt;
  }
  const auto helper =
      (std::filesystem::path{
           std::string{executable.data(), static_cast<std::size_t>(length)}}
           .parent_path() /
       std::string{p_name})
          .string();
  int descriptors[2]{};
  if (::pipe2(descriptors, O_CLOEXEC) != 0)
  {
    return std::nullopt;
  }
  FileDescriptor reader{descriptors[0]};
  FileDescriptor writer{descriptors[1]};
  posix_spawn_file_actions_t actions{};
  if (::posix_spawn_file_actions_init(&actions) != 0)
  {
    return std::nullopt;
  }
  const int action_status =
      ::posix_spawn_file_actions_adddup2(&actions, writer.Get(),
                                         STDOUT_FILENO) |
      ::posix_spawn_file_actions_addclose(&actions, reader.Get()) |
      ::posix_spawn_file_actions_addclose(&actions, writer.Get());
  // argv: the helper's name, the arguments, and the terminating null.
  std::vector<std::string> owned{p_arguments.begin(), p_arguments.end()};
  std::vector<char*> arguments{const_cast<char*>(helper.c_str())};
  for (auto& argument : owned)
  {
    arguments.push_back(argument.data());
  }
  arguments.push_back(nullptr);
  pid_t child = -1;
  const int result = action_status
                         ? action_status
                         : ::posix_spawn(&child, helper.c_str(), &actions,
                                         nullptr, arguments.data(), environ);
  ::posix_spawn_file_actions_destroy(&actions);
  writer.Reset();
  if (result != 0)
  {
    return std::nullopt;
  }
  // Always reap, including on allocation failure or helper timeouts.
  class ChildProcess
  {
   public:
    explicit ChildProcess(pid_t p_pid) : pid_(p_pid)
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
    void Release()
    {
      pid_ = -1;
    }

   private:
    pid_t pid_;
  } process{child};
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds{3};
  std::string output;
  std::array<char, 16384> buffer{};
  bool eof = false;
  int status = 0;
  while (std::chrono::steady_clock::now() < deadline)
  {
    if (!eof)
    {
      pollfd ready{reader.Get(), POLLIN, 0};
      const int available = ::poll(&ready, 1, 50);
      if (available < 0 && errno != EINTR)
      {
        return std::nullopt;
      }
      if (available > 0)
      {
        const auto count = ::read(reader.Get(), buffer.data(), buffer.size());
        if (count > 0)
        {
          output.append(buffer.data(), static_cast<std::size_t>(count));
          if (output.size() > 8 * 1024 * 1024)
          {
            return std::nullopt;
          }
        }
        else if (count == 0)
        {
          eof = true;
        }
        else if (errno != EINTR)
        {
          return std::nullopt;
        }
      }
    }
    const auto waited = ::waitpid(child, &status, WNOHANG);
    if (waited == child)
    {
      process.Release();
      if (!WIFEXITED(status) || WEXITSTATUS(status) != 0)
      {
        return std::nullopt;
      }
      // The child has closed stdout. Drain its remaining bounded pipe data.
      while (!eof)
      {
        const auto count = ::read(reader.Get(), buffer.data(), buffer.size());
        if (count > 0)
        {
          output.append(buffer.data(), static_cast<std::size_t>(count));
          if (output.size() > 8 * 1024 * 1024)
          {
            return std::nullopt;
          }
        }
        else if (count == 0)
        {
          eof = true;
        }
        else if (errno != EINTR)
        {
          return std::nullopt;
        }
      }
      return output;
    }
    if (waited < 0 && errno != EINTR)
    {
      return std::nullopt;
    }
    if (eof)
    {
      // stdout can close just before exit; avoid spinning while it exits.
      ::poll(nullptr, 0, 10);
    }
  }
  return std::nullopt;
}
}  // namespace triangulator::collector
