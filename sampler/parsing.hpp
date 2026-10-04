#pragma once

#include <algorithm>
#include <array>
#include <charconv>
#include <cstdint>
#include <optional>
#include <string_view>

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
    std::uint64_t major_faults{};
    std::uint64_t utime{};
    std::uint64_t stime{};
    std::uint64_t starttime{};
    std::uint16_t processor{};
};

[[nodiscard]] inline std::optional<ThreadStat> parse_stat(std::string_view text) {
    const auto first = text.find('(');
    const auto last = text.rfind(')');
    if (first == std::string_view::npos || last == std::string_view::npos || last <= first ||
        last + 2 >= text.size() || text[last + 1] != ' ') return std::nullopt;
    ThreadStat result;
    std::ranges::copy(text.substr(first + 1, std::min(last - first - 1, std::size_t{15})), result.name.begin());
    auto fields = text.substr(last + 2);
    for (int field = 3; field <= 39; ++field) {
        const auto token = next_token(fields);
        if (token.empty()) return std::nullopt;
        if (field == 3) {
            if (token.size() != 1) return std::nullopt;
            result.state = token.front();
        }
        if (field == 12 || field == 14 || field == 15 || field == 22) {
            const auto value = parse_number<std::uint64_t>(token);
            if (!value) return std::nullopt;
            if (field == 12) result.major_faults = *value;
            if (field == 14) result.utime = *value;
            if (field == 15) result.stime = *value;
            if (field == 22) result.starttime = *value;
        }
        if (field == 39) {
            const auto value = parse_number<std::uint16_t>(token);
            if (!value) return std::nullopt;
            result.processor = *value;
        }
    }
    return result;
}

// Kernel function a sleeping thread waits in. "0" means running, or no access.
// Compiler suffixes such as ".constprop.0" or ".isra.0" are dropped.
using WaitChannel = std::array<char, 32>;

[[nodiscard]] inline WaitChannel parse_wchan(std::string_view text) {
    WaitChannel result{};
    text = trim(text);
    text = text.substr(0, text.find('.'));
    if (text == "0") return result;
    std::ranges::copy(text.substr(0, result.size()), result.begin());
    return result;
}

struct IoCounters {
    std::uint64_t read_bytes{};
    std::uint64_t write_bytes{};
};

// rchar and wchar from /proc/<pid>/task/<tid>/io: bytes moved by read- and
// write-family syscalls, including sockets and pipes.
[[nodiscard]] inline std::optional<IoCounters> parse_io(std::string_view text) {
    std::optional<std::uint64_t> read;
    std::optional<std::uint64_t> written;
    while (!text.empty()) {
        const auto end = text.find('\n');
        const auto line = text.substr(0, end);
        text = end == std::string_view::npos ? std::string_view{} : text.substr(end + 1);
        const auto separator = line.find(':');
        if (separator == std::string_view::npos) continue;
        const auto key = line.substr(0, separator);
        if (key == "rchar") read = parse_number<std::uint64_t>(trim(line.substr(separator + 1)));
        if (key == "wchar") written = parse_number<std::uint64_t>(trim(line.substr(separator + 1)));
    }
    if (!read || !written) return std::nullopt;
    return IoCounters{*read, *written};
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
