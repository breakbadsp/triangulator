#pragma once

// Resource samples: reassembles the sampler's TRES datagrams, turns
// cumulative counters into rates over the interval since the previous
// sample, keeps the latest sample for the live view and produces one
// resource_sample row per sample. Like Monitor, it does no I/O: rows wait in
// PendingRows() until the caller writes them. It evaluates no alert rules.

#include <arpa/inet.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <format>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "../common/resource_wire.hpp"
#include "json.hpp"
#include "storage.hpp"

namespace triangulator::collector
{

using resource_wire::Field;

// ss-style names for Linux TCP_* states, which unix and UDP sockets share.
// UDP and unbound unix sockets report CLOSE, shown as UNCONN like ss does.
[[nodiscard]] inline std::string_view SocketStateName(std::uint8_t p_state)
{
  constexpr std::array<std::string_view, 13> kNames{
      "?",          "ESTAB",     "SYN-SENT",    "SYN-RECV",   "FIN-WAIT-1",
      "FIN-WAIT-2", "TIME-WAIT", "UNCONN",      "CLOSE-WAIT", "LAST-ACK",
      "LISTEN",     "CLOSING",   "NEW-SYN-RECV"};
  return p_state < kNames.size() ? kNames[p_state] : "?";
}

[[nodiscard]] inline std::string_view SocketKindName(
    resource_wire::SocketKind p_kind)
{
  constexpr std::array<std::string_view, 8> kNames{
      "?",    "tcp4",        "tcp6",       "udp4",
      "udp6", "unix_stream", "unix_dgram", "unix_seqpacket"};
  const auto index = std::to_underlying(p_kind);
  return index < kNames.size() ? kNames[index] : "?";
}

// "10.0.0.1:443" or "[::1]:443"; an IPv4-mapped IPv6 address shows as IPv4.
[[nodiscard]] inline std::string FormatEndpoint(
    resource_wire::SocketKind p_kind,
    const std::array<std::uint8_t, 16>& p_address, std::uint16_t p_port)
{
  std::array<char, INET6_ADDRSTRLEN> text{};
  const bool ipv6 = p_kind == resource_wire::SocketKind::Tcp6 ||
                    p_kind == resource_wire::SocketKind::Udp6;
  constexpr std::array<std::uint8_t, 12> kMapped{0, 0, 0, 0, 0,    0,
                                                 0, 0, 0, 0, 0xff, 0xff};
  const bool mapped =
      ipv6 && std::equal(kMapped.begin(), kMapped.end(), p_address.begin());
  if (!ipv6 || mapped)
  {
    ::inet_ntop(AF_INET, p_address.data() + (mapped ? 12 : 0), text.data(),
                static_cast<socklen_t>(text.size()));
    return std::format("{}:{}", text.data(), p_port);
  }
  ::inet_ntop(AF_INET6, p_address.data(), text.data(),
              static_cast<socklen_t>(text.size()));
  return std::format("[{}]:{}", text.data(), p_port);
}

// Percentage p_part of p_whole, or nullopt when p_whole is zero.
[[nodiscard]] inline std::optional<double> Percent(double p_part,
                                                   double p_whole)
{
  if (p_whole <= 0)
  {
    return std::nullopt;
  }
  return p_part / p_whole * 100;
}

// How full a socket's receive buffer, send buffer or (listeners) accept
// backlog is, in percent.
struct SocketFill
{
  std::optional<double> receive_;
  std::optional<double> send_;
  std::optional<double> accept_;
};

[[nodiscard]] inline SocketFill Fill(const resource_wire::Socket& p_socket)
{
  SocketFill fill;
  if (p_socket.state_ == 10)  // LISTEN: rx/tx queue are pending/backlog
  {
    fill.accept_ = Percent(p_socket.rx_queue_, p_socket.tx_queue_);
    return fill;
  }
  if (!resource_wire::HasFlag(p_socket.flags_,
                              resource_wire::SocketFlags::Memory))
  {
    return fill;
  }
  fill.receive_ = Percent(p_socket.rmem_alloc_, p_socket.rcvbuf_);
  fill.send_ = Percent(std::max(p_socket.wmem_queued_, p_socket.wmem_alloc_),
                       p_socket.sndbuf_);
  return fill;
}

// A sample with every part that arrived. The sockets list is partial when
// a socket part was lost (sockets_complete_ false).
struct ResourceSample
{
  resource_wire::Header header_;
  resource_wire::SummaryValues values_{};
  std::string cgroup_;
  std::vector<resource_wire::Socket> sockets_;
  bool sockets_complete_ = true;
  double received_{};
  double wall_{};
  double monotonic_{};
};

class ResourceMonitor
{
 public:
  // Grace for the parts of one sample to arrive before it is used anyway.
  static constexpr double kGraceSeconds = 2;
  static constexpr std::size_t kMaxPending = 8;
  // Sockets stored per row: the fullest, and only those with something to
  // show, so an idle process stores almost nothing.
  static constexpr std::size_t kStoredSockets = 8;

