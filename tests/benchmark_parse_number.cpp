// Check numeric parsing and benchmark representative proc counter values.
#include <array>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <limits>
#include <optional>
#include <string_view>

#include "../sampler/parsing.hpp"

namespace
{

template <typename Number>
struct NumberCase
{
  std::string_view text_;
  std::optional<Number> expected_;
};

template <typename Number, std::size_t kCount>
[[nodiscard]] bool CheckCases(
    const std::array<NumberCase<Number>, kCount>& p_cases)
{
  for (const auto& entry : p_cases)
  {
    if (triangulator::ParseNumber<Number>(entry.text_) != entry.expected_)
    {
      std::cerr << "Wrong result for number: " << entry.text_ << '\n';
      return false;
    }
  }
  return true;
}

// Check valid values, limits, malformed inputs, and the full-token requirement.
[[nodiscard]] bool CheckBehavior()
{
  constexpr std::array<NumberCase<std::uint64_t>, 17> kUnsignedCases{{
      {"", std::nullopt},
      {"0", 0},
      {"00000000000000000000000001", 1},
      {"42", 42},
      {"9999999999999999999", 9'999'999'999'999'999'999ULL},
      {"18446744073709551615", std::numeric_limits<std::uint64_t>::max()},
      {"18446744073709551616", std::nullopt},
      {"999999999999999999999999999999", std::nullopt},
      {"-1", std::nullopt},
      {"-0", std::nullopt},
      {"+1", std::nullopt},
      {" 1", std::nullopt},
      {"1 ", std::nullopt},
      {"1\n", std::nullopt},
      {"1a", std::nullopt},
      {"a1", std::nullopt},
      {std::string_view{"1\0"
                        "2",
                        3},
       std::nullopt},
  }};
  constexpr std::array<NumberCase<int>, 9> kSignedCases{{
      {"0", 0},
      {"-0", 0},
      {"42", 42},
      {"-42", -42},
      {"2147483647", std::numeric_limits<int>::max()},
      {"-2147483648", std::numeric_limits<int>::min()},
      {"2147483648", std::nullopt},
      {"-2147483649", std::nullopt},
      {"+42", std::nullopt},
  }};
  constexpr std::array<NumberCase<std::uint16_t>, 3> kSmallCases{{
      {"65535", std::numeric_limits<std::uint16_t>::max()},
      {"65536", std::nullopt},
      {"-1", std::nullopt},
  }};
  constexpr std::array<NumberCase<double>, 5> kFloatCases{{
      {"5.0", 5.0},
      {"-0.125", -0.125},
      {"1e3", 1000.0},
      {"1.0x", std::nullopt},
      {"+1.0", std::nullopt},
  }};
  return CheckCases(kUnsignedCases) && CheckCases(kSignedCases) &&
         CheckCases(kSmallCases) && CheckCases(kFloatCases);
}

// Check that many counters round-trip and reject trailing non-numeric bytes.
[[nodiscard]] bool CheckRoundTrips()
{
  for (unsigned byte = 0; byte <= 255; ++byte)
  {
    const char character = static_cast<char>(static_cast<unsigned char>(byte));
    const auto actual = triangulator::ParseNumber<std::uint64_t>(
        std::string_view{&character, 1});
    if (byte >= static_cast<unsigned>('0') &&
        byte <= static_cast<unsigned>('9'))
    {
      if (actual != byte - static_cast<unsigned>('0'))
      {
        return false;
      }
    }
    else if (actual)
    {
      return false;
    }
  }
  constexpr std::uint64_t kMultiplier = 6'364'136'223'846'793'005ULL;
  constexpr std::uint64_t kIncrement = 1'442'695'040'888'963'407ULL;
  constexpr std::size_t kCount = 100'000;
  std::uint64_t value = 1;
  for (std::size_t index = 0; index < kCount; ++index)
  {
    value = value * kMultiplier + kIncrement;
    const auto number = index % 2 == 0 ? value % 1'000'000'000'000ULL : value;
    std::array<char, 21> buffer{};
    const auto [end, error] =
        std::to_chars(buffer.data(), buffer.data() + buffer.size(), number);
    if (error != std::errc{})
    {
      return false;
    }
    const auto length = static_cast<std::size_t>(end - buffer.data());
    if (triangulator::ParseNumber<std::uint64_t>(
            std::string_view{buffer.data(), length}) != number)
    {
      std::cerr << "Round trip failed for " << number << '\n';
      return false;
    }
    buffer[length] = 'x';
    if (triangulator::ParseNumber<std::uint64_t>(
            std::string_view{buffer.data(), length + 1}))
    {
      std::cerr << "Accepted a suffix for " << number << '\n';
      return false;
    }
  }
  return true;
}

[[nodiscard]] std::uint64_t Benchmark(std::string_view p_kind)
{
  constexpr std::array<std::string_view, 8> kShort{
      "0", "1", "17", "415", "24039", "1683241", "71286598", "5326912348"};
  constexpr std::array<std::string_view, 8> kMixed{"0",
                                                   "1",
                                                   "987654321",
                                                   "4294967295",
                                                   "9999999999999999999",
                                                   "18446744073709551615",
                                                   "18446744073709551616",
                                                   "1234x"};
  constexpr std::uint64_t kIterations = 10'000'000;
  const auto& inputs = p_kind == "short" ? kShort : kMixed;
  std::uint64_t checksum{};
  for (std::uint64_t index = 0; index < kIterations; ++index)
  {
    const auto value = triangulator::ParseNumber<std::uint64_t>(
        inputs[static_cast<std::size_t>(index % inputs.size())]);
    checksum += value.value_or(17);
  }
  return checksum;
}

}  // namespace

int main(int p_argc, char** p_argv)
{
  if (!CheckBehavior())
  {
    return 1;
  }
  if (p_argc == 2 && (std::string_view{p_argv[1]} == "short" ||
                      std::string_view{p_argv[1]} == "mixed"))
  {
    std::cout << Benchmark(p_argv[1]) << '\n';
    return 0;
  }
  if (p_argc == 2 && std::string_view{p_argv[1]} == "verify")
  {
    if (!CheckRoundTrips())
    {
      return 1;
    }
    std::cout << "numeric behavior passed\n";
    return 0;
  }
  std::cerr << "usage: benchmark-parse-number verify|short|mixed\n";
  return 2;
}
