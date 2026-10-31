#pragma once

#include <sys/socket.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <expected>
#include <format>
#include <functional>
#include <new>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <thread>
#include <utility>

// Every accepted path must reach the catch-all route, so the regex route
// limit is the library's own request-target limit.
#define CPPHTTPLIB_REGEX_ROUTE_PATH_MAX_LENGTH CPPHTTPLIB_REQUEST_URI_MAX_LENGTH
#if defined(CPPHTTPLIB_OPENSSL_SUPPORT) || defined(CPPHTTPLIB_ZLIB_SUPPORT) || \
    defined(CPPHTTPLIB_BROTLI_SUPPORT) || defined(CPPHTTPLIB_ZSTD_SUPPORT)
#error "The collector builds cpp-httplib without TLS or compression."
#endif
#include <httplib.h>

#include "log.hpp"

namespace triangulator::collector
{

// HttpServer reimplements Server::process_and_close_socket with library
// internals. Check them again before a version change.
static_assert(std::string_view{CPPHTTPLIB_VERSION} == "0.64.0");

// The complete request head on the wire: request line, field lines and the
// empty line that ends them.
inline constexpr std::size_t kMaxRequestHeadBytes = 65536;
// The largest request body. A full list of watch rules (64 rules with
// 15-byte prefixes, each byte possibly a six-byte \u escape) is under 8 KiB.
inline constexpr std::size_t kMaxRequestBodyBytes = 16384;
inline constexpr std::size_t kMaxConnections = 64;
// One total deadline for reading a request and another for writing the
// response.
inline constexpr std::chrono::seconds kNetworkTimeout{5};
inline constexpr std::string_view kContentSecurityPolicy =
    "default-src 'self'; script-src 'unsafe-inline'; style-src "
    "'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'";

namespace http_detail
{

// Set only while the accept thread runs a job that it refuses: the task
// queue sees a job, not its socket, so this tells the socket hook to answer
// 503 at once.
inline thread_local bool t_refuse_connection = false;

// The library's socket stream with Triangulator's limits. The library sets a
// read deadline for the head only; one deadline from the connection start
// covers the head and the body here. While the head is read, the inner buffer
// is hidden, so the library reads it one byte at a time and every byte on the
// wire is counted before any parsing.
class LimitedStream final : public httplib::Stream
{
 public:
  LimitedStream(socket_t p_socket, const std::atomic<bool>& p_stopping)
      : inner_(p_socket, kNetworkTimeout.count(), 0, kNetworkTimeout.count(), 0,
               std::chrono::duration_cast<std::chrono::milliseconds>(
                   kNetworkTimeout)
                   .count(),
               std::chrono::steady_clock::now())
  {
    inner_.set_read_interrupt(
        [&p_stopping]
        {
          return p_stopping.load();
        });
  }

  // The head is complete; the body has its own limit.
  void EndHead()
  {
    in_head_ = false;
  }

  bool is_readable() const override
  {
    return inner_.is_readable();
  }
  bool wait_readable() const override
  {
    return inner_.wait_readable();
  }
  bool wait_writable() const override
  {
    return inner_.wait_writable();
  }
  ssize_t read(char* p_data, size_t p_size) override
  {
    if (in_head_)
    {
      p_size = std::min(p_size, kMaxRequestHeadBytes - head_bytes_);
      if (p_size == 0)
      {
        return -1;
      }
    }
    const auto count = inner_.read(p_data, p_size);
    if (in_head_ && count > 0)
    {
      head_bytes_ += static_cast<std::size_t>(count);
    }
    return count;
  }
  ssize_t write(const char* p_data, size_t p_size) override
  {
    const auto now = std::chrono::steady_clock::now();
    if (!write_deadline_)
    {
      write_deadline_ = now + kNetworkTimeout;
    }
    const auto remaining =
        std::chrono::duration_cast<std::chrono::microseconds>(*write_deadline_ -
                                                              now)
            .count();
    if (remaining <= 0 ||
        httplib::detail::select_write(inner_.socket(), remaining / 1'000'000,
                                      remaining % 1'000'000) <= 0)
    {
      return -1;
    }
    return inner_.write(p_data, p_size);
  }
  void get_remote_ip_and_port(std::string& p_ip, int& p_port) const override
  {
    inner_.get_remote_ip_and_port(p_ip, p_port);
  }
  void get_local_ip_and_port(std::string& p_ip, int& p_port) const override
  {
    inner_.get_local_ip_and_port(p_ip, p_port);
  }
  socket_t socket() const override
  {
    return inner_.socket();
  }
  time_t duration() const override
  {
    return inner_.duration();
  }
  // The library would restart the deadline for each part of the request.
  void set_max_timeout(time_t) override
  {
  }
  const char* buffered_data(size_t& p_size) const override
  {
    if (in_head_)
    {
      p_size = 0;
      return nullptr;
    }
    return inner_.buffered_data(p_size);
  }
  void consume_buffered(size_t p_size) override
  {
    inner_.consume_buffered(p_size);
  }