  std::int64_t bad_parts_ = 0;

  void Accept(resource_wire::Part p_part, double p_received)
  {
    const auto& header = p_part.header_;
    const Key key{header.session_, header.sequence_};
    if (latest_ && latest_->header_.session_ == header.session_ &&
        header.sequence_ <= latest_->header_.sequence_)
    {
      ++late_;
      return;
    }
    auto found = pending_.find(key);
    if (found == pending_.end())
    {
      if (pending_.size() >= kMaxPending)
      {
        Finish(pending_.begin());
      }
      Assembly assembly;
      assembly.header_ = header;
      assembly.received_ = p_received;
      found = pending_.emplace(key, std::move(assembly)).first;
    }
    auto& assembly = found->second;
    if (!header.SameSample(assembly.header_))
    {
      ++bad_parts_;
      return;
    }
    if (header.kind_ == resource_wire::PartKind::Summary)
    {
      if (assembly.summary_)
      {
        return;  // duplicate
      }
      assembly.summary_ = p_part.values_;
      assembly.cgroup_ = std::string{p_part.cgroup_.data()};
    }
    else if (!assembly.sockets_
                  .emplace(header.part_, std::move(p_part.sockets_))
                  .second)
    {
      return;  // duplicate
    }
    if (assembly.summary_ &&
        assembly.sockets_.size() + 1 == assembly.header_.parts_)
    {
      Finish(found);
    }
  }

  // Uses samples whose parts have had time to arrive (all when p_force),
  // in sequence order.
  void Drain(double p_now, bool p_force = false)
  {
    for (auto iterator = pending_.begin(); iterator != pending_.end();)
    {
      const auto next = std::next(iterator);
      if (p_force || p_now - iterator->second.received_ >= kGraceSeconds)
      {
        Finish(iterator);
      }
      iterator = next;
    }
  }

  // The latest sample for /api/live, with rates over its interval.
  [[nodiscard]] Json Snapshot(double p_now) const
  {
    if (!latest_)
    {
      return JsonObject{
          {"available", false},
          {"reason",
           "No resource samples yet. The sampler sends one every "
           "resource_interval_s seconds (default 5) while the target "
           "runs."},
          {"stats", Stats()}};
    }
    const auto& sample = *latest_;
    const auto interval = sample.header_.interval_ms_ / 1000.0;
    Json result = SampleJson(sample, Previous());
    result.Set("available", true);
    result.Set("stale",
               p_now - sample.received_ > std::max(15.0, 3 * interval));
    result.Set("updated", sample.received_);
    result.Set("stats", Stats());
    return result;
  }

  [[nodiscard]] const std::vector<ResourceRow>& PendingRows() const noexcept
  {
    return rows_;
  }
  void ClearRows() noexcept
  {
    rows_.clear();
  }

 private:
  using Key = std::pair<std::uint64_t, std::uint32_t>;
  struct Assembly
  {
    resource_wire::Header header_;
    double received_{};
    std::optional<resource_wire::SummaryValues> summary_;
    std::string cgroup_;
    std::map<std::uint8_t, std::vector<resource_wire::Socket>> sockets_;
  };

  std::map<Key, Assembly> pending_;
  std::optional<ResourceSample> latest_;
  std::optional<ResourceSample> previous_;
  std::vector<ResourceRow> rows_;
  std::int64_t samples_ = 0;
  std::int64_t incomplete_ = 0;
  std::int64_t late_ = 0;

  [[nodiscard]] Json Stats() const
  {
    return JsonObject{{"samples", samples_},
                      {"incomplete", incomplete_},
                      {"late", late_},
                      {"bad_parts", bad_parts_}};
  }

  // The previous sample when rates over the interval to the latest one are
  // meaningful: same session and process, and not too long ago.
  [[nodiscard]] const ResourceSample* Previous() const
  {
    if (!latest_ || !previous_)
    {
      return nullptr;
    }
    const auto& now = latest_->header_;
    const auto& before = previous_->header_;
    const double elapsed = latest_->monotonic_ - previous_->monotonic_;
    if (now.session_ != before.session_ || now.pid_ != before.pid_ ||
        now.process_start_ != before.process_start_ || elapsed <= 0 ||
        elapsed > 3 * now.interval_ms_ / 1000.0)
    {
      return nullptr;
    }
    return &*previous_;
  }

