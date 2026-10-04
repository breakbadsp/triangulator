#pragma once

#include <charconv>
#include <cmath>
#include <concepts>
#include <cstdint>
#include <expected>
#include <format>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <variant>
#include <vector>

namespace triangulator::collector
{

class Json;
using JsonArray = std::vector<Json>;
// Objects keep insertion order, like Python dicts, so output matches the
// Python collector field for field.
using JsonObject = std::vector<std::pair<std::string, Json>>;

class Json
{
 public:
  Json() = default;
  Json(std::nullptr_t) noexcept
  {
  }
  Json(bool p_value) : value_(p_value)
  {
  }
  template <std::integral Integer>
    requires(!std::same_as<Integer, bool>)
  Json(Integer p_value) : value_(static_cast<std::int64_t>(p_value))
  {
    // Counters above the int64 range keep their magnitude as a float.
    if constexpr (std::unsigned_integral<Integer> && sizeof(Integer) >= 8)
    {
      if (p_value > static_cast<Integer>(INT64_MAX))
      {
        value_ = static_cast<double>(p_value);
      }
    }
  }
  Json(double p_value) : value_(p_value)
  {
  }
  Json(std::string p_value) : value_(std::move(p_value))
  {
  }
  Json(std::string_view p_value) : value_(std::string{p_value})
  {
  }
  Json(const char* p_value) : value_(std::string{p_value})
  {
  }
  Json(JsonArray p_value) : value_(std::move(p_value))
  {
  }
  Json(JsonObject p_value) : value_(std::move(p_value))
  {
  }
  template <typename Value>
  Json(const std::optional<Value>& p_value)
  {
    if (p_value)
    {
      *this = Json(*p_value);
    }
  }

  [[nodiscard]] bool IsNull() const noexcept
  {
    return std::holds_alternative<std::nullptr_t>(value_);
  }
  [[nodiscard]] bool IsBool() const noexcept
  {
    return std::holds_alternative<bool>(value_);
  }
  [[nodiscard]] bool IsInt() const noexcept
  {
    return std::holds_alternative<std::int64_t>(value_);
  }
  // True for integers and floats but not booleans, like Python's
  // type(value) in (int, float).
  [[nodiscard]] bool IsNumber() const noexcept
  {
    return IsInt() || std::holds_alternative<double>(value_);
  }
  [[nodiscard]] bool IsString() const noexcept
  {
    return std::holds_alternative<std::string>(value_);
  }
  [[nodiscard]] bool IsArray() const noexcept
  {
    return std::holds_alternative<JsonArray>(value_);
  }
  [[nodiscard]] bool IsObject() const noexcept
  {
    return std::holds_alternative<JsonObject>(value_);
  }

  [[nodiscard]] bool AsBool() const
  {
    return std::get<bool>(value_);
  }
  [[nodiscard]] std::int64_t AsInt() const
  {
    return std::get<std::int64_t>(value_);
  }
  [[nodiscard]] double AsNumber() const
  {
    if (IsInt())
    {
      return static_cast<double>(AsInt());
    }
    return std::get<double>(value_);
  }
  [[nodiscard]] const std::string& AsString() const
  {
    return std::get<std::string>(value_);
  }
  [[nodiscard]] const JsonArray& AsArray() const
  {
    return std::get<JsonArray>(value_);
  }
  [[nodiscard]] JsonArray& AsArray()
  {
    return std::get<JsonArray>(value_);
  }
  [[nodiscard]] const JsonObject& AsObject() const
  {
    return std::get<JsonObject>(value_);
  }
  [[nodiscard]] JsonObject& AsObject()
  {
    return std::get<JsonObject>(value_);
  }

  [[nodiscard]] const Json* Find(std::string_view p_key) const
  {
    if (!IsObject())
    {
      return nullptr;
    }
    for (const auto& [key, value] : AsObject())
    {
      if (key == p_key)
      {
        return &value;
      }
    }
    return nullptr;
  }
  [[nodiscard]] Json* Find(std::string_view p_key)
  {
    return const_cast<Json*>(std::as_const(*this).Find(p_key));
  }
  // Replaces an existing key in place or appends a new one.
  void Set(std::string_view p_key, Json p_value)
  {
    if (auto* existing = Find(p_key))
    {
      *existing = std::move(p_value);
      return;
    }
    AsObject().emplace_back(std::string{p_key}, std::move(p_value));
  }

