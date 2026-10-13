#pragma once

// Process-info datagrams ("TPIN", common/process_wire.hpp): what the target
// process is, rather than how it is doing. The collector keeps the newest one
// for /api/live, so each recorded snapshot carries it and a replayed moment
// shows the process as it was. It is not stored on its own. The sampler sends
// the same datagram every process_wire::kRepeatSeconds, so a copy only
// refreshes it.

#include <cstdint>
#include <format>
#include <optional>
#include <string_view>
#include <utility>

#include "../common/process_wire.hpp"
#include "json.hpp"

namespace triangulator::collector
{

class ProcessMonitor
{
 public:
  // Keeps p_packet when it is as new as the one held, by the time the sampler
  // read it. A late datagram of an earlier session, or of an earlier target,
  // does not replace a newer one. Allocates nothing.
  void Accept(const process_wire::Packet& p_packet) noexcept
  {
    if (!latest_ || p_packet.wall_ns_ >= latest_->wall_ns_)
    {
      latest_ = p_packet;
    }
  }

  // The newest info for /api/live, or null before the first datagram.
  // "session" is decimal text like health.session; the dashboard shows the
  // info only while it matches the session of the view.
  [[nodiscard]] Json Snapshot() const
  {
    using process_wire::Flags;
    using process_wire::HasFlag;
    if (!latest_)
    {
      return Json(nullptr);
    }
    const auto& packet = *latest_;
    const auto id = [](std::uint32_t p_value)
    {
      return p_value == process_wire::kUnavailable32 ? Json() : Json(p_value);
    };
    const auto text = [](const auto& p_field)
    {
      return Json(SanitizeUtf8(process_wire::Text(p_field)));
    };
    Json result{JsonObject{}};
    result.Set("session", Json(std::to_string(packet.session_)));
    result.Set("pid", Json(packet.pid_));
    result.Set("process_start", Json(packet.process_start_));
    result.Set("read_at", Json(static_cast<double>(packet.wall_ns_) / 1e9));
    result.Set("started_at",
               packet.started_wall_ns_ == 0
                   ? Json()
                   : Json(static_cast<double>(packet.started_wall_ns_) / 1e9));
    result.Set("parent_pid", id(packet.parent_pid_));
    result.Set("uid", id(packet.uid_real_));
    result.Set("euid", id(packet.uid_effective_));
    result.Set("gid", id(packet.gid_real_));
    result.Set("egid", id(packet.gid_effective_));
    result.Set("command", text(packet.command_));
    result.Set("executable", text(packet.exe_));
    result.Set("working_directory", text(packet.cwd_));
    result.Set("cpus_allowed", text(packet.cpus_allowed_));
    // Not shown in the card; kept for tools that read the API.
    result.Set("seccomp", SeccompName(packet.seccomp_));
    result.Set("no_new_privs", packet.no_new_privs_ > 1
                                   ? Json()
                                   : Json(packet.no_new_privs_ == 1));
    result.Set("cap_effective",
               packet.cap_effective_ == process_wire::kUnavailable64
                   ? Json()
                   : Json(std::format("{:x}", packet.cap_effective_)));
    result.Set("oom_score_adj",
               packet.oom_score_adj_ == process_wire::kUnavailableAdjust
                   ? Json()
                   : Json(packet.oom_score_adj_));
    // What was cut or could not be read, so the card can say why a value is
    // missing or ends early.
    const auto flags = packet.flags_;
    result.Set("exe_deleted", Json(HasFlag(flags, Flags::ExeDeleted)));
    result.Set("exe_hidden", Json(HasFlag(flags, Flags::ExeHidden)));
    result.Set("cwd_hidden", Json(HasFlag(flags, Flags::CwdHidden)));
    result.Set("command_truncated",
               Json(HasFlag(flags, Flags::CommandTruncated)));
    result.Set("executable_truncated",
               Json(HasFlag(flags, Flags::ExeTruncated)));
    result.Set("working_directory_truncated",
               Json(HasFlag(flags, Flags::CwdTruncated)));
    result.Set("cpus_truncated", Json(HasFlag(flags, Flags::CpuListTruncated)));
    return result;
  }

 private:
  [[nodiscard]] static Json SeccompName(std::uint8_t p_mode)
  {
    using process_wire::Seccomp;
    switch (static_cast<Seccomp>(p_mode))
    {
      case Seccomp::Off:
        return Json("off");
      case Seccomp::Strict:
        return Json("strict");
      case Seccomp::Filter:
        return Json("filter");
    }
    return Json();
  }

  std::optional<process_wire::Packet> latest_;
};

}  // namespace triangulator::collector