  void Finish(std::map<Key, Assembly>::iterator p_found)
  {
    auto assembly = std::move(p_found->second);
    pending_.erase(p_found);
    if (!assembly.summary_)
    {
      ++incomplete_;
      return;
    }
    if (latest_ && latest_->header_.session_ == assembly.header_.session_ &&
        assembly.header_.sequence_ <= latest_->header_.sequence_)
    {
      ++late_;
      return;
    }
    ResourceSample sample;
    sample.header_ = assembly.header_;
    sample.values_ = *assembly.summary_;
    sample.cgroup_ = std::move(assembly.cgroup_);
    sample.sockets_complete_ =
        assembly.sockets_.size() + 1 == assembly.header_.parts_;
    for (auto& [part, sockets] : assembly.sockets_)
    {
      std::ranges::move(sockets, std::back_inserter(sample.sockets_));
    }
    sample.received_ = assembly.received_;
    sample.monotonic_ = static_cast<double>(sample.header_.monotonic_ns_) / 1e9;
    sample.wall_ = static_cast<double>(sample.header_.wall_ns_) / 1e9;
    if (std::fabs(sample.wall_ - sample.received_) > 86400)
    {
      sample.wall_ = sample.received_;
    }
    incomplete_ += sample.sockets_complete_ ? 0 : 1;
    ++samples_;
    previous_ = std::move(latest_);
    latest_ = std::move(sample);
    rows_.push_back(Row(*latest_, Previous()));
  }

  [[nodiscard]] static std::optional<std::uint64_t> Value(
      const ResourceSample& p_sample, std::size_t p_field)
  {
    const auto value = p_sample.values_[p_field];
    if (value == resource_wire::kUnavailable)
    {
      return std::nullopt;
    }
    return value;
  }

  // How much a cumulative counter grew since p_previous, or nullopt when
  // either value is missing or it went backwards (a reset).
  [[nodiscard]] static std::optional<std::uint64_t> Growth(
      const ResourceSample& p_sample, const ResourceSample* p_previous,
      std::size_t p_field)
  {
    if (p_previous == nullptr)
    {
      return std::nullopt;
    }
    const auto now = Value(p_sample, p_field);
    const auto before = Value(*p_previous, p_field);
    if (!now || !before || *now < *before)
    {
      return std::nullopt;
    }
    return *now - *before;
  }

  [[nodiscard]] static double Elapsed(const ResourceSample& p_sample,
                                      const ResourceSample& p_previous)
  {
    return p_sample.monotonic_ - p_previous.monotonic_;
  }

  [[nodiscard]] static std::optional<double> Rate(
      const ResourceSample& p_sample, const ResourceSample* p_previous,
      std::size_t p_field)
  {
    const auto growth = Growth(p_sample, p_previous, p_field);
    if (!growth)
    {
      return std::nullopt;
    }
    return static_cast<double>(*growth) / Elapsed(p_sample, *p_previous);
  }

  // Share of the cgroup's CPU periods in the interval in which it was
  // throttled, or nullopt when no period elapsed or a counter is missing.
  [[nodiscard]] static std::optional<double> ThrottledPercent(
      const ResourceSample& p_sample, const ResourceSample* p_previous)
  {
    const auto periods =
        Growth(p_sample, p_previous, Field("cgroup_cpu_nr_periods"));
    const auto throttled =
        Growth(p_sample, p_previous, Field("cgroup_cpu_nr_throttled"));
    if (!periods || !throttled || *periods == 0)
    {
      return std::nullopt;
    }
    return std::min(100.0, static_cast<double>(*throttled) /
                               static_cast<double>(*periods) * 100);
  }

  // Share of the interval that tasks were stalled, from a PSI total (µs).
  [[nodiscard]] static std::optional<double> StallPercent(
      const ResourceSample& p_sample, const ResourceSample* p_previous,
      std::size_t p_total)
  {
    const auto rate = Rate(p_sample, p_previous, p_total);
    if (!rate)
    {
      return std::nullopt;
    }
    return std::clamp(*rate / 1e4, 0.0, 100.0);
  }

  [[nodiscard]] static Json Number(std::optional<std::uint64_t> p_value)
  {
    return p_value ? Json(*p_value) : Json{};
  }

  [[nodiscard]] static Json PressureJson(const ResourceSample& p_sample,
                                         const ResourceSample* p_previous,
                                         std::size_t p_first)
  {
    Json result{JsonObject{}};
    constexpr std::array<std::string_view, 3> kResources{"cpu", "memory", "io"};
    for (std::size_t index = 0; index < kResources.size(); ++index)
    {
      const auto first = p_first + index * 4;
      Json resource{JsonObject{}};
      for (const auto& [name, offset] : {std::pair{"some", std::size_t{0}},
                                         std::pair{"full", std::size_t{2}}})
      {
        const auto avg10 = Value(p_sample, first + offset);
        resource.Set(
            name,
            JsonObject{
                {"avg10",
                 avg10 ? Json(static_cast<double>(*avg10) / 100) : Json{}},
                {"pct",
                 Json(StallPercent(p_sample, p_previous, first + offset + 1))},
                {"total_us", Number(Value(p_sample, first + offset + 1))}});
      }
      result.Set(kResources[index], std::move(resource));
    }
    return result;
  }