 private:
  std::variant<std::nullptr_t, bool, std::int64_t, double, std::string,
               JsonArray, JsonObject>
      value_;

  friend void DumpJson(const Json& p_value, std::string& p_out, int p_indent,
                       int p_depth);
};

// Length of the valid UTF-8 sequence starting at p_index, or 0 if invalid.
[[nodiscard]] inline std::size_t Utf8SequenceLength(std::string_view p_text,
                                                    std::size_t p_index)
{
  const auto lead = static_cast<unsigned char>(p_text[p_index]);
  std::size_t length = 0;
  std::uint32_t code = 0;
  if (lead < 0x80)
  {
    return 1;
  }
  if ((lead & 0xE0) == 0xC0)
  {
    length = 2;
    code = lead & 0x1Fu;
  }
  else if ((lead & 0xF0) == 0xE0)
  {
    length = 3;
    code = lead & 0x0Fu;
  }
  else if ((lead & 0xF8) == 0xF0)
  {
    length = 4;
    code = lead & 0x07u;
  }
  else
  {
    return 0;
  }
  if (p_index + length > p_text.size())
  {
    return 0;
  }
  for (std::size_t offset = 1; offset < length; ++offset)
  {
    const auto next = static_cast<unsigned char>(p_text[p_index + offset]);
    if ((next & 0xC0) != 0x80)
    {
      return 0;
    }
    code = (code << 6) | (next & 0x3Fu);
  }
  constexpr std::uint32_t kMinimum[] = {0, 0, 0x80, 0x800, 0x10000};
  if (code < kMinimum[length] || code > 0x10FFFF ||
      (code >= 0xD800 && code <= 0xDFFF))
  {
    return 0;
  }
  return length;
}

// Replaces invalid UTF-8 with U+FFFD, like Python's decode("utf-8",
// "replace").
[[nodiscard]] inline std::string SanitizeUtf8(std::string_view p_text)
{
  std::string result;
  result.reserve(p_text.size());
  for (std::size_t index = 0; index < p_text.size();)
  {
    const auto length = Utf8SequenceLength(p_text, index);
    if (length == 0)
    {
      result += "\xEF\xBF\xBD";
      ++index;
      continue;
    }
    result.append(p_text.substr(index, length));
    index += length;
  }
  return result;
}

inline void AppendUtf8(std::string& p_out, std::uint32_t p_code)
{
  if (p_code < 0x80)
  {
    p_out += static_cast<char>(p_code);
  }
  else if (p_code < 0x800)
  {
    p_out += static_cast<char>(0xC0 | (p_code >> 6));
    p_out += static_cast<char>(0x80 | (p_code & 0x3F));
  }
  else if (p_code < 0x10000)
  {
    p_out += static_cast<char>(0xE0 | (p_code >> 12));
    p_out += static_cast<char>(0x80 | ((p_code >> 6) & 0x3F));
    p_out += static_cast<char>(0x80 | (p_code & 0x3F));
  }
  else
  {
    p_out += static_cast<char>(0xF0 | (p_code >> 18));
    p_out += static_cast<char>(0x80 | ((p_code >> 12) & 0x3F));
    p_out += static_cast<char>(0x80 | ((p_code >> 6) & 0x3F));
    p_out += static_cast<char>(0x80 | (p_code & 0x3F));
  }
}

inline void DumpString(std::string_view p_text, std::string& p_out)
{
  p_out += '"';
  for (std::size_t index = 0; index < p_text.size();)
  {
    const char character = p_text[index];
    const auto length = Utf8SequenceLength(p_text, index);
    if (length == 0)
    {
      p_out += "\\ufffd";
      ++index;
      continue;
    }
    if (length > 1)
    {
      p_out.append(p_text.substr(index, length));
      index += length;
      continue;
    }
    switch (character)
    {
      case '"':
        p_out += "\\\"";
        break;
      case '\\':
        p_out += "\\\\";
        break;
      case '\n':
        p_out += "\\n";
        break;
      case '\r':
        p_out += "\\r";
        break;
      case '\t':
        p_out += "\\t";
        break;
      case '\b':
        p_out += "\\b";
        break;
      case '\f':
        p_out += "\\f";
        break;
      default:
        if (static_cast<unsigned char>(character) < 0x20)
        {
          p_out += std::format("\\u{:04x}", static_cast<int>(character));
        }
        else
        {
          p_out += character;
        }
    }
    ++index;
  }
  p_out += '"';
}

// Shortest round-trip form, written like Python's repr (5.0, not 5).
// Non-finite values become null so the output is always valid JSON.
inline void DumpDouble(double p_value, std::string& p_out)
{
  if (!std::isfinite(p_value))
  {
    p_out += "null";
    return;
  }
  const auto text = std::format("{}", p_value);
  p_out += text;
  if (text.find_first_of(".e") == std::string::npos)
  {
    p_out += ".0";
  }
}

// p_indent < 0 writes compact JSON; otherwise one item per line, indented.
inline void DumpJson(const Json& p_value, std::string& p_out, int p_indent,
                     int p_depth)
{
  const auto newline = [&](int p_level)
  {
    if (p_indent >= 0)
    {
      p_out += '\n';
      p_out.append(static_cast<std::size_t>(p_indent * p_level), ' ');
    }
  };
  std::visit(
      [&](const auto& p_item)
      {
        using Item = std::decay_t<decltype(p_item)>;
        if constexpr (std::same_as<Item, std::nullptr_t>)
        {
          p_out += "null";
        }
        else if constexpr (std::same_as<Item, bool>)
        {
          p_out += p_item ? "true" : "false";
        }
        else if constexpr (std::same_as<Item, std::int64_t>)
        {
          p_out += std::to_string(p_item);
        }
        else if constexpr (std::same_as<Item, double>)
        {
          DumpDouble(p_item, p_out);
        }
        else if constexpr (std::same_as<Item, std::string>)
        {
          DumpString(p_item, p_out);
        }
        else if constexpr (std::same_as<Item, JsonArray>)
        {
          p_out += '[';
          for (std::size_t index = 0; index < p_item.size(); ++index)
          {
            if (index > 0)
            {
              p_out += ',';
            }
            newline(p_depth + 1);
            DumpJson(p_item[index], p_out, p_indent, p_depth + 1);
          }
          if (!p_item.empty())
          {
            newline(p_depth);
          }
          p_out += ']';
        }
        else
        {
          p_out += '{';
          for (std::size_t index = 0; index < p_item.size(); ++index)
          {
            if (index > 0)
            {
              p_out += ',';
            }
            newline(p_depth + 1);
            DumpString(p_item[index].first, p_out);
            p_out += p_indent >= 0 ? ": " : ":";
            DumpJson(p_item[index].second, p_out, p_indent, p_depth + 1);
          }
          if (!p_item.empty())
          {
            newline(p_depth);
          }
          p_out += '}';
        }
      },
      p_value.value_);
}

[[nodiscard]] inline std::string DumpJson(const Json& p_value,
                                          int p_indent = -1)
{
  std::string out;
  DumpJson(p_value, out, p_indent, 0);
  return out;
}

// A whole number becomes a JSON integer, so a threshold of 50 is written as
// 50 rather than 50.0, as Python writes values that came from TOML integers.
[[nodiscard]] inline Json NumberJson(double p_value)
{
  if (std::isfinite(p_value) && p_value == std::trunc(p_value) &&
      std::fabs(p_value) < 9.0e15)
  {
    return Json(static_cast<std::int64_t>(p_value));
  }
  return Json(p_value);
}

class JsonParser
{
 public:
  explicit JsonParser(std::string_view p_text) : text_(p_text)
  {
  }

