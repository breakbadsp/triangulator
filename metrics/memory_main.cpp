// Read-only memory report process. It never receives the UDP stream.
#include <chrono>
#include <cstdio>

#include "../sampler/parsing.hpp"
#include "memory_report.hpp"

namespace
{
constexpr const char* kUsage = "usage: %s DATA-DIRECTORY PID-OR-0 AT-OR-0\n";
}

int main(int p_argc, char** p_argv)
{
  if (p_argc == 2 && (std::string_view{p_argv[1]} == "-h" ||
                      std::string_view{p_argv[1]} == "--help"))
  {
    std::printf(kUsage, p_argv[0]);
    return 0;
  }
  if (p_argc != 4)
  {
    std::fprintf(stderr, kUsage, p_argv[0]);
    return 2;
  }
  const auto pid = triangulator::ParseNumber<std::uint32_t>(p_argv[2]);
  const auto at = triangulator::ParseNumber<std::uint64_t>(p_argv[3]);
  if (!pid || !at)
  {
    std::fprintf(stderr, "invalid PID or time\n");
    return 2;
  }
  try
  {
    // AT is whole seconds since the epoch; 0 means now.
    const double now = std::chrono::duration<double>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count();
    const auto result = triangulator::memory_report::Report(
        p_argv[1], *pid, *at == 0 ? now : static_cast<double>(*at));
    const auto output = triangulator::collector::DumpJson(result);
    if (std::fwrite(output.data(), 1, output.size(), stdout) != output.size() ||
        std::fflush(stdout))
    {
      return 1;
    }
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "memory report: %s\n", error.what());
    return 1;
  }
  return 0;
}
