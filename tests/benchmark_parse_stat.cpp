#include <array>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <string>
#include <string_view>
#include <vector>

#include "../sampler/parsing.hpp"

namespace triangulator
{
namespace
{
constexpr int kFirstField = 3;
constexpr int kLastField = 39;
constexpr int kFieldCount = kLastField - kFirstField + 1;

[[nodiscard]] std::string StatLine(std::string_view p_name,
                                   std::string_view p_separator)
{
  std::array<std::string_view, kFieldCount> fields;
  fields.fill("0");
  fields[0] = "S";
  fields[1] = "41";
  fields[9] = "7";
  fields[11] = "100";
  fields[12] = "50";
  fields[19] = "12345";
  fields[36] = "3";
  std::string result = "42 (";
  result += p_name;
  result += ") ";
  for (const auto field : fields)
  {
    result += field;
    result += p_separator;
  }
  return result;
}

[[nodiscard]] bool ValidStat(std::string_view p_text,
                             std::string_view p_expected_name)
{
  const auto result = ParseStat(p_text);
  return result && std::string_view{result->name_.data()} == p_expected_name &&
         result->state_ == 'S' && result->major_faults_ == 7 &&
         result->utime_ == 100 && result->stime_ == 50 &&
         result->starttime_ == 12345 && result->processor_ == 3;
}

// Check the full returned record and rejection of malformed external input.
[[nodiscard]] bool CheckBehavior()
{
  const auto spaced = StatLine("worker ) ( name", " ");
  const auto whitespace = StatLine("worker", " \t\r\n");
  const auto long_name = StatLine("abcdefghijklmnopq", " ");
  if (!ValidStat(spaced, "worker ) ( name") ||
      !ValidStat(whitespace, "worker") ||
      !ValidStat(long_name, "abcdefghijklmno"))
  {
    return false;
  }
  auto invalid_counter = spaced;
  invalid_counter.replace(invalid_counter.find(" 7 "), 3,
                          " 18446744073709551616 ");
  auto invalid_processor = spaced;
  invalid_processor.replace(invalid_processor.rfind(" 3 "), 3, " 65536 ");
  auto invalid_state = spaced;
  invalid_state.replace(invalid_state.find(" S "), 3, " SS ");
  if (ParseStat("42 (worker) S 41") || ParseStat("42 worker) S 41") ||
      ParseStat(invalid_counter) || ParseStat(invalid_processor) ||
      ParseStat(invalid_state))
  {
    return false;
  }
  return true;
}

// Hash observable results for the same repeatable malformed-input corpus.
[[nodiscard]] std::uint64_t CorpusFingerprint()
{
  auto random = std::uint64_t{0x12a91dc7};
  auto next = [&random]()
  {
    random ^= random << 13;
    random ^= random >> 7;
    random ^= random << 17;
    return random;
  };
  auto fingerprint = std::uint64_t{14695981039346656037ULL};
  const auto add = [&fingerprint](std::uint64_t p_value)
  {
    fingerprint ^= p_value;
    fingerprint *= 1099511628211ULL;
  };
  constexpr std::string_view kCharacters = "0123456789-+x)( \t\r\n";
  const auto base = StatLine("worker ) ( name", " ");
  for (std::size_t case_index{}; case_index < 20000; ++case_index)
  {
    auto text = base;
    const auto mutations = next() % 5;
    for (std::uint64_t index{}; index < mutations; ++index)
    {
      const auto position = next() % text.size();
      text[position] = kCharacters[next() % kCharacters.size()];
    }
    if (next() % 4 == 0)
    {
      text.resize(next() % text.size());
    }
    const auto value = ParseStat(text);
    add(value.has_value());
    if (value)
    {
      for (const char byte : value->name_)
      {
        add(static_cast<unsigned char>(byte));
      }
      add(static_cast<unsigned char>(value->state_));
      add(value->major_faults_);
      add(value->utime_);
      add(value->stime_);
      add(value->starttime_);
      add(value->processor_);
    }
  }
  return fingerprint;
}
}  // namespace
}  // namespace triangulator

int main(int p_argc, char** p_argv)
{
  if (!triangulator::CheckBehavior())
  {
    std::fputs("stat parser behavior check failed\n", stderr);
    return 1;
  }
  if (p_argc != 2)
  {
    std::fputs("usage: benchmark_parse_stat ITERATIONS|check|corpus\n", stderr);
    return 2;
  }
  const std::string_view argument{p_argv[1]};
  if (argument == "check")
  {
    // Check the original parser's results for the repeatable input corpus.
    constexpr std::uint64_t kExpectedFingerprint = 3392842911711527279ULL;
    if (triangulator::CorpusFingerprint() != kExpectedFingerprint)
    {
      std::fputs("stat parser corpus differs from baseline\n", stderr);
      return 1;
    }
    return 0;
  }
  if (argument == "corpus")
  {
    const auto fingerprint = std::to_string(triangulator::CorpusFingerprint());
    std::fputs(fingerprint.c_str(), stdout);
    std::fputc('\n', stdout);
    return 0;
  }
  std::uint64_t iterations{};
  const auto [end, error] = std::from_chars(
      argument.data(), argument.data() + argument.size(), iterations);
  if (error != std::errc{} || end != argument.data() + argument.size() ||
      iterations == 0)
  {
    std::fputs("iterations must be a positive integer\n", stderr);
    return 2;
  }
  const std::vector<std::string> corpus{
      triangulator::StatLine("worker ) ( name", " "),
      triangulator::StatLine("worker", " \t"),
      triangulator::StatLine("abcdefghijklmnopq", "  "),
      triangulator::StatLine("thread", " "),
  };
  std::uint64_t checksum{};
  for (std::uint64_t index{}; index < iterations; ++index)
  {
    const auto& line = corpus[index % corpus.size()];
    // Prevent an optimizer from hoisting a pure parse out of the loop.
    asm volatile("" : : "g"(line.data()) : "memory");
    const auto sample = triangulator::ParseStat(line);
    if (!sample)
    {
      std::fputs("valid benchmark record was rejected\n", stderr);
      return 1;
    }
    checksum += sample->utime_ + sample->stime_ + sample->starttime_ +
                sample->processor_ + sample->major_faults_;
  }
  const auto checksum_text = std::to_string(checksum);
  std::fputs(checksum_text.c_str(), stdout);
  std::fputc('\n', stdout);
}