  // One socket for the live view; p_previous gives per-socket growth.
  [[nodiscard]] static Json SocketJson(const resource_wire::Socket& p_socket,
                                       const ResourceSample* p_previous,
                                       double p_elapsed)
  {
    using resource_wire::SocketFlags;
    const auto fill = Fill(p_socket);
    const resource_wire::Socket* before = nullptr;
    if (p_previous != nullptr)
    {
      const auto found =
          std::ranges::find_if(p_previous->sockets_,
                               [&](const resource_wire::Socket& p_other)
                               {
                                 return p_other.inode_ == p_socket.inode_ &&
                                        p_other.kind_ == p_socket.kind_;
                               });
      if (found != p_previous->sockets_.end())
      {
        before = &*found;
      }
    }
    const auto grew =
        [&](std::uint64_t p_now,
            std::uint64_t p_before) -> std::optional<std::uint64_t>
    {
      if (before == nullptr || p_now < p_before)
      {
        return std::nullopt;
      }
      return p_now - p_before;
    };
    Json result = JsonObject{{"fd", p_socket.fd_},
                             {"inode", p_socket.inode_},
                             {"kind", SocketKindName(p_socket.kind_)},
                             {"state", SocketStateName(p_socket.state_)},
                             {"listener", p_socket.state_ == 10},
                             {"rx_queue", p_socket.rx_queue_},
                             {"tx_queue", p_socket.tx_queue_},
                             {"rx_fill_pct", Json(fill.receive_)},
                             {"tx_fill_pct", Json(fill.send_)},
                             {"accept_fill_pct", Json(fill.accept_)}};
    if (resource_wire::IsUnix(p_socket.kind_))
    {
      result.Set("path", ReadName(p_socket.unix_path_));
    }
    else
    {
      result.Set("local",
                 FormatEndpoint(p_socket.kind_, p_socket.local_address_,
                                p_socket.local_port_));
      result.Set("remote", p_socket.remote_port_ == 0
                               ? Json{}
                               : Json(FormatEndpoint(p_socket.kind_,
                                                     p_socket.remote_address_,
                                                     p_socket.remote_port_)));
    }
    if (resource_wire::HasFlag(p_socket.flags_, SocketFlags::Memory))
    {
      result.Set("rmem_alloc", p_socket.rmem_alloc_);
      result.Set("rcvbuf", p_socket.rcvbuf_);
      result.Set("wmem_alloc", p_socket.wmem_alloc_);
      result.Set("wmem_queued", p_socket.wmem_queued_);
      result.Set("sndbuf", p_socket.sndbuf_);
      result.Set("drops", p_socket.drops_);
      result.Set("drops_delta",
                 Number(grew(p_socket.drops_, before ? before->drops_ : 0)));
    }
    if (!resource_wire::HasFlag(p_socket.flags_, SocketFlags::TcpInfo))
    {
      return result;
    }
    const auto limited = [&](std::uint64_t p_now,
                             std::uint64_t p_before) -> Json
    {
      const auto growth = grew(p_now, p_before);
      if (!growth || p_elapsed <= 0 ||
          !resource_wire::HasFlag(p_socket.flags_, SocketFlags::TcpLimited))
      {
        return Json{};
      }
      return std::min(100.0, static_cast<double>(*growth) / 1e4 / p_elapsed);
    };
    JsonObject tcp{
        {"rtt_ms", p_socket.rtt_us_ / 1000.0},
        {"rttvar_ms", p_socket.rttvar_us_ / 1000.0},
        {"retrans", p_socket.total_retrans_},
        {"retrans_delta", Number(grew(p_socket.total_retrans_,
                                      before ? before->total_retrans_ : 0))},
        {"unacked", p_socket.unacked_},
        {"lost", p_socket.lost_},
        {"notsent_bytes", p_socket.notsent_bytes_},
        {"retransmits", p_socket.retransmits_},
        {"probes", p_socket.probes_},
        {"backoff", p_socket.backoff_},
        {"last_recv_ms", p_socket.last_data_recv_ms_},
        {"last_send_ms", p_socket.last_data_sent_ms_},
        {"peer_window",
         resource_wire::HasFlag(p_socket.flags_, SocketFlags::PeerWindow)
             ? Json(p_socket.peer_window_)
             : Json{}},
        {"rwnd_limited_pct", limited(p_socket.rwnd_limited_us_,
                                     before ? before->rwnd_limited_us_ : 0)},
        {"sndbuf_limited_pct",
         limited(p_socket.sndbuf_limited_us_,
                 before ? before->sndbuf_limited_us_ : 0)}};
    result.Set("tcp", std::move(tcp));
    return result;
  }