 private:
  httplib::detail::SocketStream inner_;
  bool in_head_ = true;
  std::size_t head_bytes_ = 0;
  std::optional<std::chrono::steady_clock::time_point> write_deadline_;
};

// At most kMaxConnections jobs exist at once, so the pool never queues work
// that has no thread. The accept thread answers a job beyond the limit
// itself.
class ConnectionSlots final : public httplib::TaskQueue
{
 public:
  bool enqueue(std::function<void()> p_job) override
  {
    if (busy_.fetch_add(1) >= kMaxConnections)
    {
      busy_.fetch_sub(1);
      t_refuse_connection = true;
      p_job();
      t_refuse_connection = false;
      return true;
    }
    if (!pool_.enqueue(
            [this, job = std::move(p_job)]
            {
              job();
              busy_.fetch_sub(1);
            }))
    {
      busy_.fetch_sub(1);
      return false;
    }
    return true;
  }
  void shutdown() override
  {
    pool_.shutdown();
  }

 private:
  static constexpr std::size_t kIdleThreads = 4;
  std::atomic<std::size_t> busy_ = 0;
  httplib::ThreadPool pool_{kIdleThreads, kMaxConnections, kMaxConnections};
};

}  // namespace http_detail

// cpp-httplib parses and writes each request. This class sets the limits:
// one request per connection, total read and write deadlines, a head and a
// body limit, at most kMaxConnections workers with an immediate 503 beyond
// them, the response policy headers, and a stop that interrupts waiting
// reads. Every route goes to one handler, which sees the raw request target
// and the socket peer in req.remote_addr.
class HttpServer final : public httplib::Server
{
 public:
  using Handler =
      std::function<void(const httplib::Request&, httplib::Response&)>;

  explicit HttpServer(Handler p_handler)
  {
    new_task_queue = []
    {
      return new http_detail::ConnectionSlots;
    };
    // The library default, SO_REUSEPORT, would let a second collector bind
    // the same port without an error.
    set_socket_options(
        [](socket_t p_socket)
        {
          const int enable = 1;
          ::setsockopt(p_socket, SOL_SOCKET, SO_REUSEADDR, &enable,
                       sizeof(enable));
        });
    set_keep_alive_max_count(1);
    set_read_timeout(kNetworkTimeout);
    set_write_timeout(kNetworkTimeout);
    set_payload_max_length(kMaxRequestBodyBytes);
    set_pre_routing_handler(
        [](const httplib::Request& p_request, httplib::Response& p_response)
        {
          // Chunked request bodies stay off, as before the library.
          if (p_request.has_header("Transfer-Encoding"))
          {
            p_response.status = httplib::StatusCode::BadRequest_400;
            return HandlerResponse::Handled;
          }
          // The library checks the limit only while it reads the body.
          if (p_request.get_header_value_u64("Content-Length") >
              kMaxRequestBodyBytes)
          {
            p_response.status = httplib::StatusCode::PayloadTooLarge_413;
            return HandlerResponse::Handled;
          }
          return HandlerResponse::Unhandled;
        });
    set_post_routing_handler(
        [](const httplib::Request&, httplib::Response& p_response)
        {
          for (const auto& [name, value] : PolicyHeaders())
          {
            p_response.set_header(std::string{name}, std::string{value});
          }
        });
    set_exception_handler(
        [](const httplib::Request&, httplib::Response& p_response,
           const std::exception_ptr& p_error)
        {
          p_response.status = httplib::StatusCode::InternalServerError_500;
          try
          {
            std::rethrow_exception(p_error);
          }
          catch (const std::bad_alloc&)
          {
            std::terminate();
          }
          catch (const std::exception& error)
          {
            Log(LogLevel::Error,
                std::format("HTTP request failed: {}", error.what()));
          }
        });
    // The library reports a bind failure only through this logger, while
    // errno still holds the reason.
    set_error_logger(
        [this](const httplib::Error& p_error, const httplib::Request*)
        {
          if (p_error == httplib::Error::BindIPAddress ||
              p_error == httplib::Error::Listen)
          {
            bind_error_ = std::generic_category().message(errno);
          }
        });
    // HEAD reaches the GET route with its method unchanged.
    constexpr std::string_view kEveryPath = ".*";
    Get(std::string{kEveryPath}, p_handler);
    Post(std::string{kEveryPath}, p_handler);
    Put(std::string{kEveryPath}, p_handler);
    Patch(std::string{kEveryPath}, p_handler);
    Delete(std::string{kEveryPath}, p_handler);
    Options(std::string{kEveryPath}, std::move(p_handler));
  }
  ~HttpServer() override
  {
    Stop();
  }
  HttpServer(const HttpServer&) = delete;
  HttpServer& operator=(const HttpServer&) = delete;
  HttpServer(HttpServer&&) = delete;
  HttpServer& operator=(HttpServer&&) = delete;

