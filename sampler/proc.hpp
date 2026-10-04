#pragma once

#include "config.hpp"
#include "protocol.hpp"

#include <vector>

namespace triangulator {

struct TargetIdentity {
    int pid{};
    std::uint64_t starttime{};
    bool operator==(const TargetIdentity&) const = default;
};

[[nodiscard]] inline std::optional<TargetIdentity> find_target(const TargetSelector& selector) {
    int pid = 0;
    std::array<char, 4096> buffer{};
    if (const auto* selected = std::get_if<TargetPid>(&selector)) {
        pid = selected->value;
    } else {
        const auto& name = std::get<TargetName>(selector).value;
        const Directory directory{::opendir("/proc")};
        if (!directory) return std::nullopt;
        while (const auto* entry = ::readdir(directory.get())) {
            const auto candidate = parse_number<int>(entry->d_name);
            if (!candidate || *candidate <= 0) continue;
            const auto descriptor = open_readonly(std::format("/proc/{}/comm", *candidate).c_str());
            auto comm = read_at_start(descriptor, buffer);
            if (!comm) continue;
            if (comm->ends_with('\n')) comm->remove_suffix(1);
            if (*comm != name) continue;
            if (pid != 0) return std::nullopt;
            pid = *candidate;
        }
    }
    if (!pid) return std::nullopt;
    const auto descriptor = open_readonly(std::format("/proc/{}/stat", pid).c_str());
    const auto contents = read_at_start(descriptor, buffer);
    const auto stat = contents.and_then(parse_stat);
    if (!stat || stat->state == 'Z' || stat->state == 'X') return std::nullopt;
    return TargetIdentity{pid, stat->starttime};
}

class Thread {
public:
    explicit Thread(int tid) : tid_(tid) {}
    [[nodiscard]] int tid() const noexcept { return tid_; }
    bool seen = false;

    struct Sample {
        wire::Record record;
        bool syscall_unreadable;
    };

    [[nodiscard]] std::optional<Sample> sample(int pid, bool fallback, RateLimitedLogger& logger) {
        std::array<char, 8192> buffer{};
        auto contents = read_file(stat_, pid, "stat", buffer);
        if (!contents) {
            stat_.reset();
            schedstat_.reset();
            syscall_.reset();
            status_.reset();
            contents = read_file(stat_, pid, "stat", buffer);
        }
        const auto stat = contents.and_then(parse_stat);
        if (!stat) return std::nullopt;
        if (starttime_ && *starttime_ != stat->starttime) {
            schedstat_.reset();
            syscall_.reset();
            status_.reset();
        }
        starttime_ = stat->starttime;
        const auto syscall = read_file(syscall_, pid, "syscall", buffer).transform(parse_syscall).value_or(Syscall{});
        const auto counters = fallback
            ? read_file(status_, pid, "status", buffer).and_then(parse_status)
            : read_file(schedstat_, pid, "schedstat", buffer).and_then(parse_schedstat);
        if (!counters) {
            logger.warn(fallback ? "status counters unreadable; sample omitted"
                                 : "schedstat unreadable; validate host support or configure status_fallback = true");
            return std::nullopt;
        }
        return Sample{wire::encode_record(tid_, *stat, syscall, *counters), syscall.unreadable()};
    }

private:
    [[nodiscard]] std::optional<std::string_view> read_file(FileDescriptor& descriptor, int pid,
                                                           std::string_view name, std::span<char> buffer) const {
        if (!descriptor) descriptor = open_readonly(std::format("/proc/{}/task/{}/{}", pid, tid_, name).c_str());
        return read_at_start(descriptor, buffer);
    }

    int tid_;
    FileDescriptor stat_;
    FileDescriptor schedstat_;
    FileDescriptor syscall_;
    FileDescriptor status_;
    std::optional<std::uint64_t> starttime_;
};

class ThreadCache {
public:
    ThreadCache() { threads_.reserve(wire::max_threads); }
    void clear() noexcept { threads_.clear(); }
    [[nodiscard]] std::span<Thread> threads() noexcept { return threads_; }

    void rescan(int pid, RateLimitedLogger& logger) {
        std::array<std::size_t, 8192> lookup{};
        const auto slot_for = [&lookup, this](int tid) {
            auto slot = static_cast<std::size_t>((static_cast<std::uint32_t>(tid) * 2654435761U) & 8191U);
            while (lookup[slot] && threads_[lookup[slot] - 1].tid() != tid) slot = (slot + 1) & 8191U;
            return slot;
        };
        for (std::size_t index = 0; index < threads_.size(); ++index) {
            threads_[index].seen = false;
            lookup[slot_for(threads_[index].tid())] = index + 1;
        }
        const Directory directory{::opendir(std::format("/proc/{}/task", pid).c_str())};
        if (!directory) { clear(); return; }
        while (const auto* entry = ::readdir(directory.get())) {
            const auto tid = parse_number<int>(entry->d_name);
            if (!tid || *tid <= 0) continue;
            const auto slot = slot_for(*tid);
            if (!lookup[slot]) {
                if (threads_.size() == wire::max_threads) {
                    logger.warn("thread limit (4845) exceeded; excess threads omitted");
                    continue;
                }
                threads_.emplace_back(*tid);
                lookup[slot] = threads_.size();
            }
            threads_[lookup[slot] - 1].seen = true;
        }
        std::erase_if(threads_, [](const Thread& thread) { return !thread.seen; });
    }

private:
    std::vector<Thread> threads_;
};

}
