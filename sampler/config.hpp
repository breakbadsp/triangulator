#pragma once

#include "io.hpp"
#include "parsing.hpp"

#include <cmath>
#include <expected>
#include <format>
#include <netdb.h>
#include <string>
#include <sys/socket.h>
#include <variant>

namespace triangulator {

struct TargetPid { int value; };
struct TargetName { std::string value; };
using TargetSelector = std::variant<TargetPid, TargetName>;

struct Config {
    TargetSelector target = TargetPid{0};
    double rate_hz = 1.0;
    std::string collector;
    bool status_fallback = false;

    [[nodiscard]] Nanoseconds interval() const noexcept {
        return std::chrono::duration_cast<Nanoseconds>(std::chrono::duration<double>{1.0 / rate_hz});
    }
    [[nodiscard]] std::uint32_t interval_ms() const noexcept {
        return static_cast<std::uint32_t>(std::chrono::round<std::chrono::milliseconds>(interval()).count());
    }
};

[[nodiscard]] inline std::expected<Config, std::string> parse_config(std::string_view contents) {
    Config config;
    bool target_set = false;
    std::array<std::string_view, 5> keys{};
    std::size_t key_count = 0;
    while (!contents.empty()) {
        const auto end = contents.find('\n');
        auto line = contents.substr(0, end);
        contents = end == std::string_view::npos ? std::string_view{} : contents.substr(end + 1);
        if (line.size() > 1023) return std::unexpected("configuration line exceeds 1023 bytes");
        bool quoted = false;
        for (std::size_t index = 0; index < line.size(); ++index) {
            if (line[index] == '"') quoted = !quoted;
            if (line[index] == '#' && !quoted) { line = line.substr(0, index); break; }
        }
        if (quoted) return std::unexpected("unterminated quoted value");
        line = trim(line);
        if (line.empty()) continue;
        const auto separator = line.find('=');
        if (separator == std::string_view::npos) return std::unexpected("expected key = value");
        const auto key = trim(line.substr(0, separator));
        auto value = trim(line.substr(separator + 1));
        if (std::ranges::find(keys, key) != keys.end()) return std::unexpected("duplicate or empty configuration key");
        if (key_count == keys.size()) return std::unexpected("too many configuration keys");
        keys[key_count++] = key;
        if (value.size() >= 2 && value.front() == '"' && value.back() == '"') {
            value = value.substr(1, value.size() - 2);
        }
        if (value.find('"') != std::string_view::npos) return std::unexpected("embedded quotes are unsupported");
        if (key == "target_pid" || key == "target_process") {
            if (target_set) return std::unexpected("set exactly one of target_pid and target_process");
            target_set = true;
            if (key == "target_pid") {
                const auto pid = parse_number<int>(value);
                if (!pid || *pid <= 0) return std::unexpected("target_pid must be a positive integer");
                config.target = TargetPid{*pid};
            } else {
                if (value.empty() || value.size() > 15) return std::unexpected("target_process must contain 1..15 bytes");
                config.target = TargetName{std::string{value}};
            }
        } else if (key == "rate_hz") {
            const auto rate = parse_number<double>(value);
            if (!rate || !std::isfinite(*rate) || *rate < 0.2 || *rate > 10.0) {
                return std::unexpected("rate_hz must be between 0.2 and 10");
            }
            config.rate_hz = *rate;
        } else if (key == "collector") {
            if (value.empty() || value.size() > 255) return std::unexpected("invalid collector address length");
            config.collector = value;
        } else if (key == "status_fallback") {
            if (value != "true" && value != "false") return std::unexpected("status_fallback must be true or false");
            config.status_fallback = value == "true";
        } else {
            return std::unexpected(std::format("unknown configuration key: {}", key));
        }
    }
    if (!target_set || config.collector.empty()) return std::unexpected("target and collector are required");
    return config;
}

struct Endpoint {
    FileDescriptor socket;
    sockaddr_storage address{};
    socklen_t address_length{};
};

struct AddressInfoCloser {
    void operator()(addrinfo* address) const noexcept { ::freeaddrinfo(address); }
};

[[nodiscard]] inline std::expected<Endpoint, std::string> make_endpoint(std::string_view collector) {
    const auto separator = collector.rfind(':');
    if (separator == std::string_view::npos) return std::unexpected("collector must be numeric-IP:port");
    auto host = collector.substr(0, separator);
    const auto port = collector.substr(separator + 1);
    const auto port_number = parse_number<unsigned>(port);
    if (!port_number || *port_number == 0 || *port_number > 65535) return std::unexpected("collector port must be 1..65535");
    if (host.starts_with('[')) {
        if (!host.ends_with(']')) return std::unexpected("invalid bracketed IPv6 address");
        host = host.substr(1, host.size() - 2);
    }
    addrinfo hints{};
    hints.ai_flags = AI_NUMERICHOST | AI_NUMERICSERV;
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_DGRAM;
    addrinfo* raw_address = nullptr;
    const auto error = ::getaddrinfo(std::string{host}.c_str(), std::string{port}.c_str(), &hints, &raw_address);
    if (error != 0) return std::unexpected(std::format("collector requires a numeric IP: {}", ::gai_strerror(error)));
    const std::unique_ptr<addrinfo, AddressInfoCloser> address{raw_address};
    Endpoint endpoint;
    endpoint.socket = FileDescriptor{::socket(address->ai_family, SOCK_DGRAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0)};
    if (!endpoint.socket) return std::unexpected(std::format("socket: {}", std::generic_category().message(errno)));
    std::ranges::copy(std::span{reinterpret_cast<const std::byte*>(address->ai_addr), address->ai_addrlen},
                      reinterpret_cast<std::byte*>(&endpoint.address));
    endpoint.address_length = address->ai_addrlen;
    return endpoint;
}

struct RuntimeConfig {
    Config settings;
    Endpoint endpoint;
};

[[nodiscard]] inline std::expected<RuntimeConfig, std::string> load_config(const char* path) {
    const auto descriptor = open_readonly(path);
    std::array<char, 16384> buffer{};
    const auto contents = read_at_start(descriptor, buffer);
    if (!contents) return std::unexpected("cannot read configuration (must be nonempty and smaller than 16 KiB)");
    auto config = parse_config(*contents);
    if (!config) return std::unexpected(config.error());
    auto endpoint = make_endpoint(config->collector);
    if (!endpoint) return std::unexpected(endpoint.error());
    return RuntimeConfig{std::move(*config), std::move(*endpoint)};
}

}
