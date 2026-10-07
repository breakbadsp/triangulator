#pragma once

// Text without the heap: sanitising and number and JSON formatting into a
// FixedText. Every function returns false when the text did not fit; the
// text then holds the part that fitted. Callers size their FixedText for the
// longest value they can produce, so a false result is a programmer error
// that they check with an assertion, or a limit that they document.

#include <array>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <string_view>

#include "bounded.hpp"
#include "json.hpp"

namespace triangulator::collector
{

// Longest text SanitizeInto can write for p_size input bytes: each invalid
// byte becomes the three bytes of U+FFFD.
[[nodiscard]] constexpr std::size_t SanitizedSize(std::size_t p_size) noexcept
{
  return 3 * p_size;
}

// SanitizeUtf8 into p_out: replaces invalid UTF-8 with U+FFFD.
template <std::size_t TCapacity>
bool SanitizeInto(std::string_view p_text, FixedText<TCapacity>& p_out)
{
  p_out.Clear();
  bool fitted = true;
  for (std::size_t index = 0; index < p_text.size();)
  {
    const auto length = Utf8SequenceLength(p_text, index);
    if (length == 0)
    {
      fitted &= p_out.Append("\xEF\xBF\xBD");
      ++index;
      continue;
    }
    fitted &= p_out.Append(p_text.substr(index, length));
    index += length;
  }
  return fitted;
}

template <std::size_t TCapacity>
bool AppendInteger(FixedText<TCapacity>& p_out, std::int64_t p_value)
{
  std::array<char, 24> digits{};
  const auto result =
      std::to_chars(digits.data(), digits.data() + digits.size(), p_value);
  return p_out.Append({digits.data(), result.ptr});
}

template <std::size_t TCapacity>
bool AppendUnsigned(FixedText<TCapacity>& p_out, std::uint64_t p_value)
{
  std::array<char, 24> digits{};
  const auto result =
      std::to_chars(digits.data(), digits.data() + digits.size(), p_value);
  return p_out.Append({digits.data(), result.ptr});
}

// The shortest text that reads back as p_value, with ".0" added to a whole
// number (5.0, not 5), like DumpDouble. NaN and infinity become null.
template <std::size_t TCapacity>
bool AppendDouble(FixedText<TCapacity>& p_out, double p_value)
{
  if (!std::isfinite(p_value))
  {
    return p_out.Append("null");
  }
  std::array<char, 40> digits{};
  const auto result =
      std::to_chars(digits.data(), digits.data() + digits.size(), p_value);
  const std::string_view text{digits.data(), result.ptr};
  bool fitted = p_out.Append(text);
  if (text.find_first_of(".e") == std::string_view::npos)
  {
    fitted &= p_out.Append(".0");
  }
  return fitted;
}

// A JSON string with quotes, escaped like DumpString.
template <std::size_t TCapacity>
bool AppendJsonString(FixedText<TCapacity>& p_out, std::string_view p_text)
{
  bool fitted = p_out.Append("\"");
  for (std::size_t index = 0; index < p_text.size();)
  {
    const char character = p_text[index];
    const auto length = Utf8SequenceLength(p_text, index);
    if (length == 0)
    {
      fitted &= p_out.Append("\\ufffd");
      ++index;
      continue;
    }
    if (length > 1)
    {
      fitted &= p_out.Append(p_text.substr(index, length));
      index += length;
      continue;
    }
    switch (character)
    {
      case '"':
        fitted &= p_out.Append("\\\"");
        break;
      case '\\':
        fitted &= p_out.Append("\\\\");
        break;
      case '\n':
        fitted &= p_out.Append("\\n");
        break;
      case '\r':
        fitted &= p_out.Append("\\r");
        break;
      case '\t':
        fitted &= p_out.Append("\\t");
        break;
      case '\b':
        fitted &= p_out.Append("\\b");
        break;
      case '\f':
        fitted &= p_out.Append("\\f");
        break;
      default:
        if (static_cast<unsigned char>(character) < 0x20)
        {
          constexpr std::string_view kHex = "0123456789abcdef";
          const auto code = static_cast<unsigned char>(character);
          const std::array<char, 6> escape{
              '\\', 'u', '0', '0', kHex[code >> 4], kHex[code & 15]};
          fitted &= p_out.Append({escape.data(), escape.size()});
        }
        else
        {
          fitted &= p_out.Append({&character, 1});
        }
    }
    ++index;
  }
  fitted &= p_out.Append("\"");
  return fitted;
}

}  // namespace triangulator::collector
