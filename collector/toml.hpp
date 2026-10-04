#pragma once

#include <cctype>
#include <charconv>
#include <cmath>
#include <expected>
#include <format>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "json.hpp"

namespace triangulator::collector
{

// Reads the TOML subset used by collector configuration files into a Json
// object: tables, arrays of tables, dotted keys, strings, integers, floats,
// booleans, arrays and inline tables. Dates and multi-line strings are
// rejected with an error rather than misread.
class TomlParser
{
 public:
  explicit TomlParser(std::string_view p_text) : text_(p_text)
  {
  }

  [[nodiscard]] std::expected<Json, std::string> Parse()
  {
    while (true)
    {
      SkipBlank();
      if (AtEnd())
      {
        return root_;
      }
      if (Peek() == '\n' || Peek() == '#')
      {
        if (auto status = EndOfLine(); !status)
        {
          return std::unexpected(status.error());
        }
        continue;
      }
      std::expected<void, std::string> status;
      if (Peek() == '[')
      {
        status = ParseTableHeader();
      }
      else
      {
        status = ParseKeyValue();
      }
      if (!status)
      {
        return std::unexpected(status.error());
      }
    }
  }

 private:
  std::string_view text_;
  std::size_t position_ = 0;
  std::size_t line_ = 1;
  Json root_{JsonObject{}};
  std::vector<std::string> current_;
  std::set<std::string> defined_tables_;

  [[nodiscard]] bool AtEnd() const noexcept
  {
    return position_ >= text_.size();
  }
  [[nodiscard]] char Peek() const noexcept
  {
    return AtEnd() ? '\0' : text_[position_];
  }
  [[nodiscard]] std::string Error(std::string_view p_message) const
  {
    return std::format("{} (at line {})", p_message, line_);
  }

  void SkipBlank()
  {
    while (!AtEnd() && (Peek() == ' ' || Peek() == '\t' || Peek() == '\r'))
    {
      ++position_;
    }
  }

  // Blank space, comments and newlines, as allowed inside arrays.
  void SkipBlankLines()
  {
    while (true)
    {
      SkipBlank();
      if (Peek() == '#')
      {
        while (!AtEnd() && Peek() != '\n')
        {
          ++position_;
        }
      }
      if (Peek() != '\n')
      {
        return;
      }
      ++position_;
      ++line_;
    }
  }

  [[nodiscard]] std::expected<void, std::string> EndOfLine()
  {
    SkipBlank();
    if (Peek() == '#')
    {
      while (!AtEnd() && Peek() != '\n')
      {
        ++position_;
      }
    }
    if (AtEnd())
    {
      return {};
    }
    if (Peek() != '\n')
    {
      return std::unexpected(Error("expected end of line"));
    }
    ++position_;
    ++line_;
    return {};
  }

  [[nodiscard]] static bool IsBareKeyCharacter(char p_character) noexcept
  {
    return (p_character >= 'A' && p_character <= 'Z') ||
           (p_character >= 'a' && p_character <= 'z') ||
           (p_character >= '0' && p_character <= '9') || p_character == '_' ||
           p_character == '-';
  }

  [[nodiscard]] std::expected<std::vector<std::string>, std::string> ParseKey()
  {
    std::vector<std::string> parts;
    while (true)
    {
      SkipBlank();
      if (Peek() == '"' || Peek() == '\'')
      {
        auto part = Peek() == '"' ? ParseBasicString() : ParseLiteralString();
        if (!part)
        {
          return std::unexpected(part.error());
        }
        parts.push_back(std::move(*part));
      }
      else
      {
        const auto start = position_;
        while (!AtEnd() && IsBareKeyCharacter(Peek()))
        {
          ++position_;
        }
        if (position_ == start)
        {
          return std::unexpected(Error("invalid key"));
        }
        parts.emplace_back(text_.substr(start, position_ - start));
      }
      SkipBlank();
      if (Peek() != '.')
      {
        return parts;
      }
      ++position_;
    }
  }

