#include "proc.hpp"

#include <csignal>
#include <sys/random.h>

namespace triangulator {
namespace {

volatile std::sig_atomic_t reload_requested = 0;
volatile std::sig_atomic_t stop_requested = 0;

extern "C" void on_signal(int number) {
    if (number == SIGHUP) reload_requested = 1;
    else stop_requested = 1;
}

void install_signal_handlers() {
    struct sigaction action{};
    action.sa_handler = on_signal;
    ::sigemptyset(&action.sa_mask);
    for (const auto number : {SIGHUP, SIGINT, SIGTERM}) {
        if (::sigaction(number, &action, nullptr) != 0) {
            throw std::system_error(errno, std::generic_category(), "sigaction");
        }
    }
}

[[nodiscard]] std::uint64_t new_session() {
    std::uint64_t session{};
    auto bytes = std::as_writable_bytes(std::span{&session, 1});
    while (!bytes.empty()) {
        const auto length = ::getrandom(bytes.data(), bytes.size(), 0);
        if (length < 0 && errno == EINTR) continue;
        if (length <= 0) throw std::system_error(length == 0 ? EIO : errno, std::generic_category(), "getrandom");
        bytes = bytes.subspan(static_cast<std::size_t>(length));
    }
    return session;
}

class Sampler {
public:
    Sampler(RuntimeConfig config, std::size_t descriptor_limit)
        : config_(std::move(config)), threads_(descriptor_limit) {}

    void run(const char* config_path) {
        auto deadline = clock_now(CLOCK_MONOTONIC);
        while (!stop_requested) {
            if (reload_requested) {
                reload_requested = 0;
                auto next = load_config(config_path);
                if (next) {
                    config_ = std::move(*next);
                    reset_session();
                } else {
                    logger_.warn(std::format("invalid SIGHUP config; keeping previous configuration: {}", next.error()));
                }
            }
            const auto lookup = find_target(config_.settings.target);
            if (lookup) {
                sample_tick(*lookup);
            } else {
                // Not the same as "target absent": keep the session and the
                // thread cache, send nothing and retry at the next deadline.
                logger_.warn(std::format("target lookup failed: {}; tick skipped, session kept",
                                         std::generic_category().message(lookup.error())));
            }
            const auto interval = config_.settings.interval();
            const auto now = clock_now(CLOCK_MONOTONIC);
            deadline += interval;
            if (deadline <= now) deadline += interval * ((now - deadline) / interval + 1);
            sleep_until(deadline);
        }
    }

private:
    void sample_tick(const std::optional<TargetIdentity>& target) {
        if (target != previous_target_) {
            reset_session();
            previous_target_ = target;
        }
        const auto monotonic = clock_now(CLOCK_MONOTONIC);
        const auto wall = clock_now(CLOCK_REALTIME);
        const auto pid = target ? target->pid : 0;
        std::size_t count = 0;
        std::size_t sleeping_without_wchan = 0;
        if (target) {
            threads_.rescan(pid, logger_);
            for (auto& thread : threads_.threads()) {
                if (auto sample = thread.sample(pid, config_.settings.status_fallback, logger_)) {
                    records_[count++] = sample->record;
                    sleeping_without_wchan += static_cast<std::size_t>(sample->wchan_hidden);
                }
            }
            if (count && count == sleeping_without_wchan) {
                logger_.warn("wchan hidden for every sleeping thread; run the sampler as the target's UID");
            }
        }
        send_tick(pid, monotonic, wall, std::span{records_}.first(count));
    }

    void reset_session() {
        threads_.clear();
        session_ = new_session();
        sequence_ = 0;
    }

    void send_tick(int pid, Nanoseconds monotonic, Nanoseconds wall, std::span<const wire::Record> records) {
        const auto chunks = std::max(std::size_t{1}, (records.size() + wire::records_per_packet - 1) / wire::records_per_packet);
        for (std::size_t chunk = 0; chunk < chunks; ++chunk) {
            const auto offset = chunk * wire::records_per_packet;
            const auto count = std::min(records.size() - offset, wire::records_per_packet);
            wire::Packet packet{};
            const auto flags = (pid ? wire::Flags::none : wire::Flags::target_absent) |
                (config_.settings.status_fallback ? wire::Flags::status_fallback : wire::Flags::none);
            wire::encode_header(std::span{packet}.first<wire::header_size>(), {
                .flags = flags, .chunk = static_cast<std::uint8_t>(chunk), .chunks = static_cast<std::uint8_t>(chunks),
                .session = session_, .sequence = sequence_, .records = static_cast<std::uint16_t>(count),
                .monotonic_ns = static_cast<std::uint64_t>(monotonic.count()), .wall_ns = static_cast<std::uint64_t>(wall.count()),
                .interval_ms = config_.settings.interval_ms(), .pid = static_cast<std::uint32_t>(pid),
            });
            const auto bytes = std::as_bytes(records.subspan(offset, count));
            std::ranges::copy(bytes, std::span{packet}.subspan<wire::header_size>().begin());
            const auto& endpoint = config_.endpoint;
            if (::sendto(endpoint.socket.get(), packet.data(), wire::header_size + bytes.size(), MSG_DONTWAIT,
                         reinterpret_cast<const sockaddr*>(&endpoint.address), endpoint.address_length) < 0 &&
                errno != EAGAIN && errno != EWOULDBLOCK && errno != ENOBUFS) {
                logger_.warn("UDP send failed; samples dropped");
            }
        }
        ++sequence_;
    }

    static void sleep_until(Nanoseconds deadline) {
        const auto seconds = std::chrono::duration_cast<std::chrono::seconds>(deadline);
        const timespec wake{.tv_sec = static_cast<time_t>(seconds.count()),
                            .tv_nsec = static_cast<long>((deadline - seconds).count())};
        while (!stop_requested && !reload_requested) {
            const auto error = ::clock_nanosleep(CLOCK_MONOTONIC, TIMER_ABSTIME, &wake, nullptr);
            if (error == 0) break;
            if (error != EINTR) throw std::system_error(error, std::generic_category(), "clock_nanosleep");
        }
    }

    RuntimeConfig config_;
    ThreadCache threads_;
    std::array<wire::Record, wire::max_threads> records_{};
    RateLimitedLogger logger_;
    std::optional<TargetIdentity> previous_target_;
    std::uint64_t session_ = new_session();
    std::uint32_t sequence_ = 0;
};

}
}

int main(int argc, char** argv) {
    if (argc != 2) {
        std::fprintf(stderr, "usage: %s CONFIG\n", argv[0]);
        return 2;
    }
    try {
        auto config = triangulator::load_config(argv[1]);
        if (!config) {
            std::fprintf(stderr, "invalid sampler config: %s\n", config.error().c_str());
            return 2;
        }
        triangulator::install_signal_handlers();
        triangulator::Sampler sampler{std::move(*config), triangulator::raise_descriptor_limit()};
        sampler.run(argv[1]);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "triangulator: %s\n", error.what());
        return 1;
    }
}
