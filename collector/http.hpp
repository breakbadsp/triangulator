#pragma once

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/time.h>

#include <atomic>
#include <cctype>
#include <charconv>
#include <chrono>
#include <cmath>
#include <format>
#include <future>
#include <memory>
#include <mutex>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include "../sampler/io.hpp"
#include "config.hpp"
#include "json.hpp"
#include "log.hpp"
#include "storage.hpp"

namespace triangulator::collector
{

inline constexpr unsigned char kDashboardHtml[] = {
#embed "../triangulator/dashboard.html"
};

[[nodiscard]] inline double WallNow()
{
  return std::chrono::duration<double>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

// A dashboard request to change alert settings, answered by the main loop,
// which owns the monitor.
struct SettingsRequest
{
  Json body_;
  std::promise<std::pair<int, Json>> reply_;
};

// State shared between the main loop and the dashboard thread.
class SharedState
{
 public:
  void SetLive(std::string p_live)
  {
    auto live = std::make_shared<const std::string>(std::move(p_live));
    std::lock_guard lock{mutex_};
    live_ = std::move(live);
  }
  [[nodiscard]] std::shared_ptr<const std::string> Live()
  {
    std::lock_guard lock{mutex_};
    return live_;
  }
  void SetSettings(std::string p_settings)
  {
    auto settings = std::make_shared<const std::string>(std::move(p_settings));
    std::lock_guard lock{mutex_};
    settings_ = std::move(settings);
  }
  [[nodiscard]] std::shared_ptr<const std::string> Settings()
  {
    std::lock_guard lock{mutex_};
    return settings_;
  }
  void Push(std::shared_ptr<SettingsRequest> p_request)
  {
    std::lock_guard lock{mutex_};
    requests_.push_back(std::move(p_request));
  }
  [[nodiscard]] std::vector<std::shared_ptr<SettingsRequest>> TakeRequests()
  {
    std::lock_guard lock{mutex_};
    return std::exchange(requests_, {});
  }

 private:
  std::mutex mutex_;
  std::shared_ptr<const std::string> live_ =
      std::make_shared<const std::string>("{}");
  std::shared_ptr<const std::string> settings_ =
      std::make_shared<const std::string>("{}");
  std::vector<std::shared_ptr<SettingsRequest>> requests_;
};

[[nodiscard]] inline std::string Lowercase(std::string_view p_text)
{
  std::string result{p_text};
  for (auto& character : result)
  {
    character =
        static_cast<char>(std::tolower(static_cast<unsigned char>(character)));
  }
  return result;
}

[[nodiscard]] inline std::string_view TrimSpace(std::string_view p_text)
{
  const auto first = p_text.find_first_not_of(" \t\r\n\f\v");
  if (first == std::string_view::npos)
  {
    return {};
  }
  return p_text.substr(first,
                       p_text.find_last_not_of(" \t\r\n\f\v") - first + 1);
}

[[nodiscard]] inline std::string PercentDecode(std::string_view p_text)
{
  std::string result;
  for (std::size_t index = 0; index < p_text.size(); ++index)
  {
    const char character = p_text[index];
    unsigned value = 0;
    if (character == '%' && index + 2 < p_text.size() &&
        std::from_chars(p_text.data() + index + 1, p_text.data() + index + 3,
                        value, 16)
                .ptr == p_text.data() + index + 3)
    {
      result += static_cast<char>(value);
      index += 2;
    }
    else
    {
      result += character == '+' ? ' ' : character;
    }
  }
  return result;
}

// First non-blank value of each query parameter, like Python's parse_qs.
[[nodiscard]] inline std::optional<std::string> QueryValue(
    std::string_view p_query, std::string_view p_name)
{
  while (!p_query.empty())
  {
    const auto end = p_query.find('&');
    const auto pair = p_query.substr(0, end);
    p_query = end == std::string_view::npos ? std::string_view{}
                                            : p_query.substr(end + 1);
    const auto equals = pair.find('=');
    if (equals == std::string_view::npos)
    {
      continue;
    }
    if (PercentDecode(pair.substr(0, equals)) == p_name &&
        equals + 1 < pair.size())
    {
      return PercentDecode(pair.substr(equals + 1));
    }
  }
  return std::nullopt;
}

// Canonical decimal text of an integer written as Python's int() accepts
// it (surrounding blanks, a sign, underscores between digits).
[[nodiscard]] inline std::optional<std::string> PythonInteger(
    std::string_view p_text)
{
  p_text = TrimSpace(p_text);
  bool negative = false;
  if (!p_text.empty() && (p_text[0] == '+' || p_text[0] == '-'))
  {
    negative = p_text[0] == '-';
    p_text.remove_prefix(1);
  }
  std::string digits;
  for (std::size_t index = 0; index < p_text.size(); ++index)
  {
    const char character = p_text[index];
    if (character == '_' && index > 0 && index + 1 < p_text.size() &&
        std::isdigit(static_cast<unsigned char>(p_text[index - 1])) &&
        std::isdigit(static_cast<unsigned char>(p_text[index + 1])))
    {
      continue;
    }
    if (!std::isdigit(static_cast<unsigned char>(character)))
    {
      return std::nullopt;
    }
    digits += character;
  }
  if (digits.empty())
  {
    return std::nullopt;
  }
  const auto first = digits.find_first_not_of('0');
  if (first == std::string::npos)
  {
    return "0";
  }
  return (negative ? "-" : "") + digits.substr(first);
}

[[nodiscard]] inline std::optional<double> PythonFloat(std::string_view p_text)
{
  p_text = TrimSpace(p_text);
  if (p_text.starts_with('+'))
  {
    p_text.remove_prefix(1);
  }
  double value = 0;
  const auto result =
      std::from_chars(p_text.data(), p_text.data() + p_text.size(), value);
  if (p_text.empty() || result.ec != std::errc{} ||
      result.ptr != p_text.data() + p_text.size())
  {
    return std::nullopt;
  }
  return value;
}

// The host name part of a Host header, lowercased and without the port, as
// Python's urlsplit("//" + host).hostname returns it.
[[nodiscard]] inline std::string HostName(std::string_view p_host)
{
  auto netloc = p_host.substr(0, p_host.find_first_of("/?#"));
  if (const auto at = netloc.rfind('@'); at != std::string_view::npos)
  {
    netloc.remove_prefix(at + 1);
  }
  if (netloc.find('[') != std::string_view::npos)
  {
    const auto open = netloc.find('[');
    const auto close = netloc.find(']', open);
    return Lowercase(close == std::string_view::npos
                         ? netloc.substr(open + 1)
                         : netloc.substr(open + 1, close - open - 1));
  }
  return Lowercase(netloc.substr(0, netloc.find(':')));
}

// The network location of an Origin header (scheme://netloc/...).
[[nodiscard]] inline std::string_view OriginNetloc(std::string_view p_origin)
{
  const auto colon = p_origin.find(':');
  if (colon != std::string_view::npos && colon > 0 &&
      std::isalpha(static_cast<unsigned char>(p_origin[0])))
  {
    const auto scheme = p_origin.substr(0, colon);
    const bool valid = std::ranges::all_of(
        scheme,
        [](char p_character)
        {
          return std::isalnum(static_cast<unsigned char>(p_character)) ||
                 p_character == '+' || p_character == '-' || p_character == '.';
        });
    if (valid)
    {
      p_origin.remove_prefix(colon + 1);
    }
  }
  if (!p_origin.starts_with("//"))
  {
    return {};
  }
  p_origin.remove_prefix(2);
  return p_origin.substr(0, p_origin.find_first_of("/?#"));
}

[[nodiscard]] inline bool IsIpLiteral(const std::string& p_host)
{
  std::array<unsigned char, 16> address{};
  return ::inet_pton(AF_INET, p_host.c_str(), address.data()) == 1 ||
         ::inet_pton(AF_INET6, p_host.c_str(), address.data()) == 1;
}

struct Request
{
  std::string method_;
  std::string path_;
  std::string query_;
  std::vector<std::pair<std::string, std::string>> headers_;
  std::string body_start_;

  [[nodiscard]] std::optional<std::string_view> Header(
      std::string_view p_name) const
  {
    const auto name = Lowercase(p_name);
    for (const auto& [key, value] : headers_)
    {
      if (Lowercase(key) == name)
      {
        return std::string_view{value};
      }
    }
    return std::nullopt;
  }
};

// Opens a socket bound to p_host:p_port, choosing IPv6 when the host
// contains ':' as the Python collector does.
[[nodiscard]] inline FileDescriptor BindSocket(const std::string& p_host,
                                               std::int64_t p_port, int p_type)
{
  addrinfo hints{};
  hints.ai_family = p_host.find(':') != std::string::npos ? AF_INET6 : AF_INET;
  hints.ai_socktype = p_type;
  hints.ai_flags = AI_PASSIVE;
  addrinfo* found = nullptr;
  const auto port = std::to_string(p_port);
  if (const int error = ::getaddrinfo(p_host.empty() ? nullptr : p_host.c_str(),
                                      port.c_str(), &hints, &found);
      error != 0)
  {
    throw std::runtime_error(
        std::format("cannot resolve {}: {}", p_host, ::gai_strerror(error)));
  }
  std::unique_ptr<addrinfo, decltype(&::freeaddrinfo)> addresses{
      found, &::freeaddrinfo};
  FileDescriptor socket{
      ::socket(found->ai_family, found->ai_socktype | SOCK_CLOEXEC, 0)};
  if (!socket)
  {
    throw std::system_error(errno, std::generic_category(), "socket");
  }
  if (p_type == SOCK_STREAM)
  {
    const int enable = 1;
    ::setsockopt(socket.Get(), SOL_SOCKET, SO_REUSEADDR, &enable,
                 sizeof(enable));
  }
  if (::bind(socket.Get(), found->ai_addr, found->ai_addrlen) != 0)
  {
    throw std::system_error(errno, std::generic_category(),
                            std::format("bind {}:{}", p_host, p_port));
  }
  return socket;
}

// Serves the dashboard and its JSON API, one request at a time, on its own
// thread, like the Python collector's http.server.HTTPServer.
class DashboardServer
{
 public:
  DashboardServer(const Config& p_config, SharedState& p_state)
      : config_(p_config),
        state_(p_state),
        listener_(
            BindSocket(p_config.http_host_, p_config.http_port_, SOCK_STREAM))
  {
    if (::listen(listener_.Get(), 16) != 0)
    {
      throw std::system_error(errno, std::generic_category(), "listen");
    }
    thread_ = std::thread(
        [this]
        {
          Serve();
        });
  }
  ~DashboardServer()
  {
    Stop();
  }
  DashboardServer(const DashboardServer&) = delete;
  DashboardServer& operator=(const DashboardServer&) = delete;

  void Stop()
  {
    stopped_ = true;
    if (thread_.joinable())
    {
      thread_.join();
    }
  }

 private:
  const Config& config_;
  SharedState& state_;
  FileDescriptor listener_;
  std::atomic<bool> stopped_ = false;
  std::thread thread_;

  void Serve()
  {
    while (!stopped_)
    {
      pollfd ready{listener_.Get(), POLLIN, 0};
      if (::poll(&ready, 1, 200) <= 0)
      {
        continue;
      }
      FileDescriptor connection{
          ::accept4(listener_.Get(), nullptr, nullptr, SOCK_CLOEXEC)};
      if (!connection)
      {
        continue;
      }
      const timeval timeout{5, 0};
      ::setsockopt(connection.Get(), SOL_SOCKET, SO_RCVTIMEO, &timeout,
                   sizeof(timeout));
      ::setsockopt(connection.Get(), SOL_SOCKET, SO_SNDTIMEO, &timeout,
                   sizeof(timeout));
      try
      {
        Handle(connection.Get());
      }
      catch (const std::exception& error)
      {
        Log(LogLevel::Error,
            std::format("HTTP request failed: {}", error.what()));
      }
    }
  }

  static std::optional<Request> ReadRequest(int p_connection)
  {
    std::string data;
    std::array<char, 4096> buffer{};
    std::size_t header_end = std::string::npos;
    while ((header_end = data.find("\r\n\r\n")) == std::string::npos)
    {
      if (data.size() > 65536)
      {
        return std::nullopt;
      }
      const auto length = ::recv(p_connection, buffer.data(), buffer.size(), 0);
      if (length <= 0)
      {
        return std::nullopt;
      }
      data.append(buffer.data(), static_cast<std::size_t>(length));
    }
    Request request;
    std::string_view head{data.data(), header_end};
    const auto line_end = head.find("\r\n");
    const auto request_line = head.substr(0, line_end);
    const auto first_space = request_line.find(' ');
    const auto second_space = request_line.find(' ', first_space + 1);
    if (first_space == std::string_view::npos)
    {
      return std::nullopt;
    }
    request.method_ = request_line.substr(0, first_space);
    const auto target = request_line.substr(
        first_space + 1, second_space == std::string_view::npos
                             ? std::string_view::npos
                             : second_space - first_space - 1);
    auto path = target.substr(0, target.find('#'));
    if (const auto question = path.find('?'); question != std::string::npos)
    {
      request.query_ = path.substr(question + 1);
      path = path.substr(0, question);
    }
    request.path_ = path;
    head = line_end == std::string_view::npos ? std::string_view{}
                                              : head.substr(line_end + 2);
    while (!head.empty())
    {
      const auto end = head.find("\r\n");
      const auto line = head.substr(0, end);
      head = end == std::string_view::npos ? std::string_view{}
                                           : head.substr(end + 2);
      const auto colon = line.find(':');
      if (colon != std::string_view::npos)
      {
        request.headers_.emplace_back(line.substr(0, colon),
                                      TrimSpace(line.substr(colon + 1)));
      }
    }
    request.body_start_ = data.substr(header_end + 4);
    return request;
  }

  static void Respond(int p_connection, int p_code, std::string_view p_body,
                      std::string_view p_content_type)
  {
    std::string_view reason = "OK";
    switch (p_code)
    {
      case 400:
        reason = "Bad Request";
        break;
      case 403:
        reason = "Forbidden";
        break;
      case 404:
        reason = "Not Found";
        break;
      case 500:
        reason = "Internal Server Error";
        break;
      case 501:
        reason = "Unsupported method";
        break;
      case 503:
        reason = "Service Unavailable";
        break;
      default:
        break;
    }
    auto response = std::format(
        "HTTP/1.0 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\n"
        "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
        "Content-Security-Policy: default-src 'self'; script-src "
        "'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; "
        "frame-ancestors 'none'\r\n\r\n",
        p_code, reason, p_content_type, p_body.size());
    response.append(p_body);
    std::string_view remaining = response;
    while (!remaining.empty())
    {
      const auto sent = ::send(p_connection, remaining.data(), remaining.size(),
                               MSG_NOSIGNAL);
      if (sent <= 0)
      {
        return;
      }
      remaining.remove_prefix(static_cast<std::size_t>(sent));
    }
  }

  static void RespondJson(int p_connection, int p_code, const Json& p_body)
  {
    Respond(p_connection, p_code, DumpJson(p_body), "application/json");
  }

  void Handle(int p_connection)
  {
    auto request = ReadRequest(p_connection);
    if (!request)
    {
      return;
    }
    if (request->method_ == "GET")
    {
      Get(p_connection, *request);
    }
    else if (request->method_ == "POST")
    {
      Post(p_connection, *request);
    }
    else
    {
      Respond(p_connection, 501, "Unsupported method", "text/plain");
    }
  }

  void Get(int p_connection, const Request& p_request)
  {
    if (p_request.path_ == "/")
    {
      Respond(p_connection, 200,
              std::string_view{reinterpret_cast<const char*>(kDashboardHtml),
                               sizeof(kDashboardHtml)},
              "text/html; charset=utf-8");
    }
    else if (p_request.path_ == "/api/live")
    {
      Respond(p_connection, 200, *state_.Live(), "application/json");
    }
    else if (p_request.path_ == "/api/alert-settings")
    {
      Respond(p_connection, 200, *state_.Settings(), "application/json");
    }
    else if (p_request.path_ == "/api/history")
    {
      History(p_connection, p_request);
    }
    else
    {
      Respond(p_connection, 404, "Not found", "text/plain");
    }
  }

  void History(int p_connection, const Request& p_request)
  {
    const auto invalid = [&]
    {
      Respond(p_connection, 400,
              R"({"error":"session, tid and a valid time range are required"})",
              "application/json");
    };
    const auto session_text = QueryValue(p_request.query_, "session");
    const auto tid_text = QueryValue(p_request.query_, "tid");
    if (!session_text || !tid_text)
    {
      invalid();
      return;
    }
    const auto session = PythonInteger(*session_text);
    const auto tid_digits = PythonInteger(*tid_text);
    std::int64_t tid = 0;
    if (!session || !tid_digits ||
        std::from_chars(tid_digits->data(),
                        tid_digits->data() + tid_digits->size(), tid)
                .ec != std::errc{})
    {
      invalid();
      return;
    }
    const auto end_text = QueryValue(p_request.query_, "end");
    const auto end = end_text ? PythonFloat(*end_text) : WallNow();
    if (!end)
    {
      invalid();
      return;
    }
    const auto start_text = QueryValue(p_request.query_, "start");
    const auto start = start_text ? PythonFloat(*start_text) : *end - 3600;
    if (!start || !std::isfinite(*start) || !std::isfinite(*end) ||
        !(0 <= *start && *start <= *end && *end <= 253402214400.0) ||
        *end - *start > static_cast<double>(config_.retention_days_) * 86400 ||
        tid <= 0)
    {
      invalid();
      return;
    }
    auto rows =
        collector::History(config_.data_dir_, *session, tid, *start, *end);
    const bool truncated = rows.size() == 2000;
    RespondJson(p_connection, 200,
                JsonObject{{"rows", std::move(rows)},
                           {"limit", 2000},
                           {"truncated", truncated}});
  }

  // Refuses writes that a page on another site, or a rebound DNS name,
  // could send.
  [[nodiscard]] std::optional<std::string> RejectCrossSite(
      const Request& p_request) const
  {
    const auto content_type = p_request.Header("Content-Type").value_or("");
    if (p_request.Header("X-Triangulator") != "1" ||
        TrimSpace(content_type.substr(0, content_type.find(';'))) !=
            "application/json")
    {
      return "missing JSON content type or X-Triangulator header";
    }
    const auto host = p_request.Header("Host").value_or("");
    const auto hostname = HostName(host);
    const bool literal = IsIpLiteral(hostname);
    const bool allowed =
        hostname == "localhost" || hostname == Lowercase(config_.http_host_) ||
        std::ranges::find(config_.http_allowed_hosts_, hostname) !=
            config_.http_allowed_hosts_.end();
    if (!literal && !allowed)
    {
      return "host not allowed; add it to http_allowed_hosts";
    }
    if (const auto origin = p_request.Header("Origin");
        origin && OriginNetloc(*origin) != host)
    {
      return "cross-origin request refused";
    }
    return std::nullopt;
  }

  void Post(int p_connection, const Request& p_request)
  {
    if (p_request.path_ != "/api/alert-settings")
    {
      Respond(p_connection, 404, "Not found", "text/plain");
      return;
    }
    auto error = RejectCrossSite(p_request);
    std::int64_t length = 0;
    const auto length_text =
        TrimSpace(p_request.Header("Content-Length").value_or("0"));
    if (std::from_chars(length_text.data(),
                        length_text.data() + length_text.size(), length)
            .ec != std::errc{})
    {
      length = -1;
    }
    if (!error && !(0 < length && length <= 16384))
    {
      error = "request body must be 1..16384 bytes";
    }
    if (error)
    {
      const bool forbidden = error->find("origin") != std::string::npos ||
                             error->find("host") != std::string::npos;
      RespondJson(p_connection, forbidden ? 403 : 400,
                  JsonObject{{"error", *error}});
      return;
    }
    std::string body = p_request.body_start_;
    std::array<char, 4096> buffer{};
    while (body.size() < static_cast<std::size_t>(length))
    {
      const auto received =
          ::recv(p_connection, buffer.data(), buffer.size(), 0);
      if (received <= 0)
      {
        return;
      }
      body.append(buffer.data(), static_cast<std::size_t>(received));
    }
    body.resize(static_cast<std::size_t>(length));
    auto parsed = ParseJson(body);
    if (!parsed)
    {
      Respond(p_connection, 400, R"({"error":"body must be JSON"})",
              "application/json");
      return;
    }
    auto request = std::make_shared<SettingsRequest>();
    request->body_ = std::move(*parsed);
    auto reply = request->reply_.get_future();
    state_.Push(std::move(request));
    if (reply.wait_for(std::chrono::seconds{5}) != std::future_status::ready)
    {
      RespondJson(p_connection, 503,
                  JsonObject{{"error", "collector busy; try again"}});
      return;
    }
    auto [code, payload] = reply.get();
    RespondJson(p_connection, code, payload);
  }
};

}  // namespace triangulator::collector