  [[nodiscard]] std::expected<Json, std::string> Parse()
  {
    for (std::size_t index = 0; index < text_.size();)
    {
      const auto length = Utf8SequenceLength(text_, index);
      if (length == 0)
      {
        return std::unexpected("invalid UTF-8");
      }
      index += length;
    }
    auto value = ParseValue(0);
    if (value)
    {
      SkipWhitespace();
      if (position_ != text_.size())
      {
        return std::unexpected(Error("extra data"));
      }
    }
    return value;
  }

 private:
  std::string_view text_;
  std::size_t position_ = 0;

  [[nodiscard]] std::string Error(std::string_view p_message) const
  {
    return std::format("{} at offset {}", p_message, position_);
  }

  void SkipWhitespace()
  {
    while (position_ < text_.size() &&
           (text_[position_] == ' ' || text_[position_] == '\t' ||
            text_[position_] == '\n' || text_[position_] == '\r'))
    {
      ++position_;
    }
  }

  [[nodiscard]] bool Consume(std::string_view p_literal)
  {
    if (text_.substr(position_).starts_with(p_literal))
    {
      position_ += p_literal.size();
      return true;
    }
    return false;
  }

  [[nodiscard]] std::expected<Json, std::string> ParseValue(int p_depth)
  {
    if (p_depth > 500)
    {
      return std::unexpected(Error("nesting too deep"));
    }
    SkipWhitespace();
    if (position_ >= text_.size())
    {
      return std::unexpected(Error("expecting value"));
    }
    const char character = text_[position_];
    if (character == '{')
    {
      return ParseObject(p_depth);
    }
    if (character == '[')
    {
      return ParseArray(p_depth);
    }
    if (character == '"')
    {
      auto text = ParseString();
      if (!text)
      {
        return std::unexpected(text.error());
      }
      return Json(std::move(*text));
    }
    if (Consume("true"))
    {
      return Json(true);
    }
    if (Consume("false"))
    {
      return Json(false);
    }
    if (Consume("null"))
    {
      return Json(nullptr);
    }
    // Python's json module also accepts these non-standard constants.
    if (Consume("NaN"))
    {
      return Json(std::nan(""));
    }
    if (Consume("Infinity"))
    {
      return Json(HUGE_VAL);
    }
    if (Consume("-Infinity"))
    {
      return Json(-HUGE_VAL);
    }
    return ParseNumber();
  }

