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
#include <expected>
#include <format>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

#include "../common/fd.hpp"
#include "config.hpp"
#include "json.hpp"
#include "log.hpp"
#include "replay.hpp"
#include "socket_report.hpp"
#include "storage.hpp"
#include "target_control.hpp"

namespace triangulator::collector
{

// dashboard.html, as bytes the Makefile writes to build/dashboard_html.inc.
inline constexpr unsigned char kDashboardHtml[] = {
#include "dashboard_html.inc"
};

[[nodiscard]] inline double WallNow()
{
  return std::chrono::duration<double>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

// The latest /api/live payload, written by the main loop and read by the
// dashboard thread.
class SharedState
{
 public:
  void SetLive(std::shared_ptr<const std::string> p_live)
  {
    std::lock_guard lock{mutex_};
    live_ = std::move(p_live);
  }
  [[nodiscard]] std::shared_ptr<const std::string> Live()
  {
    std::lock_guard lock{mutex_};
    return live_;
  }

 private:
  std::mutex mutex_;
  std::shared_ptr<const std::string> live_ =
      std::make_shared<const std::string>("{}");
};

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

struct Request
{
  std::string method_;
  std::string path_;
  std::string query_;
  std::string body_;
  bool dashboard_write_ = false;
  std::string origin_;
  std::string host_;
};

enum class RequestError
{
  Empty = 0,
  Invalid,
};

// errno as text, read at once so a later call can't overwrite it.
[[nodiscard]] inline std::string ErrnoText()
{
  return std::generic_category().message(errno);
}

// Opens a socket bound to p_host:p_port, choosing IPv6 when the host
// contains ':' as the Python collector does.
[[nodiscard]] inline std::expected<FileDescriptor, std::string> BindSocket(
    const std::string& p_host, std::int64_t p_port, int p_type)
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
    return std::unexpected(
        std::format("cannot resolve {}: {}", p_host, ::gai_strerror(error)));
  }
  std::unique_ptr<addrinfo, decltype(&::freeaddrinfo)> addresses{
      found, &::freeaddrinfo};
  FileDescriptor socket{
      ::socket(found->ai_family, found->ai_socktype | SOCK_CLOEXEC, 0)};
  if (!socket)
  {
    return std::unexpected(std::format("socket: {}", ErrnoText()));
  }
  if (p_type == SOCK_STREAM)
  {
    const int enable = 1;
    ::setsockopt(socket.Get(), SOL_SOCKET, SO_REUSEADDR, &enable,
                 sizeof(enable));
  }
  if (::bind(socket.Get(), found->ai_addr, found->ai_addrlen) != 0)
  {
    return std::unexpected(
        std::format("bind {}:{}: {}", p_host, p_port, ErrnoText()));
  }
  return socket;
}

// A TCP socket bound to p_host:p_port and listening.
[[nodiscard]] inline std::expected<FileDescriptor, std::string> Listen(
    const std::string& p_host, std::int64_t p_port)
{
  auto socket = BindSocket(p_host, p_port, SOCK_STREAM);
  if (socket && ::listen(socket->Get(), 16) != 0)
  {
    return std::unexpected(std::format("listen: {}", ErrnoText()));
  }
  return socket;
}

// Serves the dashboard and its JSON API, one request at a time, on its own
// thread, like the Python collector's http.server.HTTPServer. Construct it
// with a socket from Listen(), then call Start().
class DashboardServer
{
 public:
  DashboardServer(const Config& p_config, SharedState& p_state,
                  FileDescriptor p_listener)
      : config_(p_config),
        state_(p_state),
        listener_(std::move(p_listener)),
        socket_reports_(p_config.data_dir_)
  {
  }

