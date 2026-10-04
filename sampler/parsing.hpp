#pragma once

#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <limits>
#include <optional>
#include <string_view>
#include <sys/syscall.h>

namespace triangulator {

[[nodiscard]] inline std::string_view trim(std::string_view text) {
    const auto first = text.find_first_not_of(" \t\r\n");
    if (first == std::string_view::npos) return {};
    return text.substr(first, text.find_last_not_of(" \t\r\n") - first + 1);
}

[[nodiscard]] inline std::string_view next_token(std::string_view& text) {
    text = trim(text);
    const auto end = text.find_first_of(" \t\r\n");
    const auto token = text.substr(0, end);
    text = end == std::string_view::npos ? std::string_view{} : text.substr(end);
    return token;
}

template <typename Number>
[[nodiscard]] std::optional<Number> parse_number(std::string_view text) {
    if (text.empty()) return std::nullopt;
    Number value{};
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value);
    if (error != std::errc{} || end != text.data() + text.size()) return std::nullopt;
    return value;
}

[[nodiscard]] inline std::optional<std::uint64_t> parse_hex(std::string_view text) {
    if (text.starts_with("0x") || text.starts_with("0X")) text.remove_prefix(2);
    if (text.empty()) return std::nullopt;
    std::uint64_t value{};
    const auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), value, 16);
    if (error != std::errc{} || end != text.data() + text.size()) return std::nullopt;
    return value;
}

struct ThreadStat {
    std::array<char, 16> name{};
    char state{};
    std::uint64_t utime{};
    std::uint64_t stime{};
    std::uint64_t starttime{};
};

[[nodiscard]] inline std::optional<ThreadStat> parse_stat(std::string_view text) {
    const auto first = text.find('(');
    const auto last = text.rfind(')');
    if (first == std::string_view::npos || last == std::string_view::npos || last <= first ||
        last + 2 >= text.size() || text[last + 1] != ' ') return std::nullopt;
    ThreadStat result;
    std::ranges::copy(text.substr(first + 1, std::min(last - first - 1, std::size_t{15})), result.name.begin());
    auto fields = text.substr(last + 2);
    for (int field = 3; field <= 22; ++field) {
        const auto token = next_token(fields);
        if (token.empty()) return std::nullopt;
        if (field == 3) {
            if (token.size() != 1) return std::nullopt;
            result.state = token.front();
        }
        if (field == 14 || field == 15 || field == 22) {
            const auto value = parse_number<std::uint64_t>(token);
            if (!value) return std::nullopt;
            if (field == 14) result.utime = *value;
            if (field == 15) result.stime = *value;
            if (field == 22) result.starttime = *value;
        }
    }
    return result;
}

enum class SyscallSentinel : std::int16_t { not_in_syscall = -1, running = -2, unreadable = -3 };

struct Syscall {
    std::int16_t number = static_cast<std::int16_t>(SyscallSentinel::unreadable);
    std::uint32_t futex_op{};
    bool timeout_set{};

    [[nodiscard]] bool unreadable() const noexcept {
        return number == static_cast<std::int16_t>(SyscallSentinel::unreadable);
    }
};

[[nodiscard]] inline Syscall parse_syscall(std::string_view text) {
    const auto token = next_token(text);
    if (token == "running") return {.number = static_cast<std::int16_t>(SyscallSentinel::running)};
    const auto number = parse_number<std::int16_t>(token);
    if (!number || *number < -1) return {};
    Syscall result{.number = *number};
    if (*number == SYS_futex) {
        const auto address = parse_hex(next_token(text));
        const auto operation = parse_hex(next_token(text));
        const auto value = parse_hex(next_token(text));
        const auto timeout = parse_hex(next_token(text));
        if (!address || !operation || !value || !timeout || *operation > std::numeric_limits<std::uint32_t>::max()) return {};
        result.futex_op = static_cast<std::uint32_t>(*operation);
        result.timeout_set = *timeout != 0;
    }
    return result;
}

struct SchedulerCounters {
    std::uint64_t run_delay{};
    std::uint64_t timeslices{};
};

[[nodiscard]] inline std::optional<SchedulerCounters> parse_schedstat(std::string_view text) {
    const auto runtime = parse_number<std::uint64_t>(next_token(text));
    const auto delay = parse_number<std::uint64_t>(next_token(text));
    const auto slices = parse_number<std::uint64_t>(next_token(text));
    if (!runtime || !delay || !slices) return std::nullopt;
    return SchedulerCounters{*delay, *slices};
}

[[nodiscard]] inline std::optional<SchedulerCounters> parse_status(std::string_view text) {
    std::optional<std::uint64_t> voluntary;
    std::optional<std::uint64_t> nonvoluntary;
    while (!text.empty()) {
        const auto end = text.find('\n');
        const auto line = text.substr(0, end);
        text = end == std::string_view::npos ? std::string_view{} : text.substr(end + 1);
        const auto separator = line.find(':');
        if (separator == std::string_view::npos) continue;
        const auto key = line.substr(0, separator);
        if (key == "voluntary_ctxt_switches") voluntary = parse_number<std::uint64_t>(trim(line.substr(separator + 1)));
        if (key == "nonvoluntary_ctxt_switches") nonvoluntary = parse_number<std::uint64_t>(trim(line.substr(separator + 1)));
    }
    if (!voluntary || !nonvoluntary) return std::nullopt;
    return SchedulerCounters{*nonvoluntary, *voluntary};
}

}