  // The sample as JSON for the live view.
  [[nodiscard]] static Json SampleJson(const ResourceSample& p_sample,
                                       const ResourceSample* p_previous)
  {
    using resource_wire::Flags;
    using resource_wire::HasFlag;
    const auto& header = p_sample.header_;
    const double elapsed = p_previous ? Elapsed(p_sample, *p_previous) : 0;
    const auto value = [&](std::size_t p_field)
    {
      return Number(Value(p_sample, p_field));
    };
    Json result = JsonObject{
        {"ts", p_sample.wall_},
        {"session", std::to_string(header.session_)},
        {"sequence", header.sequence_},
        {"pid", header.pid_},
        {"interval_s", header.interval_ms_ / 1000.0},
        {"elapsed_s", p_previous ? Json(elapsed) : Json{}},
        {"cgroup", p_sample.cgroup_.empty() ? Json{} : Json(p_sample.cgroup_)},
        {"flags",
         JsonObject{{"other_network_namespace",
                     HasFlag(header.flags_, Flags::OtherNetworkNamespace)},
                    {"descriptors_hidden",
                     HasFlag(header.flags_, Flags::DescriptorsHidden)},
                    {"descriptor_scan_truncated",
                     HasFlag(header.flags_, Flags::DescriptorScanTruncated)},
                    {"socket_diag_failed",
                     HasFlag(header.flags_, Flags::SocketDiagFailed)},
                    {"sockets_truncated",
                     HasFlag(header.flags_, Flags::SocketsTruncated)}}},
        {"pressure",
         JsonObject{{"host", PressureJson(p_sample, p_previous,
                                          Field("host_cpu_some_avg10"))},
                    {"cgroup", PressureJson(p_sample, p_previous,
                                            Field("cgroup_cpu_some_avg10"))}}},
        {"fds", JsonObject{{"open", value(Field("fd_open"))},
                           {"soft_limit", value(Field("fd_soft_limit"))},
                           {"hard_limit", value(Field("fd_hard_limit"))},
                           {"sockets", value(Field("fd_sockets"))}}}};
    Json io{JsonObject{}};
    for (const auto& [name, field] :
         {std::pair{"read_bps", Field("io_read_bytes")},
          std::pair{"write_bps", Field("io_write_bytes")},
          std::pair{"cancelled_write_bps", Field("io_cancelled_write_bytes")},
          std::pair{"rchar_bps", Field("io_rchar")},
          std::pair{"wchar_bps", Field("io_wchar")},
          std::pair{"syscr_per_s", Field("io_syscr")},
          std::pair{"syscw_per_s", Field("io_syscw")}})
    {
      io.Set(name, Json(Rate(p_sample, p_previous, field)));
    }
    result.Set("io", std::move(io));
    Json sockets{JsonObject{}};
    for (const auto& [kind, first, listeners] :
         {std::tuple{"tcp", Field("tcp_sockets"), true},
          std::tuple{"udp", Field("udp_sockets"), false},
          std::tuple{"unix", Field("unix_sockets"), true}})
    {
      const auto queues = listeners ? first + 2 : first + 1;
      sockets.Set(kind, JsonObject{{"sockets", value(first)},
                                   {"listeners",
                                    listeners ? value(first + 1) : Json(0)},
                                   {"rx_queue", value(queues)},
                                   {"tx_queue", value(queues + 1)},
                                   {"drops", value(queues + 2)}});
    }
    Json states{JsonObject{}};
    for (const auto& [name, field] :
         {std::pair{"established", Field("tcp_established")},
          std::pair{"syn_sent", Field("tcp_syn_sent")},
          std::pair{"syn_recv", Field("tcp_syn_recv")},
          std::pair{"fin_wait1", Field("tcp_fin_wait1")},
          std::pair{"fin_wait2", Field("tcp_fin_wait2")},
          std::pair{"close", Field("tcp_close")},
          std::pair{"close_wait", Field("tcp_close_wait")},
          std::pair{"last_ack", Field("tcp_last_ack")},
          std::pair{"listen", Field("tcp_listen")},
          std::pair{"closing", Field("tcp_closing")}})
    {
      states.Set(name, value(field));
    }
    sockets.Set("tcp_states", std::move(states));
    sockets.Set("matched", value(Field("sockets_matched")));
    sockets.Set("unmatched", value(Field("sockets_unmatched")));
    sockets.Set("complete", p_sample.sockets_complete_);
    JsonArray top;
    for (const auto& socket : p_sample.sockets_)
    {
      top.push_back(SocketJson(socket, p_previous, elapsed));
    }
    sockets.Set("top", std::move(top));
    result.Set("sockets", std::move(sockets));
    Json network{JsonObject{}};
    for (std::size_t field = Field("net_tcp_active_opens");
         field <= Field("net_udp_mem_errors"); ++field)
    {
      const auto name = resource_wire::kSummaryFields[field].substr(4);
      network.Set(
          name,
          JsonObject{{"total", value(field)},
                     {"delta", Number(Growth(p_sample, p_previous, field))},
                     {"per_s", Json(Rate(p_sample, p_previous, field))}});
    }
    for (std::size_t field = Field("net_if_rx_errors");
         field <= Field("net_if_tx_dropped"); ++field)
    {
      network.Set(
          resource_wire::kSummaryFields[field].substr(4),
          JsonObject{{"total", value(field)},
                     {"delta", Number(Growth(p_sample, p_previous, field))},
                     {"per_s", Json(Rate(p_sample, p_previous, field))}});
    }
    result.Set("network", std::move(network));
    // RSS can shrink, so its growth is signed (a counter's is not).
    std::optional<double> rss_growth;
    const auto rss_now = Value(p_sample, Field("rss_bytes"));
    const auto rss_before =
        p_previous ? Value(*p_previous, Field("rss_bytes")) : std::nullopt;
    if (rss_now && rss_before && elapsed > 0)
    {
      rss_growth =
          (static_cast<double>(*rss_now) - static_cast<double>(*rss_before)) /
          elapsed;
    }
    result.Set("memory", JsonObject{{"rss", value(Field("rss_bytes"))},
                                    {"anon", value(Field("rss_anon_bytes"))},
                                    {"file", value(Field("rss_file_bytes"))},
                                    {"shmem", value(Field("rss_shmem_bytes"))},
                                    {"peak", value(Field("rss_peak_bytes"))},
                                    {"swap", value(Field("swap_bytes"))},
                                    {"rss_growth_per_s", Json(rss_growth)}});
    const auto throttled = ThrottledPercent(p_sample, p_previous);
    result.Set(
        "cgroup_limits",
        JsonObject{
            {"memory",
             JsonObject{{"current", value(Field("cgroup_memory_current"))},
                        {"max", value(Field("cgroup_memory_max"))},
                        {"high", value(Field("cgroup_memory_high"))},
                        {"max_events_delta",
                         Number(Growth(p_sample, p_previous,
                                       Field("cgroup_memory_max_events")))},
                        {"oom_kill", value(Field("cgroup_memory_oom_kill"))},
                        {"oom_kill_delta",
                         Number(Growth(p_sample, p_previous,
                                       Field("cgroup_memory_oom_kill")))}}},
            {"cpu",
             JsonObject{
                 {"quota_us", value(Field("cgroup_cpu_quota_us"))},
                 {"period_us", value(Field("cgroup_cpu_period_us"))},
                 {"throttled_pct", Json(throttled)},
                 {"throttled_total", value(Field("cgroup_cpu_nr_throttled"))}}},
            {"pids",
             JsonObject{{"current", value(Field("cgroup_pids_current"))},
                        {"max", value(Field("cgroup_pids_max"))}}}});
    Json sockstat{JsonObject{}};
    for (std::size_t field = Field("sockstat_tcp_inuse");
         field <= Field("sockstat_udp_mem"); ++field)
    {
      sockstat.Set(resource_wire::kSummaryFields[field].substr(9),
                   value(field));
    }
    result.Set("sockstat", std::move(sockstat));
    const auto triple = [&](std::size_t p_first)
    {
      return JsonArray{value(p_first), value(p_first + 1), value(p_first + 2)};
    };
    result.Set("limits", JsonObject{{"tcp_mem", triple(Field("tcp_mem_low"))},
                                    {"udp_mem", triple(Field("udp_mem_low"))},
                                    {"rmem_max", value(Field("rmem_max"))},
                                    {"wmem_max", value(Field("wmem_max"))},
                                    {"somaxconn", value(Field("somaxconn"))},
                                    {"page_size", value(Field("page_size"))}});
    return result;
  }