  // Starts the socket report worker and the serving thread. std::thread
  // reports failure (no resources for another thread) by throwing; this and
  // SocketReportBridge::Start() are the places it is caught.
  [[nodiscard]] std::expected<void, std::string> Start()
  {
    if (auto started = socket_reports_.Start(); !started)
    {
      return started;
    }
    try
    {
      thread_ = std::thread(
          [this]
          {
            Serve();
          });
    }
    catch (const std::system_error& error)
    {
      return std::unexpected(
          std::format("cannot start the dashboard thread: {}", error.what()));
    }
    return {};
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
  SocketReportBridge socket_reports_;

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
      // Last resort at the top of the thread: a bug or an exception from
      // the standard library ends this request, not the collector.
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

  [[nodiscard]] static std::expected<Request, RequestError> ReadRequest(
      int p_connection)
  {
    std::string data;
    std::array<char, 4096> buffer{};
    std::size_t header_end = std::string::npos;
    while ((header_end = data.find("\r\n\r\n")) == std::string::npos)
    {
      if (data.size() > 65536)
      {
        return std::unexpected(RequestError::Invalid);
      }
      const auto length = ::recv(p_connection, buffer.data(), buffer.size(), 0);
      if (length <= 0)
      {
        // Browsers may open a speculative connection without sending a
        // request. Preserve the original silent close in that case.
        return std::unexpected(data.empty() ? RequestError::Empty
                                            : RequestError::Invalid);
      }
      data.append(buffer.data(), static_cast<std::size_t>(length));
    }
    Request request;
    std::string_view head{data.data(), header_end};
    const auto line_end = head.find("\r\n");
    const auto request_line = head.substr(0, line_end);
    const auto first_space = request_line.find(' ');
    const auto second_space = request_line.find(' ', first_space + 1);
    if (first_space == std::string_view::npos || first_space == 0)
    {
      return std::unexpected(RequestError::Invalid);
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
    std::size_t body_bytes = 0;
    bool length_seen = false;
    auto headers = line_end == std::string_view::npos
                       ? std::string_view{}
                       : head.substr(line_end + 2);
    while (!headers.empty())
    {
      const auto end = headers.find("\r\n");
      const auto line = headers.substr(0, end);
      headers = end == std::string_view::npos ? std::string_view{}
                                              : headers.substr(end + 2);
      const auto colon = line.find(':');
      if (colon == std::string_view::npos)
      {
        return std::unexpected(RequestError::Invalid);
      }
      std::string name{line.substr(0, colon)};
      for (auto& character : name)
      {
        character = static_cast<char>(
            std::tolower(static_cast<unsigned char>(character)));
      }
      const auto value = TrimSpace(line.substr(colon + 1));
      if (name == "content-length")
      {
        const auto size = triangulator::ParseNumber<std::size_t>(value);
        if (length_seen || !size || *size > 1024)
        {
          return std::unexpected(RequestError::Invalid);
        }
        length_seen = true;
        body_bytes = *size;
      }
      else if (name == "transfer-encoding")
      {
        return std::unexpected(RequestError::Invalid);
      }
      else if (name == "x-triangulator")
      {
        request.dashboard_write_ = value == "1";
      }
      else if (name == "origin")
      {
        request.origin_ = value;
      }
      else if (name == "host")
      {
        request.host_ = value;
      }
    }
    const auto body_start = header_end + 4;
    while (data.size() - body_start < body_bytes)
    {
      const auto length = ::recv(
          p_connection, buffer.data(),
          std::min(buffer.size(), body_bytes - (data.size() - body_start)), 0);
      if (length <= 0)
      {
        return std::unexpected(RequestError::Invalid);
      }
      data.append(buffer.data(), static_cast<std::size_t>(length));
    }
    request.body_ = data.substr(body_start, body_bytes);
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
      if (request.error() == RequestError::Invalid)
      {
        RespondJson(p_connection, 400,
                    JsonObject{{"error", "invalid HTTP request"}});
      }
      return;
    }
    if (request->method_ == "GET")
    {
      Get(p_connection, *request);
    }
    else if (request->method_ == "POST" && request->path_ == "/api/target")
    {
      if (!request->dashboard_write_ ||
          (!request->origin_.empty() &&
           request->origin_ != "http://" + request->host_ &&
           request->origin_ != "https://" + request->host_))
      {
        RespondJson(p_connection, 403,
                    JsonObject{{"error", "dashboard request required"}});
        return;
      }
      const auto body = ParseJson(request->body_);
      const auto* target = body ? body->Find("target") : nullptr;
      if (target == nullptr || !target->IsString() ||
          target->AsString().empty() || target->AsString().size() > 64 ||
          target->AsString().find('\0') != std::string::npos)
      {
        RespondJson(p_connection, 400,
                    JsonObject{{"error", "enter a process name or PID"}});
        return;
      }
      Target(p_connection, target->AsString());
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
    else if (p_request.path_ == "/api/target")
    {
      Target(p_connection, std::nullopt);
    }
    else if (p_request.path_ == "/api/socket-io")
    {
      const auto pid_text = QueryValue(p_request.query_, "pid").value_or("0");
      const auto pid = triangulator::ParseNumber<std::uint32_t>(pid_text);
      const auto observer =
          QueryValue(p_request.query_, "observer").value_or("");
      if (!pid || (!observer.empty() &&
                   !triangulator::ParseNumber<unsigned long long>(observer)))
      {
        Respond(p_connection, 400, R"({"error":"invalid pid or observer"})",
                "application/json");
        return;
      }
      const auto report = socket_reports_.Request(*pid, observer);
      Respond(p_connection, 200, *report, "application/json");
    }
    else if (p_request.path_ == "/api/replay")
    {
      Replay(p_connection, p_request);
    }
    else if (p_request.path_ == "/api/history")
    {
      History(p_connection, p_request);
    }
    else if (p_request.path_ == "/api/resources")
    {
      Resources(p_connection, p_request);
    }
    else
    {
      Respond(p_connection, 404, "Not found", "text/plain");
    }
  }

  void Target(int p_connection, const std::optional<std::string>& p_target)
  {
    // Local development control only. Remote deployments keep their existing
    // sampler-side administration, with no new runtime dependency.
    const auto loopback = [](const std::string& p_host)
    {
      const auto ip = NormalizeIp(p_host);
      return ip && (ip->starts_with("127.") || *ip == "::1");
    };
    if (!loopback(config_.http_host_) ||
        (config_.sampler_ip_ && !loopback(*config_.sampler_ip_)))
    {
      RespondJson(p_connection, p_target ? 403 : 200,
                  JsonObject{{"enabled", false},
                             {"error",
                              "target control is available for a local sampler "
                              "on a loopback dashboard"}});
      return;
    }
    auto result =
        RunTargetControl(config_.udp_host_, config_.udp_port_, p_target);
    if (!result)
    {
      RespondJson(p_connection, 503, JsonObject{{"error", result.error()}});
      return;
    }
    const auto* enabled = result->Find("enabled");
    const bool available =
        enabled != nullptr && enabled->IsBool() && enabled->AsBool();
    const int code = result->Find("error")    ? (p_target ? 400 : 200)
                     : p_target && !available ? 403
                                              : 200;
    RespondJson(p_connection, code, *result);
  }

  // Stored resource samples between start and end (default: the last 15
  // minutes), combined into at most about 1,000 buckets.
  void Resources(int p_connection, const Request& p_request)
  {
    const auto end_text = QueryValue(p_request.query_, "end");
    const auto end = end_text ? PythonFloat(*end_text) : WallNow();
    const auto start_text = QueryValue(p_request.query_, "start");
    const auto start = start_text ? PythonFloat(*start_text)
                       : end      ? std::optional{*end - 900}
                                  : std::nullopt;
    if (!start || !end || !std::isfinite(*start) || !std::isfinite(*end) ||
        !(0 <= *start && *start <= *end && *end <= 253402214400.0) ||
        *end - *start > static_cast<double>(config_.retention_days_) * 86400)
    {
      Respond(p_connection, 400,
              R"({"error":"a valid time range is required"})",
              "application/json");
      return;
    }
    const double bucket = std::max(1.0, std::ceil((*end - *start) / 1000));
    auto history =
        collector::ResourceHistory(config_.data_dir_, *start, *end, bucket);
    RespondJson(p_connection, 200,
                JsonObject{{"rows", std::move(history.rows_)},
                           {"bucket_s", bucket},
                           {"truncated", history.truncated_},
                           {"read_error", history.read_error_}});
  }

  void Replay(int p_connection, const Request& p_request)
  {
    const auto at_text = QueryValue(p_request.query_, "at");
    const auto at = at_text ? PythonFloat(*at_text) : std::nullopt;
    const auto direction =
        QueryValue(p_request.query_, "direction").value_or("at");
    if ((at_text &&
         (!at || !std::isfinite(*at) || *at < 0 || *at > 253402214400.0)) ||
        (direction != "at" && direction != "previous" && direction != "next") ||
        (!at && direction != "at"))
    {
      Respond(p_connection, 400,
              R"({"error":"valid at timestamp and direction are required"})",
              "application/json");
      return;
    }
    const auto replay = collector::Replay(config_.data_dir_, {at, direction});
    // The stored view is sent as written; parsing and re-encoding a
    // multi-megabyte view would hold up every other dashboard request.
    Respond(
        p_connection, 200,
        std::format(R"({{"first":{},"last":{},"interval_s":{},)"
                    R"("snapshot":{}}})",
                    DumpJson(Json(replay.first_)), DumpJson(Json(replay.last_)),
                    DumpJson(Json(config_.replay_interval_s_)),
                    replay.snapshot_.value_or("null")),
        "application/json");
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
};

}  // namespace triangulator::collector
