#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/uio.h>

#include <array>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <vector>

#include "../common/fd.hpp"

// An application invokes this marker only after completing one message.
extern "C" __attribute__((noinline, visibility("default"))) void
TriangulatorMessageProcessed()
{
  asm volatile("" ::: "memory");
}

namespace
{
using triangulator::FileDescriptor;
void Require(bool p_condition)
{
  if (!p_condition)
  {
    std::perror("socket test target");
    std::exit(1);
  }
}
struct Pair
{
  FileDescriptor sender_;
  FileDescriptor receiver_;
};
Pair UnixPair(int p_type)
{
  int descriptors[2]{};
  Require(::socketpair(AF_UNIX, p_type, 0, descriptors) == 0);
  return {FileDescriptor{descriptors[0]}, FileDescriptor{descriptors[1]}};
}
Pair TcpPair(int p_family)
{
  FileDescriptor listener{::socket(p_family, SOCK_STREAM, 0)};
  Require(static_cast<bool>(listener));
  sockaddr_storage address{};
  socklen_t length = 0;
  if (p_family == AF_INET)
  {
    auto& ipv4 = reinterpret_cast<sockaddr_in&>(address);
    ipv4.sin_family = AF_INET;
    ipv4.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    length = sizeof(ipv4);
  }
  else
  {
    auto& ipv6 = reinterpret_cast<sockaddr_in6&>(address);
    ipv6.sin6_family = AF_INET6;
    ipv6.sin6_addr = in6addr_loopback;
    length = sizeof(ipv6);
  }
  Require(::bind(listener.Get(), reinterpret_cast<sockaddr*>(&address),
                 length) == 0);
  Require(::listen(listener.Get(), 1) == 0);
  Require(::getsockname(listener.Get(), reinterpret_cast<sockaddr*>(&address),
                        &length) == 0);
  FileDescriptor sender{::socket(p_family, SOCK_STREAM, 0)};
  Require(::connect(sender.Get(), reinterpret_cast<sockaddr*>(&address),
                    length) == 0);
  FileDescriptor receiver{::accept(listener.Get(), nullptr, nullptr)};
  Require(static_cast<bool>(receiver));
  return {std::move(sender), std::move(receiver)};
}
void Exercise(Pair& p_pair)
{
  const std::array<char, 8> bytes{'m', 'e', 's', 's', 'a', 'g', 'e', '!'};
  std::array<char, 8> received{};
  // read/write, vectored I/O, send/recv, message and batched APIs.
  Require(::write(p_pair.sender_.Get(), bytes.data(), bytes.size()) == 8);
  Require(::read(p_pair.receiver_.Get(), received.data(), received.size()) ==
          8);
  TriangulatorMessageProcessed();
  iovec outgoing{const_cast<char*>(bytes.data()), bytes.size()};
  iovec incoming{received.data(), received.size()};
  Require(::writev(p_pair.sender_.Get(), &outgoing, 1) == 8);
  Require(::readv(p_pair.receiver_.Get(), &incoming, 1) == 8);
  TriangulatorMessageProcessed();
  Require(::send(p_pair.sender_.Get(), bytes.data(), bytes.size(), 0) == 8);
  Require(::recv(p_pair.receiver_.Get(), received.data(), received.size(),
                 MSG_PEEK) == 8);
  Require(::recv(p_pair.receiver_.Get(), received.data(), received.size(), 0) ==
          8);
  TriangulatorMessageProcessed();
  Require(::recv(p_pair.receiver_.Get(), received.data(), received.size(),
                 MSG_DONTWAIT) == -1);
  msghdr send_message{};
  send_message.msg_iov = &outgoing;
  send_message.msg_iovlen = 1;
  msghdr receive_message{};
  receive_message.msg_iov = &incoming;
  receive_message.msg_iovlen = 1;
  Require(::sendmsg(p_pair.sender_.Get(), &send_message, 0) == 8);
  Require(::recvmsg(p_pair.receiver_.Get(), &receive_message, 0) == 8);
  TriangulatorMessageProcessed();
  std::array<mmsghdr, 2> messages{};
  for (auto& message : messages)
  {
    message.msg_hdr = send_message;
  }
  Require(::sendmmsg(p_pair.sender_.Get(), messages.data(), 2, 0) == 2);
  // Separate receiving calls avoid stream coalescing changing the byte total.
  for (auto& message : messages)
  {
    message.msg_hdr = receive_message;
    Require(::recvmmsg(p_pair.receiver_.Get(), &message, 1, 0, nullptr) == 1);
    Require(message.msg_len == 8);
    TriangulatorMessageProcessed();
  }
  // One final successful operation after the batched calls.
  Require(::send(p_pair.sender_.Get(), bytes.data(), bytes.size(), 0) == 8);
  Require(::recv(p_pair.receiver_.Get(), received.data(), received.size(), 0) ==
          8);
  TriangulatorMessageProcessed();
}
}  // namespace
int main()
{
  // Create the worker before allowing the harness to attach the marker.
  auto shared_pair = UnixPair(SOCK_STREAM);
  std::atomic<bool> run = false;
  std::thread worker{[&]
                     {
                       while (!run.load())
                       {
                         std::this_thread::yield();
                       }
                       auto pair = UnixPair(SOCK_STREAM);
                       Exercise(pair);
                     }};
  std::puts("ready");
  std::fflush(stdout);
  Require(std::getchar() == 's');
  for (const int family : {AF_INET, AF_INET6})
  {
    auto pair = TcpPair(family);
    Exercise(pair);
  }
  for (const int type : {SOCK_STREAM, SOCK_DGRAM, SOCK_SEQPACKET})
  {
    auto pair = UnixPair(type);
    Exercise(pair);
  }
  run = true;
  worker.join();
  // Datagram zero-length messages count as operations, not bytes. A truncated
  // receive reports the copied bytes; the rest is outside this metric.
  auto datagram = UnixPair(SOCK_DGRAM);
  Require(::send(datagram.sender_.Get(), "", 0, 0) == 0);
  std::array<char, 4> buffer{};
  Require(::recv(datagram.receiver_.Get(), buffer.data(), buffer.size(), 0) ==
          0);
  Require(::send(datagram.sender_.Get(), "abcdefgh", 8, 0) == 8);
  Require(::recv(datagram.receiver_.Get(), buffer.data(), buffer.size(), 0) ==
          4);
  // UDP must not contribute.
  // Unix is already exercised; IPv4 UDP uses loopback bind/sendto.
  FileDescriptor udp_receiver{::socket(AF_INET, SOCK_DGRAM, 0)};
  FileDescriptor udp_sender{::socket(AF_INET, SOCK_DGRAM, 0)};
  sockaddr_in address{.sin_family = AF_INET,
                      .sin_port = 0,
                      .sin_addr = {htonl(INADDR_LOOPBACK)},
                      .sin_zero = {}};
  Require(::bind(udp_receiver.Get(), reinterpret_cast<sockaddr*>(&address),
                 sizeof(address)) == 0);
  socklen_t length = sizeof(address);
  Require(::getsockname(udp_receiver.Get(),
                        reinterpret_cast<sockaddr*>(&address), &length) == 0);
  Require(::sendto(udp_sender.Get(), "excluded", 8, 0,
                   reinterpret_cast<sockaddr*>(&address), length) == 8);
  Require(::recv(udp_receiver.Get(), buffer.data(), buffer.size(), 0) == 4);
  // Nonblocking partial sends contribute only the accepted byte count.
  auto partial = UnixPair(SOCK_STREAM);
  const int send_buffer = 4096;
  Require(::setsockopt(partial.sender_.Get(), SOL_SOCKET, SO_SNDBUF,
                       &send_buffer, sizeof(send_buffer)) == 0);
  std::vector<char> payload(1024 * 1024, 'x');
  const auto accepted = ::send(partial.sender_.Get(), payload.data(),
                               payload.size(), MSG_DONTWAIT);
  Require(accepted > 0 && static_cast<std::size_t>(accepted) < payload.size());
  Require(::send(partial.sender_.Get(), payload.data(), payload.size(),
                 MSG_DONTWAIT) == -1);
  Require(::recv(partial.receiver_.Get(), payload.data(),
                 static_cast<std::size_t>(accepted), MSG_WAITALL) == accepted);
  std::printf("done %zd\n", accepted);
  std::fflush(stdout);
  // Remain alive so the harness can ask for a final, stable snapshot.
  Require(std::getchar() == 'q');
}