  // Walks p_parts from the root, creating tables on the way. An array of
  // tables continues at its last element.
  [[nodiscard]] std::expected<Json*, std::string> Walk(
      const std::vector<std::string>& p_parts, std::size_t p_count)
  {
    Json* table = &root_;
    for (std::size_t index = 0; index < p_count; ++index)
    {
      Json* next = table->Find(p_parts[index]);
      if (next == nullptr)
      {
        table->Set(p_parts[index], Json{JsonObject{}});
        next = table->Find(p_parts[index]);
      }
      if (next->IsArray() && !next->AsArray().empty() &&
          next->AsArray().back().IsObject())
      {
        next = &next->AsArray().back();
      }
      if (!next->IsObject())
      {
        return std::unexpected(
            Error(std::format("key '{}' is not a table", p_parts[index])));
      }
      table = next;
    }
    return table;
  }

  [[nodiscard]] std::expected<void, std::string> ParseTableHeader()
  {
    ++position_;
    const bool array = Peek() == '[';
    if (array)
    {
      ++position_;
    }
    auto parts = ParseKey();
    if (!parts)
    {
      return std::unexpected(parts.error());
    }
    if (Peek() != ']' || (array && text_.substr(position_, 2) != "]]"))
    {
      return std::unexpected(Error("unterminated table header"));
    }
    position_ += array ? 2 : 1;
    auto parent = Walk(*parts, parts->size() - 1);
    if (!parent)
    {
      return std::unexpected(parent.error());
    }
    const auto& last = parts->back();
    Json* existing = (*parent)->Find(last);
    if (array)
    {
      if (existing == nullptr)
      {
        (*parent)->Set(last, Json{JsonArray{}});
        existing = (*parent)->Find(last);
      }
      if (!existing->IsArray())
      {
        return std::unexpected(
            Error(std::format("key '{}' is not an array of tables", last)));
      }
      existing->AsArray().emplace_back(JsonObject{});
    }
    else
    {
      // Each array element gets its own namespace for sub-table names.
      std::string name;
      Json* table = &root_;
      for (const auto& part : *parts)
      {
        name += part;
        name += '\x1f';
        table = table->Find(part);
        if (table != nullptr && table->IsArray())
        {
          name += std::to_string(table->AsArray().size());
          name += '\x1f';
          table = &table->AsArray().back();
        }
        if (table == nullptr)
        {
          break;
        }
      }
      if (!defined_tables_.insert(name).second)
      {
        return std::unexpected(Error("table defined twice"));
      }
      if (existing == nullptr)
      {
        (*parent)->Set(last, Json{JsonObject{}});
      }
      else if (!existing->IsObject())
      {
        return std::unexpected(
            Error(std::format("key '{}' is not a table", last)));
      }
    }
    current_ = std::move(*parts);
    return EndOfLine();
  }

  [[nodiscard]] std::expected<void, std::string> Assign(
      Json& p_table, const std::vector<std::string>& p_parts, Json p_value)
  {
    Json* table = &p_table;
    for (std::size_t index = 0; index + 1 < p_parts.size(); ++index)
    {
      Json* next = table->Find(p_parts[index]);
      if (next == nullptr)
      {
        table->Set(p_parts[index], Json{JsonObject{}});
        next = table->Find(p_parts[index]);
      }
      if (!next->IsObject())
      {
        return std::unexpected(
            Error(std::format("key '{}' is not a table", p_parts[index])));
      }
      table = next;
    }
    if (table->Find(p_parts.back()) != nullptr)
    {
      return std::unexpected(
          Error(std::format("duplicate key '{}'", p_parts.back())));
    }
    table->Set(p_parts.back(), std::move(p_value));
    return {};
  }

  [[nodiscard]] std::expected<void, std::string> ParseKeyValue()
  {
    auto parts = ParseKey();
    if (!parts)
    {
      return std::unexpected(parts.error());
    }
    if (Peek() != '=')
    {
      return std::unexpected(Error("expected '=' after key"));
    }
    ++position_;
    auto value = ParseValue();
    if (!value)
    {
      return std::unexpected(value.error());
    }
    auto table = Walk(current_, current_.size());
    if (!table)
    {
      return std::unexpected(table.error());
    }
    if (auto status = Assign(**table, *parts, std::move(*value)); !status)
    {
      return status;
    }
    return EndOfLine();
  }

