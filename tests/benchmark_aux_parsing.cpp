#include <array>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <string>
#include <string_view>

#include "../sampler/parsing.hpp"

namespace triangulator
{
namespace
{
// Check scheduler fields, input boundaries and malformed counters.
[[nodiscard]] bool VerifyScheduler()
{
  const auto valid = ParseSchedstat(" \t123\t456 789\n");
  const auto extra = ParseSchedstat("0 0 18446744073709551615 extra");
  return valid && valid->run_delay_ == 456 && valid->timeslices_ == 789 &&
         extra && extra->run_delay_ == 0 &&
         extra->timeslices_ == std::numeric_limits<std::uint64_t>::max() &&
         !ParseSchedstat("") && !ParseSchedstat("1 2") &&
         !ParseSchedstat("-1 2 3") && !ParseSchedstat("1 2x 3") &&
         !ParseSchedstat("1 18446744073709551616 3");
}

// Check I/O keys, ordering, duplicates, malformed values and missing fields.
[[nodiscard]] bool VerifyIo()
{
  const auto normal = ParseIo("rchar: 11\nwchar: 22\nsyscr: 3\n");
  const auto reordered = ParseIo("other: 9\nwchar:\t3\nrchar: 4");
  const auto duplicate = ParseIo("rchar: 1\nwchar: 2\nrchar: 5\n");
  const auto recovered = ParseIo("rchar: bad\nwchar: 2\nrchar: 5\n");
  return normal && normal->read_bytes_ == 11 && normal->write_bytes_ == 22 &&
         reordered && reordered->read_bytes_ == 4 &&
         reordered->write_bytes_ == 3 && duplicate &&
         duplicate->read_bytes_ == 5 && recovered &&
         recovered->read_bytes_ == 5 && !ParseIo("rchar: 1\n") &&
         !ParseIo(" rchar: 1\nwchar: 2\n") &&
         !ParseIo("rchar: -1\nwchar: 2\n") &&
         !ParseIo("rchar: 18446744073709551616\nwchar: 2\n") &&
         !ParseIo("rchar: 1\nwchar: 2\nrchar: bad\n");
}

// Compare results for single-byte edits and appended bytes in representative
// input.
[[nodiscard]] std::uint64_t BehaviorDigest()
{
  constexpr std::array<std::string_view, 4> kInputs{
      "1234 5678 90\n", "\t1 18446744073709551615 0 extra\n",
      "rchar: 123456\nwchar: 789\nsyscr: 3\nread_bytes: 0\n",
      "other: 3\nwchar:\t3\nrchar: 4\nrchar: 7\n"};
  constexpr std::string_view kReplacements = "09x- :\t\n";
  std::uint64_t digest = 14695981039346656037ULL;
  for (std::size_t index = 0; index < kInputs.size(); ++index)
  {
    const std::string input{kInputs[index]};
    for (std::size_t position = 0; position <= input.size(); ++position)
    {
      for (const char replacement : kReplacements)
      {
        auto changed = input;
        if (position == input.size())
        {
          changed.push_back(replacement);
        }
        else
        {
          changed[position] = replacement;
        }
        if (index < 2)
        {
          const auto value = ParseSchedstat(changed);
          digest = (digest ^ static_cast<std::uint64_t>(value.has_value())) *
                   1099511628211ULL;
          if (value)
          {
            digest = (digest ^ value->run_delay_) * 1099511628211ULL;
            digest = (digest ^ value->timeslices_) * 1099511628211ULL;
          }
        }
        else
        {
          const auto value = ParseIo(changed);
          digest = (digest ^ static_cast<std::uint64_t>(value.has_value())) *
                   1099511628211ULL;
          if (value)
          {
            digest = (digest ^ value->read_bytes_) * 1099511628211ULL;
            digest = (digest ^ value->write_bytes_) * 1099511628211ULL;
          }
        }
      }
    }
  }
  return digest;
}

[[nodiscard]] std::array<std::string, 256> Inputs(bool p_io)
{
  std::array<std::string, 256> result;
  for (std::size_t index = 0; index < result.size(); ++index)
  {
    const auto value = std::to_string(index + 1234567);
    if (p_io)
    {
      result[index].append("rchar: ");
      result[index].append(value);
      result[index].append(
          "\nwchar: 456789\nsyscr: 32\nsyscw: 1\n"
          "read_bytes: 0\nwrite_bytes: 0\n"
          "cancelled_write_bytes: 0\n");
    }
    else
    {
      result[index].append(value);
      result[index].append(" 456789 1234\n");
    }
  }
  return result;
}

[[nodiscard]] std::uint64_t Run(std::string_view p_mode)
{
  const bool io = p_mode == "io";
  const auto inputs = Inputs(io);
  std::uint64_t checksum = 0;
  constexpr std::size_t kIterations = 3000000;
  for (std::size_t iteration = 0; iteration < kIterations; ++iteration)
  {
    const auto& input = inputs[iteration % inputs.size()];
    if (io)
    {
      const auto sample = ParseIo(input);
      if (!sample)
      {
        return 0;
      }
      checksum += sample->read_bytes_ + sample->write_bytes_;
    }
    else
    {
      const auto sample = ParseSchedstat(input);
      if (!sample)
      {
        return 0;
      }
      checksum += sample->run_delay_ + sample->timeslices_;
    }
  }
  return checksum;
}
}  // namespace
}  // namespace triangulator

int main(int p_argc, char** p_argv)
{
  if (p_argc != 2 || (std::string_view{p_argv[1]} != "schedstat" &&
                      std::string_view{p_argv[1]} != "io" &&
                      std::string_view{p_argv[1]} != "verify" &&
                      std::string_view{p_argv[1]} != "digest"))
  {
    std::fputs("usage: benchmark-aux-parsing [verify|digest|schedstat|io]\n",
               stderr);
    return 2;
  }
  if (!triangulator::VerifyScheduler() || !triangulator::VerifyIo())
  {
    std::fputs("auxiliary parser behavior check failed\n", stderr);
    return 1;
  }
  if (std::string_view{p_argv[1]} == "verify")
  {
    // Keep the observable results of the original implementation on the corpus.
    constexpr std::uint64_t kBaselineDigest = 13861260553566465364ULL;
    if (triangulator::BehaviorDigest() != kBaselineDigest)
    {
      std::fputs("auxiliary parser corpus changed\n", stderr);
      return 1;
    }
    return 0;
  }
  if (std::string_view{p_argv[1]} == "digest")
  {
    const auto digest = triangulator::BehaviorDigest();
    std::printf("%llu\n", static_cast<unsigned long long>(digest));
    return 0;
  }
  const auto checksum = triangulator::Run(p_argv[1]);
  if (checksum == 0)
  {
    std::fputs("auxiliary parser benchmark failed\n", stderr);
    return 1;
  }
  std::printf("%llu\n", static_cast<unsigned long long>(checksum));
  return 0;
}