  [[nodiscard]] std::expected<Json, std::string> ParseNumber()
  {
    const auto start = position_;
    if (position_ < text_.size() && text_[position_] == '-')
    {
      ++position_;
    }
    const auto digits_start = position_;
    while (position_ < text_.size() && text_[position_] >= '0' &&
           text_[position_] <= '9')
    {
      ++position_;
    }
    if (position_ == digits_start ||
        (text_[digits_start] == '0' && position_ - digits_start > 1))
    {
      position_ = start;
      return std::unexpected(Error("expecting value"));
    }
    bool fractional = false;
    if (position_ < text_.size() && text_[position_] == '.')
    {
      fractional = true;
      const auto fraction_start = ++position_;
      while (position_ < text_.size() && text_[position_] >= '0' &&
             text_[position_] <= '9')
      {
        ++position_;
      }
      if (position_ == fraction_start)
      {
        return std::unexpected(Error("invalid number"));
      }
    }
    if (position_ < text_.size() &&
        (text_[position_] == 'e' || text_[position_] == 'E'))
    {
      fractional = true;
      ++position_;
      if (position_ < text_.size() &&
          (text_[position_] == '+' || text_[position_] == '-'))
      {
        ++position_;
      }
      const auto exponent_start = position_;
      while (position_ < text_.size() && text_[position_] >= '0' &&
             text_[position_] <= '9')
      {
        ++position_;
      }
      if (position_ == exponent_start)
      {
        return std::unexpected(Error("invalid number"));
      }
    }
    const auto token = text_.substr(start, position_ - start);
    if (!fractional)
    {
      std::int64_t integer = 0;
      const auto result =
          std::from_chars(token.data(), token.data() + token.size(), integer);
      if (result.ec == std::errc{})
      {
        return Json(integer);
      }
    }
    // Integers beyond 64 bits become floats; range checks reject them later.
    double number = 0;
    std::from_chars(token.data(), token.data() + token.size(), number);
    return Json(number);
  }