  [[nodiscard]] std::expected<std::string, std::string> ParseLiteralString()
  {
    if (text_.substr(position_, 3) == "'''")
    {
      return std::unexpected(Error("multi-line strings are not supported"));
    }
    ++position_;
    const auto end = text_.find_first_of("'\n", position_);
    if (end == std::string_view::npos || text_[end] != '\'')
    {
      return std::unexpected(Error("unterminated string"));
    }
    std::string value{text_.substr(position_, end - position_)};
    position_ = end + 1;
    return value;
  }

  [[nodiscard]] std::expected<std::string, std::string> ParseBasicString()
  {
    if (text_.substr(position_, 3) == "\"\"\"")
    {
      return std::unexpected(Error("multi-line strings are not supported"));
    }
    ++position_;
    std::string value;
    while (!AtEnd() && Peek() != '\n')
    {
      const char character = text_[position_++];
      if (character == '"')
      {
        return value;
      }
      if (character != '\\')
      {
        value += character;
        continue;
      }
      const char escape = Peek();
      ++position_;
      switch (escape)
      {
        case '"':
        case '\\':
          value += escape;
          break;
        case 'b':
          value += '\b';
          break;
        case 't':
          value += '\t';
          break;
        case 'n':
          value += '\n';
          break;
        case 'f':
          value += '\f';
          break;
        case 'r':
          value += '\r';
          break;
        case 'u':
        case 'U':
        {
          const std::size_t digits = escape == 'u' ? 4 : 8;
          std::uint32_t code = 0;
          const auto* begin = text_.data() + position_;
          if (position_ + digits > text_.size() ||
              std::from_chars(begin, begin + digits, code, 16).ptr !=
                  begin + digits ||
              code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF))
          {
            return std::unexpected(Error("invalid unicode escape"));
          }
          position_ += digits;
          AppendUtf8(value, code);
          break;
        }
        default:
          return std::unexpected(Error("invalid escape in string"));
      }
    }
    return std::unexpected(Error("unterminated string"));
  }