  // The resource_sample row for p_sample.
  [[nodiscard]] static ResourceRow Row(const ResourceSample& p_sample,
                                       const ResourceSample* p_previous)
  {
    ResourceRow row;
    const auto set = [&row](std::size_t p_column, SqlValue p_value)
    {
      row[p_column] = std::move(p_value);
    };
    const auto real = [](std::optional<double> p_value) -> SqlValue
    {
      return p_value ? SqlValue{*p_value} : SqlValue{};
    };
    const auto integer = [](std::optional<std::uint64_t> p_value) -> SqlValue
    {
      if (!p_value)
      {
        return {};
      }
      return static_cast<std::int64_t>(
          std::min<std::uint64_t>(*p_value, INT64_MAX));
    };
    const auto& header = p_sample.header_;
    set(ResourceColumnIndex("ts"), p_sample.wall_);
    set(ResourceColumnIndex("session"), std::to_string(header.session_));
    set(ResourceColumnIndex("sequence"), std::int64_t{header.sequence_});
    set(ResourceColumnIndex("pid"), std::int64_t{header.pid_});
    set(ResourceColumnIndex("elapsed_s"),
        real(p_previous ? std::optional{Elapsed(p_sample, *p_previous)}
                        : std::nullopt));
    // host_cpu_some_pct .. cgroup_io_full_pct follow the PSI totals' order.
    static_assert(ResourceColumnIndex("cgroup_io_full_pct") ==
                  ResourceColumnIndex("host_cpu_some_pct") + 11);
    for (std::size_t index = 0; index < 12; ++index)
    {
      set(ResourceColumnIndex("host_cpu_some_pct") + index,
          real(StallPercent(p_sample, p_previous,
                            Field("host_cpu_some_total") + index * 2)));
    }
    for (const auto& [column, field] :
         {std::pair{ResourceColumnIndex("fd_open"), Field("fd_open")},
          std::pair{ResourceColumnIndex("fd_soft_limit"),
                    Field("fd_soft_limit")},
          std::pair{ResourceColumnIndex("fd_sockets"), Field("fd_sockets")},
          std::pair{ResourceColumnIndex("tcp_sockets"), Field("tcp_sockets")},
          std::pair{ResourceColumnIndex("udp_sockets"), Field("udp_sockets")},
          std::pair{ResourceColumnIndex("unix_sockets"), Field("unix_sockets")},
          std::pair{ResourceColumnIndex("tcp_established"),
                    Field("tcp_established")},
          std::pair{ResourceColumnIndex("tcp_close_wait"),
                    Field("tcp_close_wait")},
          std::pair{ResourceColumnIndex("sockstat_tcp_mem"),
                    Field("sockstat_tcp_mem")}})
    {
      set(column, integer(Value(p_sample, field)));
    }
    for (const auto& [column, field] :
         {std::pair{ResourceColumnIndex("rss_bytes"), Field("rss_bytes")},
          std::pair{ResourceColumnIndex("swap_bytes"), Field("swap_bytes")},
          std::pair{ResourceColumnIndex("cgroup_memory_current"),
                    Field("cgroup_memory_current")},
          std::pair{ResourceColumnIndex("cgroup_memory_max"),
                    Field("cgroup_memory_max")},
          std::pair{ResourceColumnIndex("cgroup_pids_current"),
                    Field("cgroup_pids_current")}})
    {
      set(column, integer(Value(p_sample, field)));
    }
    set(ResourceColumnIndex("cgroup_memory_max_events_delta"),
        integer(
            Growth(p_sample, p_previous, Field("cgroup_memory_max_events"))));
    set(ResourceColumnIndex("cgroup_memory_oom_kill_delta"),
        integer(Growth(p_sample, p_previous, Field("cgroup_memory_oom_kill"))));
    set(ResourceColumnIndex("cgroup_cpu_throttled_pct"),
        real(ThrottledPercent(p_sample, p_previous)));
    // Interface errors and drops, summed; unavailable if any part is.
    for (const auto& [column, first] :
         {std::pair{ResourceColumnIndex("if_errors_delta"),
                    Field("net_if_rx_errors")},
          std::pair{ResourceColumnIndex("if_dropped_delta"),
                    Field("net_if_rx_dropped")}})
    {
      const auto receive = Growth(p_sample, p_previous, first);
      const auto transmit = Growth(p_sample, p_previous, first + 2);
      set(column,
          integer(receive && transmit ? std::optional{*receive + *transmit}
                                      : std::nullopt));
    }
    set(ResourceColumnIndex("read_bps"),
        real(Rate(p_sample, p_previous, Field("io_read_bytes"))));
    set(ResourceColumnIndex("write_bps"),
        real(Rate(p_sample, p_previous, Field("io_write_bytes"))));
    const auto sum = [&](std::initializer_list<std::size_t> p_fields)
    {
      std::uint64_t total = 0;
      for (const auto field : p_fields)
      {
        const auto part = Value(p_sample, field);
        if (!part)
        {
          return integer(std::nullopt);
        }
        total += *part;
      }
      return integer(total);
    };
    set(ResourceColumnIndex("rx_queue_bytes"),
        sum({Field("tcp_rx_queue"), Field("udp_rx_queue"),
             Field("unix_rx_queue")}));
    set(ResourceColumnIndex("tx_queue_bytes"),
        sum({Field("tcp_tx_queue"), Field("udp_tx_queue"),
             Field("unix_tx_queue")}));
    set(ResourceColumnIndex("socket_drops"),
        sum({Field("tcp_drops"), Field("udp_drops"), Field("unix_drops")}));
    std::optional<double> receive;
    std::optional<double> send;
    std::optional<double> accept;
    const auto higher =
        [](std::optional<double>& p_best, std::optional<double> p_value)
    {
      if (p_value && (!p_best || *p_value > *p_best))
      {
        p_best = p_value;
      }
    };
    for (const auto& socket : p_sample.sockets_)
    {
      const auto fill = Fill(socket);
      higher(receive, fill.receive_);
      higher(send, fill.send_);
      higher(accept, fill.accept_);
    }
    set(ResourceColumnIndex("max_rx_fill_pct"), real(receive));
    set(ResourceColumnIndex("max_tx_fill_pct"), real(send));
    set(ResourceColumnIndex("max_accept_fill_pct"), real(accept));
    for (const auto& [column, field] :
         {std::pair{ResourceColumnIndex("tcp_retrans_segs_delta"),
                    Field("net_tcp_retrans_segs")},
          std::pair{ResourceColumnIndex("tcp_timeouts_delta"),
                    Field("net_tcp_timeouts")},
          std::pair{ResourceColumnIndex("tcp_estab_resets_delta"),
                    Field("net_tcp_estab_resets")},
          std::pair{ResourceColumnIndex("listen_overflows_delta"),
                    Field("net_listen_overflows")},
          std::pair{ResourceColumnIndex("listen_drops_delta"),
                    Field("net_listen_drops")},
          std::pair{ResourceColumnIndex("tcp_backlog_drop_delta"),
                    Field("net_tcp_backlog_drop")},
          std::pair{ResourceColumnIndex("tcp_rcvq_drop_delta"),
                    Field("net_tcp_rcvq_drop")},
          std::pair{ResourceColumnIndex("tcp_zero_window_drop_delta"),
                    Field("net_tcp_zero_window_drop")},
          std::pair{ResourceColumnIndex("tcp_abort_on_memory_delta"),
                    Field("net_tcp_abort_on_memory")},
          std::pair{ResourceColumnIndex("tcp_memory_pressures_delta"),
                    Field("net_tcp_memory_pressures")},
          std::pair{ResourceColumnIndex("udp_rcvbuf_errors_delta"),
                    Field("net_udp_rcvbuf_errors")},
          std::pair{ResourceColumnIndex("udp_sndbuf_errors_delta"),
                    Field("net_udp_sndbuf_errors")},
          std::pair{ResourceColumnIndex("udp_in_errors_delta"),
                    Field("net_udp_in_errors")}})
    {
      set(column, integer(Growth(p_sample, p_previous, field)));
    }
    set(ResourceColumnIndex("flags"),
        std::int64_t{std::to_underlying(header.flags_)});
    set(ResourceColumnIndex("cgroup"), p_sample.cgroup_);
    set(ResourceColumnIndex("sockets"), StoredSockets(p_sample, p_previous));
    set(ResourceColumnIndex("sockets_complete"),
        std::int64_t{p_sample.sockets_complete_ ? 1 : 0});
    return row;
  }

