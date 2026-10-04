// Read-only socket reporting process. It never receives the UDP stream.
#include <chrono>
#include <cstdio>

#include "../sampler/parsing.hpp"
#include "socket_report.hpp"

int main(int p_argc, char** p_argv)
{
  if (p_argc != 4)
  {
    std::fprintf(stderr, "usage: %s DATA-DIRECTORY PID OBSERVER-ID-OR-EMPTY\n",
                 p_argv[0]);
    return 2;
  }
  const auto pid = triangulator::ParseNumber<std::uint32_t>(p_argv[2]);
  const std::string_view observer{p_argv[3]};
  if (!pid || (!observer.empty() &&
               !triangulator::ParseNumber<unsigned long long>(observer)))
  {
    std::fprintf(stderr, "invalid PID or observer identity\n");
    return 2;
  }
  try
  {
    const double now = std::chrono::duration<double>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count();
    const auto result = triangulator::socket_metrics::SocketReport(
        p_argv[1], *pid, observer, now);
    const auto output = triangulator::collector::DumpJson(result);
    if (std::fwrite(output.data(), 1, output.size(), stdout) != output.size() ||
        std::fflush(stdout))
    {
      return 1;
    }
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "socket report: %s\n", error.what());
    return 1;
  }
  return 0;
}