  [[nodiscard]] std::expected<Json, std::string> ParseScalarToken()
  {
    const auto start = position_;
    while (!AtEnd() && std::string_view{" \t\r\n,]}#"}.find(Peek()) ==
                           std::string_view::npos)
    {
      ++position_;
    }
    const auto token = text_.substr(start, position_ - start);
    if (token == "true")
    {
      return Json(true);
    }
    if (token == "false")
    {
      return Json(false);
    }
    if (token.empty())
    {
      return std::unexpected(Error("missing value"));
    }
    auto unsigned_token = token;
    bool negative = false;
    if (unsigned_token[0] == '+' || unsigned_token[0] == '-')
    {
      negative = unsigned_token[0] == '-';
      unsigned_token.remove_prefix(1);
    }
    if (unsigned_token == "inf" || unsigned_token == "nan")
    {
      const double value = unsigned_token == "inf" ? HUGE_VAL : std::nan("");
      return Json(negative ? -value : value);
    }
    if (token.find(':') != std::string_view::npos ||
        (token.size() >= 10 && token[4] == '-' && token[7] == '-'))
    {
      return std::unexpected(Error("dates and times are not supported"));
    }
    // Underscores may only separate digits.
    std::string digits;
    for (std::size_t index = 0; index < unsigned_token.size(); ++index)
    {
      const char character = unsigned_token[index];
      if (character == '_')
      {
        const auto is_digit = [&](std::size_t p_index)
        {
          return p_index < unsigned_token.size() &&
                 std::isxdigit(
                     static_cast<unsigned char>(unsigned_token[p_index]));
        };
        if (index == 0 || !is_digit(index - 1) || !is_digit(index + 1))
        {
          return std::unexpected(Error("invalid number"));
        }
        continue;
      }
      digits += character;
    }
    int base = 10;
    if (digits.size() > 2 && digits[0] == '0' &&
        (digits[1] == 'x' || digits[1] == 'o' || digits[1] == 'b'))
    {
      if (token[0] == '+' || token[0] == '-')
      {
        return std::unexpected(Error("invalid number"));
      }
      base = digits[1] == 'x' ? 16 : digits[1] == 'o' ? 8 : 2;
      digits.erase(0, 2);
    }
    const bool fractional =
        base == 10 && digits.find_first_of(".eE") != std::string::npos;
    if (base == 10 && digits.size() > 1 && digits[0] == '0' &&
        std::isdigit(static_cast<unsigned char>(digits[1])))
    {
      return std::unexpected(Error("leading zeros are not allowed"));
    }
    const auto* begin = digits.data();
    const auto* end = digits.data() + digits.size();
    if (fractional)
    {
      double value = 0;
      const auto result = std::from_chars(begin, end, value);
      const auto dot = digits.find('.');
      if (result.ec != std::errc{} || result.ptr != end ||
          (dot != std::string::npos &&
           (dot == 0 || dot + 1 >= digits.size() ||
            !std::isdigit(static_cast<unsigned char>(digits[dot + 1])))))
      {
        return std::unexpected(Error("invalid number"));
      }
      return Json(negative ? -value : value);
    }
    std::uint64_t magnitude = 0;
    const auto result = std::from_chars(begin, end, magnitude, base);
    if (result.ec != std::errc{} || result.ptr != end)
    {
      return std::unexpected(Error("invalid value"));
    }
    constexpr std::uint64_t kLimit = 9223372036854775807ull;
    if (magnitude > kLimit + (negative ? 1u : 0u))
    {
      return std::unexpected(Error("integer out of range"));
    }
    if (negative)
    {
      return Json(static_cast<std::int64_t>(0ull - magnitude));
    }
    return Json(static_cast<std::int64_t>(magnitude));
  }

  [[nodiscard]] std::expected<Json, std::string> ParseValue()
  {
    SkipBlank();
    if (Peek() == '"')
    {
      auto text = ParseBasicString();
      if (!text)
      {
        return std::unexpected(text.error());
      }
      return Json(std::move(*text));
    }
    if (Peek() == '\'')
    {
      auto text = ParseLiteralString();
      if (!text)
      {
        return std::unexpected(text.error());
      }
      return Json(std::move(*text));
    }
    if (Peek() == '[')
    {
      ++position_;
      JsonArray items;
      while (true)
      {
        SkipBlankLines();
        if (Peek() == ']')
        {
          ++position_;
          return Json(std::move(items));
        }
        auto item = ParseValue();
        if (!item)
        {
          return item;
        }
        items.push_back(std::move(*item));
        SkipBlankLines();
        if (Peek() == ',')
        {
          ++position_;
        }
        else if (Peek() != ']')
        {
          return std::unexpected(Error("expected ',' or ']' in array"));
        }
      }
    }
    if (Peek() == '{')
    {
      ++position_;
      Json table{JsonObject{}};
      SkipBlank();
      if (Peek() == '}')
      {
        ++position_;
        return table;
      }
      while (true)
      {
        auto parts = ParseKey();
        if (!parts)
        {
          return std::unexpected(parts.error());
        }
        if (Peek() != '=')
        {
          return std::unexpected(Error("expected '=' after key"));
        }
        ++position_;
        auto item = ParseValue();
        if (!item)
        {
          return item;
        }
        if (auto status = Assign(table, *parts, std::move(*item)); !status)
        {
          return std::unexpected(status.error());
        }
        SkipBlank();
        if (Peek() == '}')
        {
          ++position_;
          return table;
        }
        if (Peek() != ',')
        {
          return std::unexpected(Error("expected ',' or '}' in inline table"));
        }
        ++position_;
      }
    }
    return ParseScalarToken();
  }
};

[[nodiscard]] inline std::expected<Json, std::string> ParseToml(
    std::string_view p_text)
{
  return TomlParser{p_text}.Parse();
}

}  // namespace triangulator::collector
