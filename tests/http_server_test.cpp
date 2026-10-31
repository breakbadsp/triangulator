// Real-socket tests for collector/http_server.hpp: the limits and policies
// that the collector sets on cpp-httplib. Each test starts a server on a free
// loopback port and talks raw HTTP to it, so the bytes on the wire are known.

#include "../collector/http_server.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <exception>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include "../common/fd.hpp"

namespace
{

using namespace triangulator;
using namespace triangulator::collector;
using Clock = std::chrono::steady_clock;

void Require(bool p_condition, std::string_view p_message)
{
  if (!p_condition)
  {
    throw std::runtime_error(std::string{p_message});
  }
}

sockaddr_in Loopback(std::uint16_t p_port)
{
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(p_port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  return address;
}

std::uint16_t FreePort()
{
  const FileDescriptor socket{::socket(AF_INET, SOCK_STREAM, 0)};
  auto address = Loopback(0);
  socklen_t length = sizeof(address);
  Require(::bind(socket.Get(), reinterpret_cast<const sockaddr*>(&address),
                 sizeof(address)) == 0 &&
              ::getsockname(socket.Get(), reinterpret_cast<sockaddr*>(&address),
                            &length) == 0,
          "no free port");
  return ntohs(address.sin_port);
}

FileDescriptor Connect(std::uint16_t p_port)
{
  FileDescriptor socket{::socket(AF_INET, SOCK_STREAM, 0)};
  const auto address = Loopback(p_port);
  Require(::connect(socket.Get(), reinterpret_cast<const sockaddr*>(&address),
                    sizeof(address)) == 0,
          "cannot connect");
  return socket;
}

void Send(const FileDescriptor& p_socket, std::string_view p_text)
{
  while (!p_text.empty())
  {
    const auto count =
        ::send(p_socket.Get(), p_text.data(), p_text.size(), MSG_NOSIGNAL);
    if (count <= 0)
    {
      return;
    }
    p_text.remove_prefix(static_cast<std::size_t>(count));
  }
}

// Everything the server sends until it closes, or until p_timeout.
struct Reply
{
  std::string text_;
  bool closed_ = false;
};

Reply Read(const FileDescriptor& p_socket,
           std::chrono::milliseconds p_timeout = std::chrono::seconds{3})
{
  Reply reply;
  const auto deadline = Clock::now() + p_timeout;
  std::array<char, 4096> buffer{};
  while (Clock::now() < deadline)
  {
    pollfd ready{p_socket.Get(), POLLIN, 0};
    if (::poll(&ready, 1, 20) <= 0)
    {
      continue;
    }
    const auto count = ::recv(p_socket.Get(), buffer.data(), buffer.size(), 0);
    if (count <= 0)
    {
      reply.closed_ = true;
      break;
    }
    reply.text_.append(buffer.data(), static_cast<std::size_t>(count));
  }
  return reply;
}

Reply Exchange(std::uint16_t p_port, std::string_view p_request)
{
  const auto socket = Connect(p_port);
  Send(socket, p_request);
  return Read(socket);
}

bool HasStatus(const Reply& p_reply, int p_status)
{
  return p_reply.text_.starts_with(std::format("HTTP/1.1 {} ", p_status));
}

bool HasPolicyHeaders(const Reply& p_reply)
{
  return p_reply.text_.contains("\r\nCache-Control: no-store\r\n") &&
         p_reply.text_.contains("\r\nX-Content-Type-Options: nosniff\r\n") &&
         p_reply.text_.contains(std::format(
             "\r\nContent-Security-Policy: {}\r\n", kContentSecurityPolicy));
}

std::string_view Body(const Reply& p_reply)
{
  const auto end = p_reply.text_.find("\r\n\r\n");
  return end == std::string::npos
             ? std::string_view{}
             : std::string_view{p_reply.text_}.substr(end + 4);
}

// State of the /paced response, for TestTotalWriteDeadline.
std::atomic<std::int64_t> g_paced_start_ms{0};
std::atomic<std::int64_t> g_paced_failed_ms{0};

std::int64_t NowMs()
{
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             Clock::now().time_since_epoch())
      .count();
}

// 4 s of small chunks, so the write budget starts early. Then 8 MiB chunks,
// which fill the socket buffers when the client stops reading. The time of the
// first failed chunk write is recorded.
void ServePaced(httplib::Response& p_response)
{
  g_paced_start_ms = NowMs();
  g_paced_failed_ms = 0;
  constexpr std::size_t kTotal = 64U << 20;
  p_response.set_content_provider(
      kTotal, "text/plain",
      [](std::size_t, std::size_t, httplib::DataSink& p_sink)
      {
        const bool early = NowMs() - g_paced_start_ms < 4000;
        if (early)
        {
          std::this_thread::sleep_for(std::chrono::milliseconds{100});
        }
        static const std::string kChunk(8U << 20, 'z');
        if (!p_sink.write(kChunk.data(), early ? 65536 : kChunk.size()))
        {
          g_paced_failed_ms = NowMs();
          return false;
        }
        return true;
      });
}

// A server whose handler answers with what it saw.
class TestServer
{
 public:
  TestServer()
      : port_(FreePort()),
        server_(
            [](const httplib::Request& p_request, httplib::Response& p_response)
            {
              if (p_request.target == "/paced")
              {
                ServePaced(p_response);
                return;
              }
              p_response.set_content(
                  std::format("{} {} peer={} body={}", p_request.method,
                              p_request.target, p_request.remote_addr,
                              p_request.body.size()),
                  "text/plain");
            })
  {
    auto bound = server_.Bind("127.0.0.1", port_);
    Require(bound.has_value(), bound ? "" : bound.error());
    Require(server_.Start().has_value(), "cannot start");
  }
  [[nodiscard]] std::uint16_t Port() const
  {
    return port_;
  }
  HttpServer& Server()
  {
    return server_;
  }