  // Binds and listens on p_host:p_port, IPv6 when the host contains ':'.
  [[nodiscard]] std::expected<void, std::string> Bind(const std::string& p_host,
                                                      std::uint16_t p_port)
  {
    set_address_family(p_host.find(':') != std::string::npos ? AF_INET6
                                                             : AF_INET);
    if (!bind_to_port(p_host, p_port, AI_PASSIVE))
    {
      if (bind_error_.empty())
      {
        return std::unexpected(
            std::format("cannot listen on {}:{}", p_host, p_port));
      }
      return std::unexpected(
          std::format("bind {}:{}: {}", p_host, p_port, bind_error_));
    }
    return {};
  }

  // Starts the accept thread. std::jthread reports failure (no resources
  // for another thread) by throwing; this is the place it is caught.
  [[nodiscard]] std::expected<void, std::string> Start()
  {
    try
    {
      thread_ = std::jthread(
          [this]
          {
            listen_after_bind();
          });
    }
    catch (const std::system_error& error)
    {
      return std::unexpected(
          std::format("cannot start the dashboard thread: {}", error.what()));
    }
    return {};
  }

  // Interrupts waiting reads, closes the listener and joins the accept
  // thread, which joins every worker first.
  void Stop()
  {
    stopping_ = true;
    stop();
    if (thread_.joinable())
    {
      thread_.join();
    }
  }

 private:
  std::atomic<bool> stopping_ = false;
  std::string bind_error_;
  std::jthread thread_;

  [[nodiscard]] static const std::array<
      std::pair<std::string_view, std::string_view>, 3>&
  PolicyHeaders()
  {
    static constexpr std::array<std::pair<std::string_view, std::string_view>,
                                3>
        kHeaders{{{"Cache-Control", "no-store"},
                  {"X-Content-Type-Options", "nosniff"},
                  {"Content-Security-Policy", kContentSecurityPolicy}}};
    return kHeaders;
  }

  // Do not wait for a slow client in the accept loop.
  static void Refuse(socket_t p_socket)
  {
    static const std::string kBusy = []
    {
      std::string text =
          "HTTP/1.1 503 Service Unavailable\r\nContent-Length: "
          "0\r\nConnection: close\r\n";
      for (const auto& [name, value] : PolicyHeaders())
      {
        text += std::format("{}: {}\r\n", name, value);
      }
      return text + "\r\n";
    }();
    ::send(p_socket, kBusy.data(), kBusy.size(), MSG_DONTWAIT | MSG_NOSIGNAL);
    httplib::detail::close_socket(p_socket);
  }

  // The library calls this for every accepted socket; it is the one place
  // that sees the socket for the whole connection.
  bool process_and_close_socket(socket_t p_socket) override
  {
    if (http_detail::t_refuse_connection)
    {
      Refuse(p_socket);
      return false;
    }
    std::string remote_address;
    int remote_port = 0;
    httplib::detail::get_remote_ip_and_port(p_socket, remote_address,
                                            remote_port);
    std::string local_address;
    int local_port = 0;
    httplib::detail::get_local_ip_and_port(p_socket, local_address, local_port);
    http_detail::LimitedStream stream{p_socket, stopping_};
    const bool served = serve_guarded(
        [&]
        {
          bool connection_closed = false;
          return process_request(stream, remote_address, remote_port,
                                 local_address, local_port, true,
                                 connection_closed,
                                 [&stream](httplib::Request& p_request)
                                 {
                                   stream.EndHead();
                                   // Range is not supported. Without this,
                                   // the library would turn a handler's
                                   // 200 into 416 for an unsatisfiable range.
                                   p_request.ranges.clear();
                                 });
        });
    httplib::detail::drain_and_close_socket(p_socket);
    return served;
  }
};

}  // namespace triangulator::collector
