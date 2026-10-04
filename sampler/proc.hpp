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

// Value: the target, or nullopt when it is absent. Error: errno when the lookup
// itself failed for lack of file descriptors, so the caller must not treat the
// target as gone.
using TargetLookup = std::expected<std::optional<TargetIdentity>, int>;

[[nodiscard]] inline TargetLookup find_target(const TargetSelector& selector) {
    int pid = 0;
    std::array<char, 4096> buffer{};
    if (const auto* selected = std::get_if<TargetPid>(&selector)) {
        pid = selected->value;
    } else {
        const auto& name = std::get<TargetName>(selector).value;
        const Directory directory{::opendir("/proc")};
        if (!directory) {
            if (descriptors_exhausted(errno)) return std::unexpected(errno);
            return std::nullopt;
        }
        while (const auto* entry = ::readdir(directory.get())) {
            const auto candidate = parse_number<int>(entry->d_name);
            if (!candidate || *candidate <= 0) continue;
            const auto descriptor = open_readonly(std::format("/proc/{}/comm", *candidate).c_str());
            if (!descriptor && descriptors_exhausted(errno)) return std::unexpected(errno);
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
    if (!descriptor && descriptors_exhausted(errno)) return std::unexpected(errno);
    const auto contents = read_at_start(descriptor, buffer);
    const auto stat = contents.and_then(parse_stat);
    if (!stat || stat->state == 'Z' || stat->state == 'X') return std::nullopt;
    return TargetIdentity{pid, stat->starttime};
}

class Thread {
public:
    // Files read per thread each tick: stat, schedstat or status, io, wchan.
    static constexpr std::size_t descriptors_per_thread = 4;

    // keep_descriptors: hold the /proc files open between ticks (cheap pread
    // per tick). Otherwise every read opens and closes the file, so this thread
    // costs no descriptors between ticks.
    Thread(int tid, bool keep_descriptors) : tid_(tid), keep_descriptors_(keep_descriptors) {}
    [[nodiscard]] int tid() const noexcept { return tid_; }
    [[nodiscard]] bool keeps_descriptors() const noexcept { return keep_descriptors_; }
    bool seen = false;

    struct Sample {
        wire::Record record;
        bool wchan_hidden;
    };

    [[nodiscard]] std::optional<Sample> sample(int pid, bool fallback, RateLimitedLogger& logger) {
        std::array<char, 8192> buffer{};
        auto contents = read_file(stat_, pid, "stat", buffer);
        if (!contents) {
            stat_.reset();
            reset_counter_descriptors();
            contents = read_file(stat_, pid, "stat", buffer);
        }
        const auto stat = contents.and_then(parse_stat);
        if (!stat) return std::nullopt;
        if (starttime_ && *starttime_ != stat->starttime) reset_counter_descriptors();
        starttime_ = stat->starttime;
        const auto counters = fallback
            ? read_file(status_, pid, "status", buffer).and_then(parse_status)
            : read_file(schedstat_, pid, "schedstat", buffer).and_then(parse_schedstat);
        if (!counters) {
            logger.warn(fallback ? "status counters unreadable; sample omitted"
                                 : "schedstat unreadable; validate host support or configure status_fallback = true");
            return std::nullopt;
        }
        const auto io = read_file(io_, pid, "io", buffer).and_then(parse_io);
        const auto wchan = read_file(wchan_, pid, "wchan", buffer).transform(parse_wchan).value_or(WaitChannel{});
        const bool sleeping = stat->state == 'S' || stat->state == 'D';
        return Sample{wire::encode_record(tid_, *stat, *counters, io, wchan), sleeping && wchan.front() == '\0'};
    }

private:
    void reset_counter_descriptors() noexcept {
        schedstat_.reset();
        status_.reset();
        io_.reset();
        wchan_.reset();
    }

    [[nodiscard]] std::optional<std::string_view> read_file(FileDescriptor& descriptor, int pid,
                                                           std::string_view name, std::span<char> buffer) const {
        if (descriptor) return read_at_start(descriptor, buffer);
        auto opened = open_readonly(std::format("/proc/{}/task/{}/{}", pid, tid_, name).c_str());
        const auto contents = read_at_start(opened, buffer);
        if (keep_descriptors_) descriptor = std::move(opened);
        return contents;
    }

    int tid_;
    bool keep_descriptors_;
    FileDescriptor stat_;
    FileDescriptor schedstat_;
    FileDescriptor status_;
    FileDescriptor io_;
    FileDescriptor wchan_;
    std::optional<std::uint64_t> starttime_;
};

class ThreadCache {
public:
    // Descriptors left for everything else: stdio, the UDP socket, the /proc
    // and task/ directory scans, the target lookup and per-tick reopens.
    static constexpr std::size_t reserved_descriptors = 32;

    explicit ThreadCache(std::size_t descriptor_limit)
        : max_kept_(descriptor_limit > reserved_descriptors
                        ? (descriptor_limit - reserved_descriptors) / Thread::descriptors_per_thread : 0) {
        threads_.reserve(wire::max_threads);
    }
    void clear() noexcept { threads_.clear(); kept_ = 0; }
    [[nodiscard]] std::size_t max_kept() const noexcept { return max_kept_; }
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
        if (!directory) {
            // Out of descriptors: keep the cache as it is and try again next tick.
            if (!descriptors_exhausted(errno)) clear();
            return;
        }
        while (const auto* entry = ::readdir(directory.get())) {
            const auto tid = parse_number<int>(entry->d_name);
            if (!tid || *tid <= 0) continue;
            const auto slot = slot_for(*tid);
            if (!lookup[slot]) {
                if (threads_.size() == wire::max_threads) {
                    logger.warn("thread limit (2550) exceeded; excess threads omitted");
                    continue;
                }
                const bool keep = kept_ < max_kept_;
                if (!keep) logger.warn(std::format("descriptor limit allows keeping files open for {} threads; "
                                                   "others reopen their /proc files every tick", max_kept_));
                kept_ += static_cast<std::size_t>(keep);
                threads_.emplace_back(*tid, keep);
                lookup[slot] = threads_.size();
            }
            threads_[lookup[slot] - 1].seen = true;
        }
        std::erase_if(threads_, [this](const Thread& thread) {
            if (thread.seen) return false;
            kept_ -= static_cast<std::size_t>(thread.keeps_descriptors());
            return true;
        });
    }

private:
    std::size_t max_kept_;
    std::size_t kept_ = 0;
    std::vector<Thread> threads_;
};

}