 private:
  std::uint16_t port_;
  HttpServer server_;
};

// A GET request whose head is exactly p_bytes long on the wire.
// Filler field values use p_fill and stay under the library's
// 8,192-byte line limit.
std::string HeadOfSize(
    std::size_t p_bytes, char p_fill,
    std::string_view p_start = "GET /head HTTP/1.1\r\nHost: test\r\n")
{
  std::string head{p_start};
  constexpr std::size_t kLine = 8000;
  for (int index = 0; head.size() + 2 < p_bytes; ++index)
  {
    const auto name = std::format("X-Fill-{}: v", index);
    const auto left = p_bytes - 2 - head.size();
    // The last line takes the rest; a remainder too small for a
    // line is spread into this one.
    const auto size = left < kLine + name.size() + 3 ? left : kLine;
    head += name;
    head.append(size - name.size() - 2, p_fill);
    head += "\r\n";
  }
  head += "\r\n";
  Require(head.size() == p_bytes, "head size");
  return head;
}

// A client that sends 1 byte each 200 ms, much faster than the read
// timeout, must still be closed within 6 s of connecting, for
// headers and for a body.
void TestTotalReadDeadline()
{
  TestServer server;
  auto slow = [&server](std::string_view p_prefix)
  {
    const auto started = Clock::now();
    const auto socket = Connect(server.Port());
    Send(socket, p_prefix);
    while (Clock::now() - started < std::chrono::seconds{8})
    {
      pollfd ready{socket.Get(), POLLIN, 0};
      if (::poll(&ready, 1, 200) > 0)
      {
        static_cast<void>(Read(socket));
        return Clock::now() - started;
      }
      Send(socket, "x");
    }
    return Clock::now() - started;
  };
  Clock::duration headers{};
  Clock::duration body{};
  {
    const std::jthread header_client{
        [&]
        {
          headers = slow("GET / HTTP/1.1\r\nHost: t\r\nX-Slow: ");
        }};
    const std::jthread body_client{
        [&]
        {
          body = slow(
              "POST / HTTP/1.1\r\nHost: t\r\nContent-Length: "
              "100\r\n\r\n");
        }};
  }
  Require(headers < std::chrono::seconds{6}, "slow headers outlive 6 s");
  Require(body < std::chrono::seconds{6}, "slow body outlives 6 s");
  Require(headers > std::chrono::seconds{4}, "slow headers closed early");
  Require(body > std::chrono::seconds{4}, "slow body closed early");
}

// 64 idle connections take every worker. The next one gets an
// immediate 503 with the policy headers and is closed; after the 64
// close, requests work.
void TestConnectionLimit()
{
  TestServer server;
  {
    std::vector<FileDescriptor> idle;
    for (std::size_t index = 0; index < kMaxConnections; ++index)
    {
      idle.push_back(Connect(server.Port()));
    }
    const auto started = Clock::now();
    const auto extra = Connect(server.Port());
    Send(extra, "GET / HTTP/1.1\r\nHost: t\r\n\r\n");
    const auto refused = Read(extra, std::chrono::seconds{1});
    Require(HasStatus(refused, 503), "no 503 when every slot is busy");
    Require(HasPolicyHeaders(refused), "503 without policy headers");
    Require(refused.closed_ && Clock::now() - started < std::chrono::seconds{1},
            "refused connection not closed within 1 s");
  }
  const auto deadline = Clock::now() + std::chrono::seconds{2};
  while (!HasStatus(
      Exchange(server.Port(), "GET / HTTP/1.1\r\nHost: t\r\n\r\n"), 200))
  {
    Require(Clock::now() < deadline, "slots not released");
  }
}

// The head limit counts wire bytes, so whitespace that the parser
// would trim still counts. The body limit answers 413.
void TestHeadAndBodyLimits()
{
  const TestServer server;
  Require(
      HasStatus(Exchange(server.Port(), HeadOfSize(kMaxRequestHeadBytes, 'a')),
                200),
      "head at the limit rejected");
  Require(
      HasStatus(Exchange(server.Port(), HeadOfSize(kMaxRequestHeadBytes, ' ')),
                200),
      "space-padded head at the limit rejected");
  for (const char fill : {'a', ' '})
  {
    for (const auto size : {kMaxRequestHeadBytes + 1, std::size_t{70000}})
    {
      const auto reply = Exchange(server.Port(), HeadOfSize(size, fill));
      Require(!reply.text_.contains(" 200 "), "head over the limit accepted");
      Require(reply.text_.empty() || HasStatus(reply, 400),
              "head over the limit: not 400 or close");
    }
  }
  // The body after a head at the limit is not counted as head.
  const auto with_body = HeadOfSize(kMaxRequestHeadBytes, 'a',
                                    "POST /head HTTP/1.1\r\nHost: "
                                    "t\r\nContent-Length: 10\r\n") +
                         "0123456789";
  Require(Body(Exchange(server.Port(), with_body)) ==
              "POST /head peer=127.0.0.1 body=10",
          "body after a head at the limit rejected");
  auto post = [](std::size_t p_bytes)
  {
    return std::format(
        "POST / HTTP/1.1\r\nHost: t\r\nContent-Length: "
        "{}\r\n\r\n{}",
        p_bytes, std::string(p_bytes, 'b'));
  };
  const TestServer body_server;
  const auto accepted =
      Exchange(body_server.Port(), post(kMaxRequestBodyBytes));
  Require(Body(accepted) == std::format("POST / peer=127.0.0.1 body={}",
                                        kMaxRequestBodyBytes),
          "body at the limit rejected");
  Require(
      HasStatus(Exchange(body_server.Port(), post(kMaxRequestBodyBytes + 1)),
                413),
      "body over the limit not 413");
}

// A form-urlencoded body is held to the same 16 KiB limit as any
// other body, and Expect: 100-continue gets no interim response.
void TestFormBodyAndExpect()
{
  const TestServer server;
  auto post = [](std::size_t p_bytes, std::string_view p_extra)
  {
    return std::format(
        "POST / HTTP/1.1\r\nHost: t\r\nContent-Type: "
        "application/x-www-form-urlencoded\r\n{}Content-Length: "
        "{}\r\n\r\n{}",
        p_extra, p_bytes, std::string(p_bytes, ' '));
  };
  Require(Body(Exchange(server.Port(), post(9000, ""))) ==
              "POST / peer=127.0.0.1 body=9000",
          "form body of 9000 bytes rejected");
  Require(HasStatus(Exchange(server.Port(), post(kMaxRequestBodyBytes + 1, "")),
                    413),
          "form body over the limit not 413");
  const auto reply =
      Exchange(server.Port(), post(10, "Expect: 100-continue\r\n"));
  Require(HasStatus(reply, 200) && !reply.text_.contains("100 Continue"),
          "Expect: 100-continue got an interim response");
}

// The 5 s write budget is one total deadline. A client reads for 4
// s, then stops. The 8 MiB chunk written at 4 s must fail at 5 s,
// not wait for its own 5 s socket timeout. The server then stops
// promptly.
void TestTotalWriteDeadline()
{
  TestServer server;
  const auto socket = Connect(server.Port());
  Send(socket, "GET /paced HTTP/1.1\r\nHost: t\r\n\r\n");
  const auto started = Clock::now();
  std::array<char, 65536> buffer{};
  while (Clock::now() - started < std::chrono::seconds{4})
  {
    pollfd ready{socket.Get(), POLLIN, 0};
    if (::poll(&ready, 1, 50) > 0)
    {
      static_cast<void>(::recv(socket.Get(), buffer.data(), buffer.size(), 0));
    }
  }
  std::this_thread::sleep_for(std::chrono::milliseconds{3500});
  const auto failed = g_paced_failed_ms.load();
  Require(failed != 0, "stalled write not abandoned within 7.5 s");
  Require(failed - g_paced_start_ms.load() < 6000,
          "stalled write outlives the write budget");
  const auto stop_started = Clock::now();
  server.Server().Stop();
  Require(Clock::now() - stop_started < std::chrono::seconds{1},
          "stop took 1 s or more");
}

// Responses that the library writes itself carry the same policy
// headers as handler responses.
void TestPolicyHeaders()
{
  const TestServer server;
  struct Case
  {
    std::string request_;
    int status_;
  };
  const std::vector<Case> cases{
      {"GET / HTTP/1.1\r\nHost: t\r\n\r\n", 200},
      {"GET / HTTP/1.1\r\nHost: t\r\nNo colon\r\n\r\n", 400},
      {"POST / HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: "
       "chunked\r\n\r\n0\r\n\r\n",
       400},
      {"GET / HTTP/1.1\r\nHost: t\r\nRange: bytes=abc\r\n\r\n", 416},
      {std::format("GET /{} HTTP/1.1\r\nHost: t\r\n\r\n",
                   std::string(9000, 'p')),
       414},
      {"POST / HTTP/1.1\r\nHost: t\r\nContent-Length: "
       "20000\r\n\r\n",
       413},
  };
  for (const auto& test : cases)
  {
    const auto reply = Exchange(server.Port(), test.request_);
    Require(HasStatus(reply, test.status_),
            std::format("expected {}: {}", test.status_,
                        reply.text_.substr(0, 40)));
    Require(HasPolicyHeaders(reply),
            std::format("{} without policy headers", test.status_));
  }
}

// A valid but unsatisfiable range is ignored, as before the
// library: the handler's full 200 response is sent.
void TestRangeIgnored()
{
  const TestServer server;
  const auto reply = Exchange(server.Port(),
                              "GET /r HTTP/1.1\r\nHost: t\r\nRange: "
                              "bytes=9223372036854775806-\r\n\r\n");
  Require(HasStatus(reply, 200), "unsatisfiable range not ignored");
  Require(Body(reply) == "GET /r peer=127.0.0.1 body=0", "range body");
}

// The handler sees the socket peer and the raw target, whatever
// forwarding headers say.
void TestPeerAndTarget()
{
  const TestServer server;
  const auto reply =
      Exchange(server.Port(),
               "GET /api/x?a=%41+b&a=2 HTTP/1.1\r\nHost: "
               "t\r\nX-Forwarded-For: "
               "10.1.2.3\r\n"
               "X-Real-IP: 10.1.2.3\r\nForwarded: for=10.1.2.3\r\n\r\n");
  Require(Body(reply) == "GET /api/x?a=%41+b&a=2 peer=127.0.0.1 body=0",
          std::format("peer or target changed: {}", Body(reply)));
}

// Stop returns within 1 s while clients hold idle and incomplete
// requests, and every connection is closed by then.
void TestPromptStop()
{
  TestServer server;
  std::vector<FileDescriptor> clients;
  for (int index = 0; index < 20; ++index)
  {
    clients.push_back(Connect(server.Port()));
    if (index % 3 == 1)
    {
      Send(clients.back(), "GET / HTTP/1.1\r\nHost: t\r\nX-Partial: ");
    }
    if (index % 3 == 2)
    {
      Send(clients.back(),
           "POST / HTTP/1.1\r\nHost: t\r\nContent-Length: "
           "9\r\n\r\nab");
    }
  }
  std::this_thread::sleep_for(std::chrono::milliseconds{200});
  const auto started = Clock::now();
  server.Server().Stop();
  Require(Clock::now() - started < std::chrono::seconds{1},
          "stop took 1 s or more");
  for (const auto& client : clients)
  {
    Require(Read(client, std::chrono::milliseconds{200}).closed_,
            "connection open after stop");
  }
}

// A second server on the same port must fail with the bind error,
// which the library default (SO_REUSEPORT) would allow.
void TestBindConflict()
{
  const TestServer server;
  HttpServer second{[](const httplib::Request&, httplib::Response&)
                    {
                    }};
  const auto bound = second.Bind("127.0.0.1", server.Port());
  Require(!bound, "second server bound a port in use");
  Require(
      bound.error() == std::format("bind 127.0.0.1:{}: Address already in use",
                                   server.Port()),
      bound.error());
}

}  // namespace

int main()
{
  try
  {
    TestBindConflict();
    TestPolicyHeaders();
    TestRangeIgnored();
    TestPeerAndTarget();
    TestHeadAndBodyLimits();
    TestConnectionLimit();
    TestPromptStop();
    TestTotalReadDeadline();
    TestFormBodyAndExpect();
    TestTotalWriteDeadline();
    std::puts(
        "HTTP server tests passed (bind, policy headers, range, "
        "peer, head "
        "and body limits, connection limit, stop, read deadline, "
        "form body, "
        "Expect, write deadline)");
  }
  catch (const std::exception& error)
  {
    std::fprintf(stderr, "%s\n", error.what());
    return 1;
  }
}