  // Compact JSON of the sockets worth keeping: queued data, a buffer at
  // least a tenth full, or new drops or retransmissions. Only the fields an
  // incident review needs, rounded, to keep rows small.
  [[nodiscard]] static std::string StoredSockets(
      const ResourceSample& p_sample, const ResourceSample* p_previous)
  {
    const double elapsed = p_previous ? Elapsed(p_sample, *p_previous) : 0;
    const auto rounded = [](const Json* p_value) -> Json
    {
      if (p_value == nullptr || !p_value->IsNumber())
      {
        return Json{};
      }
      return std::round(p_value->AsNumber() * 10) / 10;
    };
    const auto positive = [](const Json* p_value)
    {
      return p_value != nullptr && p_value->IsInt() && p_value->AsInt() > 0;
    };
    JsonArray kept;
    for (const auto& socket : p_sample.sockets_)
    {
      if (kept.size() == kStoredSockets)
      {
        break;
      }
      const auto json = SocketJson(socket, p_previous, elapsed);
      const auto fill = Fill(socket);
      const auto* tcp = json.Find("tcp");
      const auto* retrans =
          tcp != nullptr ? tcp->Find("retrans_delta") : nullptr;
      const bool listener = socket.state_ == 10;
      const bool busy =
          socket.rx_queue_ > 0 || (socket.tx_queue_ > 0 && !listener) ||
          std::max({fill.receive_.value_or(0), fill.send_.value_or(0),
                    fill.accept_.value_or(0)}) >= 10 ||
          positive(json.Find("drops_delta")) || positive(retrans);
      if (!busy)
      {
        continue;
      }
      Json stored = JsonObject{{"fd", socket.fd_},
                               {"kind", *json.Find("kind")},
                               {"state", *json.Find("state")}};
      for (const auto key :
           {"path", "local", "remote", "rx_queue", "tx_queue", "drops_delta"})
      {
        if (const auto* value = json.Find(key); value && !value->IsNull())
        {
          stored.Set(key, *value);
        }
      }
      for (const auto key : {"rx_fill_pct", "tx_fill_pct", "accept_fill_pct"})
      {
        if (const auto value = rounded(json.Find(key)); !value.IsNull())
        {
          stored.Set(key, value);
        }
      }
      if (tcp != nullptr && !listener)
      {
        stored.Set("rtt_ms", rounded(tcp->Find("rtt_ms")));
        stored.Set("retrans_delta", retrans ? *retrans : Json{});
        stored.Set("peer_window", *tcp->Find("peer_window"));
        stored.Set("rwnd_limited_pct", rounded(tcp->Find("rwnd_limited_pct")));
      }
      kept.push_back(std::move(stored));
    }
    return DumpJson(Json{std::move(kept)});
  }
};

}  // namespace triangulator::collector
