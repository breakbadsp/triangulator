#pragma once

#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>

#include <algorithm>
#include <array>
#include <cctype>
#include <charconv>
#include <chrono>
#include <cmath>
#include <expected>
#include <format>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "../common/fd.hpp"
#include "../sampler/parsing.hpp"
#include "config.hpp"
#include "http_server.hpp"
#include "json.hpp"
#include "log.hpp"
#include "peer.hpp"
#include "replay.hpp"
#include "shared_state.hpp"
#include "storage.hpp"
#include "target_control.hpp"
#include "watch.hpp"

namespace triangulator::collector
{

// dashboard/dist/index.html, as bytes the Makefile writes to
// build/dashboard_html.inc.
inline constexpr unsigned char kDashboardHtml[] = {
#include "dashboard_html.inc"
};

[[nodiscard]] inline double WallNow()
{
  return std::chrono::duration<double>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
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

struct Request
{
  std::string method_;
  std::string path_;
  std::string query_;
  std::string body_;
  bool dashboard_write_ = false;
  std::string origin_;
  std::string host_;
  std::string if_match_;
  // The socket peer's address; forwarding headers are not read.
  std::string peer_;
};

// True for a write request from the dashboard page itself: it carries the
// X-Triangulator: 1 header, which a plain HTML form or a cross-site page
// cannot add without a CORS preflight that this server never approves, and
// its Origin, when sent, is this server. Every POST route checks this.
[[nodiscard]] inline bool IsDashboardWrite(const Request& p_request)
{
  return p_request.dashboard_write_ &&
         (p_request.origin_.empty() ||
          p_request.origin_ == "http://" + p_request.host_ ||
          p_request.origin_ == "https://" + p_request.host_);
}

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

// cpp-httplib serves the requests (see http_server.hpp). Its workers run
// apart from UDP ingestion, so slow viewers and history queries do not delay
// samples.
class DashboardServer
{
 public:
  DashboardServer(const Config& p_config, SharedState& p_state,
                  std::shared_ptr<WatchSettings> p_watches)
      : config_(p_config),
        state_(p_state),
        watches_(std::move(p_watches)),
        server_(
            [this](const httplib::Request& p_request,
                   httplib::Response& p_response)
            {
              Handle(p_request, p_response);
            })
  {
  }
  ~DashboardServer()
  {
    Stop();
  }
  DashboardServer(const DashboardServer&) = delete;
  DashboardServer& operator=(const DashboardServer&) = delete;

  // Binds http_host:http_port and starts serving. A bind failure stops
  // startup.
  [[nodiscard]] std::expected<void, std::string> Start()
  {
    if (auto bound = server_.Bind(
            config_.http_host_, static_cast<std::uint16_t>(config_.http_port_));
        !bound)
    {
      return bound;
    }
    return server_.Start();
  }

  // Returns after every request worker has finished.
  void Stop()
  {
    server_.Stop();
  }

 private:
  const Config& config_;
  SharedState& state_;
  std::shared_ptr<WatchSettings> watches_;
  HttpServer server_;

  static void Respond(httplib::Response& p_response, int p_code,
                      std::string_view p_body, std::string_view p_content_type)
  {
    p_response.status = p_code;
    p_response.set_content(p_body.data(), p_body.size(),
                           std::string{p_content_type});
  }

  static void RespondJson(httplib::Response& p_response, int p_code,
                          const Json& p_body)
  {
    Respond(p_response, p_code, DumpJson(p_body), "application/json");
  }

  // The handlers read the method, the raw target and a few headers, as they
  // did before the library.
  void Handle(const httplib::Request& p_http, httplib::Response& p_response)
  {
    Request request;
    request.method_ = p_http.method;
    std::string_view path = p_http.target;
    if (const auto question = path.find('?'); question != std::string::npos)
    {
      request.query_ = path.substr(question + 1);
      path = path.substr(0, question);
    }
    request.path_ = path;
    request.body_ = p_http.body;
    request.dashboard_write_ = p_http.get_header_value("X-Triangulator") == "1";
    request.origin_ = p_http.get_header_value("Origin");
    request.host_ = p_http.get_header_value("Host");
    request.if_match_ = p_http.get_header_value("If-Match");
    request.peer_ = p_http.remote_addr;
    if (request.method_ == "GET")
    {
      Get(p_response, request);
    }
    else if (request.method_ == "POST")
    {
      Post(p_response, request);
    }
    else
    {
      Respond(p_response, 501, "Unsupported method", "text/plain");
    }
  }

  void Post(httplib::Response& p_response, const Request& p_request)
  {
    const auto& path = p_request.path_;
    if (path != "/api/target" && path != "/api/targets" &&
        path != "/api/watches" && path != "/api/watches/reset")
    {
      Respond(p_response, 501, "Unsupported method", "text/plain");
      return;
    }
    if (!IsDashboardWrite(p_request))
    {
      RespondJson(p_response, 403,
                  JsonObject{{"error", "dashboard request required"}});
      return;
    }
    if (path == "/api/targets")
    {
      Target(p_response, p_request.peer_, p_request.body_, true);
      return;
    }
    if (path == "/api/watches" || path == "/api/watches/reset")
    {
      const auto key = QueryValue(p_request.query_, "target");
      const auto selected = state_.Select(key.value_or(""));
      if (key && !selected)
      {
        RespondJson(p_response, 404, JsonObject{{"error", "unknown target"}});
        return;
      }
      const auto settings = selected ? selected->watches_ : watches_;
      if (!settings)
      {
        RespondJson(
            p_response, 503,
            JsonObject{{"error", "target watch settings limit reached"}});
        return;
      }
      if (p_request.if_match_.empty())
      {
        RespondJson(p_response, 428,
                    JsonObject{{"error",
                                "Reload this dashboard before changing "
                                "watched-thread rules."}});
        return;
      }
      std::string_view revision = p_request.if_match_;
      if (revision.size() >= 2 && revision.front() == '"' &&
          revision.back() == '"')
      {
        revision.remove_prefix(1);
        revision.remove_suffix(1);
      }
      else
      {
        revision = {};
      }
      RespondWatches(p_response,
                     path == "/api/watches"
                         ? settings->Replace(p_request.body_, revision)
                         : settings->Reset(revision));
    }
    else
    {
      const auto body = ParseJson(p_request.body_);
      const auto* target = body ? body->Find("target") : nullptr;
      if (target == nullptr || !target->IsString() ||
          target->AsString().empty() || target->AsString().size() > 64 ||
          target->AsString().find('\0') != std::string::npos)
      {
        RespondJson(p_response, 400,
                    JsonObject{{"error", "enter a process name or PID"}});
        return;
      }
      Target(p_response, p_request.peer_, target->AsString());
    }
  }

  // The reply to a change of the watch rules: the rules now in force, as
  // for GET /api/watches, or the error.
  void RespondWatches(httplib::Response& p_response,
                      const std::expected<Json, WatchError>& p_result)
  {
    if (!p_result)
    {
      const int code = p_result.error().kind_ == WatchErrorKind::Conflict ? 409
                       : p_result.error().kind_ == WatchErrorKind::InvalidRules
                           ? 400
                           : 500;
      Json error{JsonObject{{"error", p_result.error().message_}}};
      if (p_result.error().kind_ == WatchErrorKind::SyncFailed)
      {
        error.Set("applied", true);
        if (p_result.error().applied_state_)
        {
          error.Set("applied_state", *p_result.error().applied_state_);
        }
      }
      RespondJson(p_response, code, error);
      return;
    }
    RespondJson(p_response, 200, *p_result);
  }

  // {"list": <the /api/targets reply>, "live": {<key>: <its /api/live>}}.
  // The views are already JSON, so they are copied, not parsed again.
  [[nodiscard]] static std::string FleetJson(
      const SharedState::FleetView& p_fleet)
  {
    std::string body = R"({"list":)";
    body += *p_fleet.targets_;
    body += R"(,"live":{)";
    bool first = true;
    for (const auto& [key, live] : p_fleet.live_)
    {
      if (!first)
      {
        body += ',';
      }
      first = false;
      DumpString(key, body);
      body += ':';
      body += *live;
    }
    body += "}}";
    return body;
  }

  void Get(httplib::Response& p_response, const Request& p_request)
  {
    const auto& path = p_request.path_;
    if (path == "/api/replay" || path == "/api/history" ||
        path == "/api/resources")
    {
      const auto stored = StoredTargetFor(p_request);
      if (!stored)
      {
        RespondJson(p_response, 404, JsonObject{{"error", "unknown target"}});
      }
      else if (path == "/api/replay")
      {
        Replay(p_response, p_request, *stored);
      }
      else if (path == "/api/history")
      {
        History(p_response, p_request, *stored);
      }
      else
      {
        Resources(p_response, p_request, *stored);
      }
      return;
    }
    const auto target_key = QueryValue(p_request.query_, "target");
    const auto target = state_.Select(target_key.value_or(""));
    // The dashboard document and the target list must load even when the
    // selected target is gone, so the page can offer a way out. Only the
    // endpoints that read one target's data reject an unknown target.
    const bool reads_target = p_request.path_ != "/" &&
                              p_request.path_ != "/api/targets" &&
                              p_request.path_ != "/api/fleet" &&
                              p_request.path_ != "/api/targets/control" &&
                              p_request.path_ != "/api/target";
    if (reads_target && target_key && !target)
    {
      RespondJson(p_response, 404, JsonObject{{"error", "unknown target"}});
      return;
    }
    if (p_request.path_ == "/")
    {
      Respond(p_response, 200,
              std::string_view{reinterpret_cast<const char*>(kDashboardHtml),
                               sizeof(kDashboardHtml)},
              "text/html; charset=utf-8");
    }
    else if (p_request.path_ == "/api/live")
    {
      Respond(p_response, 200, *(target ? target->live_ : state_.Live()),
              "application/json");
    }
    else if (p_request.path_ == "/api/last-target")
    {
      Respond(p_response, 200,
              *(target ? target->last_target_ : state_.LastTarget()),
              "application/json");
    }
    else if (p_request.path_ == "/api/memory-map")
    {
      Respond(p_response, 200,
              *(target ? target->memory_map_ : state_.MemoryMap()),
              "application/json");
    }
    else if (p_request.path_ == "/api/targets")
    {
      Respond(p_response, 200, *state_.Targets(), "application/json");
    }
    else if (p_request.path_ == "/api/fleet")
    {
      Respond(p_response, 200, FleetJson(state_.Fleet()), "application/json");
    }
    else if (p_request.path_ == "/api/targets/control")
    {
      Target(p_response, p_request.peer_, std::nullopt, true);
    }
    else if (p_request.path_ == "/api/target")
    {
      Target(p_response, p_request.peer_, std::nullopt);
    }
    else if (p_request.path_ == "/api/watches")
    {
      const auto settings = target ? target->watches_ : watches_;
      if (!settings)
      {
        RespondJson(
            p_response, 503,
            JsonObject{{"error", "target watch settings limit reached"}});
        return;
      }
      RespondJson(p_response, 200, settings->Describe());
    }
    else
    {
      Respond(p_response, 404, "Not found", "text/plain");
    }
  }

  // The exact name that a Remove deletes from process_names: the target ID
  // without its ".N" suffix. Empty for a legacy target table. Error: a
  // Remove that would not stop this process, so it is refused.
  [[nodiscard]] static std::expected<std::string, std::string> RuleName(
      const PublishedTarget& p_target)
  {
    const auto flags = p_target.flags_;
    if ((flags &
         (target_wire::kNameSelected | target_wire::kOtherRuleSelected)) == 0)
    {
      return std::string{};
    }
    if ((flags & target_wire::kOtherRuleSelected) != 0)
    {
      return std::unexpected(
          "Another rule selects this process (a process pattern, or another "
          "name after a rename), so Remove would not stop it. Edit "
          "sampler.toml on the host.");
    }
    return std::string{target_wire::RuleName(p_target.id_, flags)};
  }

  void Target(httplib::Response& p_response, std::string_view p_peer,
              const std::optional<std::string>& p_target,
              bool p_multiple = false)
  {
    // Test control of the sampler on this host. Its configuration on disk
    // selects production targets; remote samplers are never changed here.
    if (!config_.network_target_control_ && !IsLoopback(p_peer))
    {
      RespondJson(p_response, p_target ? 403 : 200,
                  JsonObject{{"enabled", false},
                             {"error",
                              "Target changes from other hosts are off. Set "
                              "network_target_control = true in the collector "
                              "configuration to allow them (testing only; "
                              "there is no authentication)."}});
      return;
    }
    std::optional<std::string> request = p_target;
    // Take the sessions of the target being removed before the sampler
    // changes, so the removal cannot reach a session announced afterwards.
    std::vector<std::uint64_t> removed_sessions;
    if (p_multiple && p_target)
    {
      auto change = ParseJson(*p_target);
      const auto* action = change ? change->Find("action") : nullptr;
      const auto* id = change ? change->Find("id") : nullptr;
      if (action && action->IsString() && action->AsString() == "remove")
      {
        if (change->Find("check"))
        {
          RespondJson(p_response, 400,
                      JsonObject{{"error", "only an add can be checked"}});
          return;
        }
        const auto* key = change->Find("key");
        const auto target = key && key->IsString()
                                ? state_.Select(key->AsString())
                                : std::nullopt;
        if (!target || !target->local_)
        {
          RespondJson(p_response, 403,
                      JsonObject{{"error",
                                  "This target's sampler is not on the "
                                  "collector host. Edit sampler.toml on the "
                                  "monitored host."}});
          return;
        }
        if (!id || !id->IsString() || id->AsString() != target->id_)
        {
          RespondJson(p_response, 409,
                      JsonObject{{"error", "Target ID and key differ"}});
          return;
        }
        const auto rule = RuleName(*target);
        if (!rule)
        {
          RespondJson(p_response, 409, JsonObject{{"error", rule.error()}});
          return;
        }
        if (rule->empty() && id && id->IsString())
        {
          removed_sessions = state_.LocalSessionsForId(id->AsString());
        }
        else
        {
          const auto* requested_rule = change->Find("rule");
          if (!requested_rule || !requested_rule->IsString() ||
              requested_rule->AsString() != *rule)
          {
            RespondJson(
                p_response, 409,
                JsonObject{
                    {"error", "Target rule changed; reload the target list"}});
            return;
          }
          // Discovered targets: the sampler releases every instance of the
          // name itself, so only the rule changes.
          request = DumpJson(JsonObject{{"action", "remove"}, {"name", *rule}});
        }
      }
      // The collector drops targets beyond max_targets without a trace, so
      // refuse the add before the sampler configuration changes.
      if (action && action->IsString() && action->AsString() == "add" &&
          state_.TargetCount() >=
              static_cast<std::size_t>(config_.max_targets_))
      {
        RespondJson(
            p_response, 409,
            JsonObject{
                {"error", std::format("The collector is at its limit of {} "
                                      "targets. Remove a target, or raise "
                                      "max_targets in the collector "
                                      "configuration, then add this one.",
                                      config_.max_targets_)}});
        return;
      }
    }
    auto result = RunTargetControl(config_.udp_host_, config_.udp_port_,
                                   request, p_multiple, config_.max_targets_);
    if (!result)
    {
      RespondJson(p_response, 503, JsonObject{{"error", result.error()}});
      return;
    }
    // The helper counts configured targets under its lock, so it also refuses
    // an add that the published count above has not seen yet.
    if (result->Find("at_limit"))
    {
      RespondJson(p_response, 409, *result);
      return;
    }
    if (!removed_sessions.empty() && !result->Find("error"))
    {
      const auto change = ParseJson(*p_target);
      const auto* id = change ? change->Find("id") : nullptr;
      const auto* host = result->Find("host");
      if (id && id->IsString() && host && host->IsString())
      {
        if (!state_.QueueRemoval(host->AsString() + "/" + id->AsString(),
                                 std::move(removed_sessions)))
        {
          RespondJson(p_response, 503,
                      JsonObject{{"applied", true},
                                 {"error",
                                  "Sampler changed; collector target cleanup "
                                  "is busy. Reload the target list."}});
          return;
        }
      }
    }
    const auto* enabled = result->Find("enabled");
    const bool available =
        enabled != nullptr && enabled->IsBool() && enabled->AsBool();
    const int code = result->Find("error")    ? (p_target ? 400 : 200)
                     : p_target && !available ? 403
                                              : 200;
    RespondJson(p_response, code, *result);
  }

  // What a read of stored data uses for one target.
  struct StoredTarget
  {
    std::optional<TargetFilter> filter_;
    std::filesystem::path replay_root_;
    // Also read this target's frames in data_dir/replay: a "default" target
    // may have owned it. Frames of other targets there are skipped.
    bool merge_legacy_ = false;
    double replay_interval_s_ = 1;
  };

  // The selected published target; else, for a "host/id" key, a target with
  // stored data whose sampler has not registered since the collector started
  // (IsRecordedTarget). Legacy ownership can have moved between "default"
  // targets, so a recorded "default" target reads both replay roots.
  // nullopt: the key names no target.
  [[nodiscard]] std::optional<StoredTarget> StoredTargetFor(
      const Request& p_request)
  {
    const auto key = QueryValue(p_request.query_, "target");
    if (const auto target = state_.Select(key.value_or("")))
    {
      return StoredTarget{
          .filter_ = TargetFilter{target->host_, target->id_,
                                  target->id_ == "default" ? target->peer_ : "",
                                  target->legacy_replay_},
          .replay_root_ = target->replay_root_,
          .merge_legacy_ = target->legacy_replay_,
          .replay_interval_s_ = target->replay_interval_s_};
    }
    const std::filesystem::path data_dir{config_.data_dir_};
    if (!key)
    {
      return StoredTarget{.filter_ = std::nullopt,
                          .replay_root_ = data_dir,
                          .merge_legacy_ = false,
                          .replay_interval_s_ = config_.replay_interval_s_};
    }
    const auto slash = key->find('/');
    if (slash == std::string::npos)
    {
      return std::nullopt;
    }
    const std::string host{key->substr(0, slash)};
    const std::string id{key->substr(slash + 1)};
    if (!IsRecordedTarget(data_dir, host, id))
    {
      return std::nullopt;
    }
    return StoredTarget{
        .filter_ = TargetFilter{host, id, "", false},
        .replay_root_ = TargetDataRoot(data_dir, *key),
        .merge_legacy_ = id == "default",
        .replay_interval_s_ = ReplayInterval(config_, host, id)};
  }

  // Stored resource samples between start and end (default: the last 15
  // minutes), combined into at most about 1,000 buckets.
  void Resources(httplib::Response& p_response, const Request& p_request,
                 const StoredTarget& p_target)
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
      Respond(p_response, 400, R"({"error":"a valid time range is required"})",
              "application/json");
      return;
    }
    const double bucket = std::max(1.0, std::ceil((*end - *start) / 1000));
    auto history = collector::ResourceHistory(
        config_.data_dir_, *start, *end, bucket, 200'000, p_target.filter_);
    RespondJson(p_response, 200,
                JsonObject{{"rows", std::move(history.rows_)},
                           {"bucket_s", bucket},
                           {"truncated", history.truncated_},
                           {"read_error", history.read_error_}});
  }

  void Replay(httplib::Response& p_response, const Request& p_request,
              const StoredTarget& p_target)
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
      Respond(p_response, 400,
              R"({"error":"valid at timestamp and direction are required"})",
              "application/json");
      return;
    }
    auto replay = collector::Replay(p_target.replay_root_, {at, direction});
    if (p_target.merge_legacy_ &&
        p_target.replay_root_ != std::filesystem::path{config_.data_dir_})
    {
      const auto key = p_target.filter_->host_ + "/" + p_target.filter_->id_;
      replay = MergeReplay(
          std::move(replay),
          collector::Replay(config_.data_dir_, {at, direction, key}),
          direction);
    }
    // The stored view is sent as written; parsing and re-encoding a
    // multi-megabyte view would hold up every other dashboard request.
    Respond(
        p_response, 200,
        std::format(R"({{"first":{},"last":{},"interval_s":{},)"
                    R"("snapshot":{}}})",
                    DumpJson(Json(replay.first_)), DumpJson(Json(replay.last_)),
                    DumpJson(Json(p_target.replay_interval_s_)),
                    replay.snapshot_.value_or("null")),
        "application/json");
  }

  void History(httplib::Response& p_response, const Request& p_request,
               const StoredTarget& p_target)
  {
    const auto invalid = [&]
    {
      Respond(p_response, 400,
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
    auto rows = collector::History(
        config_.data_dir_, *session, tid, *start, *end, 2000,
        QueryValue(p_request.query_, "target") ? p_target.filter_
                                               : std::nullopt);
    const bool truncated = rows.size() == 2000;
    RespondJson(p_response, 200,
                JsonObject{{"rows", std::move(rows)},
                           {"limit", 2000},
                           {"truncated", truncated}});
  }
};

}  // namespace triangulator::collector