  [[nodiscard]] std::optional<std::uint32_t> ParseHex4()
  {
    if (position_ + 4 > text_.size())
    {
      return std::nullopt;
    }
    std::uint32_t code = 0;
    const auto result = std::from_chars(text_.data() + position_,
                                        text_.data() + position_ + 4, code, 16);
    if (result.ec != std::errc{} || result.ptr != text_.data() + position_ + 4)
    {
      return std::nullopt;
    }
    position_ += 4;
    return code;
  }

  [[nodiscard]] std::expected<std::string, std::string> ParseString()
  {
    ++position_;
    std::string result;
    while (position_ < text_.size())
    {
      const char character = text_[position_++];
      if (character == '"')
      {
        return result;
      }
      if (static_cast<unsigned char>(character) < 0x20)
      {
        return std::unexpected(Error("invalid control character in string"));
      }
      if (character != '\\')
      {
        result += character;
        continue;
      }
      if (position_ >= text_.size())
      {
        break;
      }
      const char escape = text_[position_++];
      switch (escape)
      {
        case '"':
        case '\\':
        case '/':
          result += escape;
          break;
        case 'b':
          result += '\b';
          break;
        case 'f':
          result += '\f';
          break;
        case 'n':
          result += '\n';
          break;
        case 'r':
          result += '\r';
          break;
        case 't':
          result += '\t';
          break;
        case 'u':
        {
          auto code = ParseHex4();
          if (!code)
          {
            return std::unexpected(Error("invalid \\u escape"));
          }
          if (*code >= 0xD800 && *code <= 0xDBFF && Consume("\\u"))
          {
            const auto low = ParseHex4();
            if (!low)
            {
              return std::unexpected(Error("invalid \\u escape"));
            }
            if (*low >= 0xDC00 && *low <= 0xDFFF)
            {
              *code = 0x10000 + ((*code - 0xD800) << 10) + (*low - 0xDC00);
            }
            else
            {
              AppendUtf8(result, 0xFFFD);
              *code = *low;
            }
          }
          if (*code >= 0xD800 && *code <= 0xDFFF)
          {
            *code = 0xFFFD;
          }
          AppendUtf8(result, *code);
          break;
        }
        default:
          return std::unexpected(Error("invalid escape"));
      }
    }
    return std::unexpected(Error("unterminated string"));
  }

  [[nodiscard]] std::expected<Json, std::string> ParseArray(int p_depth)
  {
    ++position_;
    JsonArray items;
    SkipWhitespace();
    if (Consume("]"))
    {
      return Json(std::move(items));
    }
    while (true)
    {
      auto item = ParseValue(p_depth + 1);
      if (!item)
      {
        return item;
      }
      items.push_back(std::move(*item));
      SkipWhitespace();
      if (Consume("]"))
      {
        return Json(std::move(items));
      }
      if (!Consume(","))
      {
        return std::unexpected(Error("expecting ',' delimiter"));
      }
    }
  }

  [[nodiscard]] std::expected<Json, std::string> ParseObject(int p_depth)
  {
    ++position_;
    Json object{JsonObject{}};
    SkipWhitespace();
    if (Consume("}"))
    {
      return object;
    }
    while (true)
    {
      SkipWhitespace();
      if (position_ >= text_.size() || text_[position_] != '"')
      {
        return std::unexpected(
            Error("expecting property name enclosed in double quotes"));
      }
      auto key = ParseString();
      if (!key)
      {
        return std::unexpected(key.error());
      }
      SkipWhitespace();
      if (!Consume(":"))
      {
        return std::unexpected(Error("expecting ':' delimiter"));
      }
      auto value = ParseValue(p_depth + 1);
      if (!value)
      {
        return value;
      }
      // A repeated key keeps its last value, as in Python.
      object.Set(*key, std::move(*value));
      SkipWhitespace();
      if (Consume("}"))
      {
        return object;
      }
      if (!Consume(","))
      {
        return std::unexpected(Error("expecting ',' delimiter"));
      }
    }
  }
};

[[nodiscard]] inline std::expected<Json, std::string> ParseJson(
    std::string_view p_text)
{
  return JsonParser{p_text}.Parse();
}

}  // namespace triangulator::collector
