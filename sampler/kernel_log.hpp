#pragma once

// Why did the target end? The sampler is not the target's parent, so it
// cannot wait() for its exit status. When the kernel kills a process, it
// logs why: a segfault, a general protection fault, a divide error or the
// out-of-memory killer. This reads those messages from /dev/kmsg, the file
// dmesg reads, without starting dmesg: the sampler stays one static binary.
//
// The log is opened when a target is found and positioned at its end, so
// messages about an earlier process with the same PID are not read. When
// kernel.dmesg_restrict = 1 (the default on Ubuntu, Debian and Arch), only
// CAP_SYSLOG may read it; the report then says so and has no messages.

#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <expected>
#include <optional>
#include <ranges>
#include <span>
#include <string_view>

#include "../common/exit_wire.hpp"
#include "../common/fd.hpp"
#include "io.hpp"
#include "proc.hpp"

namespace triangulator
{

// The message text of one /dev/kmsg record, which is
// "PRIORITY,SEQUENCE,MICROSECONDS,FLAGS[,...];TEXT\n" and may be followed by
// " KEY=VALUE\n" lines. nullopt when the record has no ';'.
[[nodiscard]] inline std::optional<std::string_view> KmsgText(
    std::string_view p_record) noexcept
{
  const auto start = p_record.find(';');
  if (start == std::string_view::npos)
  {
    return std::nullopt;
  }
  const auto text = p_record.substr(start + 1);
  return text.substr(0, text.find('\n'));
}

// The whole number that starts p_text, when digits end it at a character in
// p_terminators (or at the end of the text). "1234 (app)" is 1234; "1234abc",
// "12.5" and an 11-digit number are nothing.
[[nodiscard]] inline std::optional<std::uint32_t> LeadingId(
    std::string_view p_text, std::string_view p_terminators)
{
  std::size_t length = 0;
  while (length < p_text.size() && p_text[length] >= '0' &&
         p_text[length] <= '9')
  {
    ++length;
  }
  if (length == 0 || length > 10 ||
      (length < p_text.size() && !p_terminators.contains(p_text[length])))
  {
    return std::nullopt;
  }
  return ParseNumber<std::uint32_t>(p_text.substr(0, length));
}

// Whether any occurrence of p_key in p_text is followed by an id from
// p_sorted_ids. p_word_start asks for a character that cannot belong to a
// longer name in front of the key, so "pid=" does not match inside "ppid=".
[[nodiscard]] inline bool KeyNamesId(
    std::string_view p_text, std::string_view p_key,
    std::string_view p_terminators, bool p_word_start,
    std::span<const std::uint32_t> p_sorted_ids)
{
  const auto is_name_char = [](char p_char)
  {
    return (p_char >= '0' && p_char <= '9') ||
           (p_char >= 'A' && p_char <= 'Z') ||
           (p_char >= 'a' && p_char <= 'z') || p_char == '_';
  };
  for (auto at = p_text.find(p_key); at != std::string_view::npos;
       at = p_text.find(p_key, at + 1))
  {
    if (p_word_start && at != 0 && is_name_char(p_text[at - 1]))
    {
      continue;
    }
    const auto id = LeadingId(p_text.substr(at + p_key.size()), p_terminators);
    if (id && std::ranges::binary_search(p_sorted_ids, *id))
    {
      return true;
    }
  }
  return false;
}

// Whether p_text has "comm[1234]" with an id from p_sorted_ids: the thread
// name and ID the kernel prints for a fault. A bracket at the start of the
// text or after a space is not a task.
[[nodiscard]] inline bool NamesBracketedId(
    std::string_view p_text, std::span<const std::uint32_t> p_sorted_ids)
{
  for (auto at = p_text.find('['); at != std::string_view::npos;
       at = p_text.find('[', at + 1))
  {
    if (at == 0 || p_text[at - 1] == ' ')
    {
      continue;
    }
    const auto id = LeadingId(p_text.substr(at + 1), "]");
    if (id && std::ranges::binary_search(p_sorted_ids, *id))
    {
      return true;
    }
  }
  return false;
}

// Whether p_text is the hung-task warning "INFO: task comm:1234 blocked" for
// an id from p_sorted_ids. The thread name may itself contain ':'.
[[nodiscard]] inline bool NamesHungTask(
    std::string_view p_text, std::span<const std::uint32_t> p_sorted_ids)
{
  constexpr std::string_view kKey = "task ";
  for (auto at = p_text.find(kKey); at != std::string_view::npos;
       at = p_text.find(kKey, at + 1))
  {
    auto name = p_text.substr(at + kKey.size());
    name = name.substr(0, name.find(' '));
    const auto colon = name.rfind(':');
    if (colon == std::string_view::npos)
    {
      continue;
    }
    const auto id = LeadingId(name.substr(colon + 1), "");
    if (id && std::ranges::binary_search(p_sorted_ids, *id))
    {
      return true;
    }
  }
  return false;
}

// Whether p_text names one of p_sorted_ids as a task, in the forms the
// kernel uses for one: "comm[1234]: segfault" and "traps: comm[1234] trap",
// "Killed process 1234 (comm)", "pid=1234," in the OOM killer's summary,
// "CPU: 1 PID: 1234 Comm: comm" and "INFO: task comm:1234 blocked". Other
// numbers that equal an id, such as a fault address or a user ID, do not
// count.
[[nodiscard]] inline bool NamesTask(std::string_view p_text,
                                    std::span<const std::uint32_t> p_sorted_ids)
{
  return KeyNamesId(p_text, "Killed process ", " )", false, p_sorted_ids) ||
         KeyNamesId(p_text, "Kill process ", " )", false, p_sorted_ids) ||
         KeyNamesId(p_text, "pid=", ", ", true, p_sorted_ids) ||
         KeyNamesId(p_text, "PID: ", " ", false, p_sorted_ids) ||
         NamesBracketedId(p_text, p_sorted_ids) ||
         NamesHungTask(p_text, p_sorted_ids);
}

// Keeps the newest kernel messages that name the ended process or one of
// its threads: a segfault names the thread that faulted, the OOM killer
// names the process.
class ExitMessages
{
 public:
  // p_threads: the last tick's records, whose tids are the threads to match.
  ExitMessages(int p_pid, std::span<const wire::Record> p_threads)
  {
    ids_[id_count_++] = static_cast<std::uint32_t>(p_pid);
    for (const auto& record :
         p_threads.first(std::min(p_threads.size(), ids_.size() - id_count_)))
    {
      ids_[id_count_++] = record.tid_;
    }
    std::ranges::sort(std::span{ids_}.first(id_count_));
  }

  void Offer(std::string_view p_record)
  {
    const auto text = KmsgText(p_record);
    // Lines that start with '[' are rows of the OOM killer's task table,
    // which lists every process, not only the one it kills.
    if (!text || text->empty() || text->front() == '[' ||
        !NamesTask(*text, std::span{ids_}.first(id_count_)))
    {
      return;
    }
    exit_wire::SetLine(lines_[matched_ % lines_.size()], *text);
    ++matched_;
  }

  // Writes the kept messages into p_report, oldest first.
  void CopyTo(exit_wire::Report& p_report) const noexcept
  {
    const auto count = std::min(matched_, lines_.size());
    for (std::size_t index = 0; index < count; ++index)
    {
      p_report.lines_[index] =
          lines_[(matched_ - count + index) % lines_.size()];
    }
    p_report.line_count_ = static_cast<std::uint8_t>(count);
  }

 private:
  std::array<std::uint32_t, wire::kMaxThreads + 1> ids_{};
  std::size_t id_count_ = 0;
  std::array<exit_wire::Line, exit_wire::kMaxLines> lines_{};
  std::size_t matched_ = 0;
};

class KernelLog
{
 public:
  static constexpr const char* kPath = "/dev/kmsg";
  // An upper bound on the records read for one report. The kernel's ring
  // buffer holds far fewer; this only keeps the loop bounded.
  static constexpr std::size_t kMaxRecords = 1'000'000;

  // Starts watching a newly found target: later Collect() calls read only
  // the messages logged from now on.
  void Watch(RateLimitedLogger& p_logger, const char* p_path = kPath)
  {
    log_ = FileDescriptor{::open(p_path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)};
    error_ = log_ ? 0 : errno;
    if (log_ && ::lseek(log_.Get(), 0, SEEK_END) < 0)
    {
      error_ = errno;
      log_.Reset();
    }
    if (error_ == EPERM || error_ == EACCES)
    {
      p_logger.Warn(
          "kernel log ({}) not readable: {}; exit reports will have no "
          "kernel messages. Set kernel.dmesg_restrict = 0 to allow it",
          p_path, std::strerror(error_));
    }
  }

  // The report for p_target, which has ended. p_threads is the last
  // tick's records. Ends the watch.
  [[nodiscard]] exit_wire::Report Collect(
      const TargetIdentity& p_target, std::span<const wire::Record> p_threads,
      Nanoseconds p_wall)
  {
    exit_wire::Report report{
        .pid_ = static_cast<std::uint32_t>(p_target.pid_),
        .process_start_ = p_target.starttime_,
        .wall_ns_ = static_cast<std::uint64_t>(p_wall.count()),
    };
    const auto main_thread =
        std::ranges::find(p_threads, static_cast<std::uint32_t>(p_target.pid_),
                          &wire::Record::tid_);
    if (main_thread != p_threads.end())
    {
      std::ranges::copy(main_thread->comm_ | std::views::take(15),
                        report.comm_.begin());
    }
    if (!log_)
    {
      report.kernel_log_ = error_ == EPERM || error_ == EACCES
                               ? exit_wire::KernelLog::Unreadable
                               : exit_wire::KernelLog::Unavailable;
      report.error_ = static_cast<std::uint32_t>(error_ ? error_ : EBADF);
      return report;
    }
    ExitMessages messages{p_target.pid_, p_threads};
    for (std::size_t count = 0; count < kMaxRecords; ++count)
    {
      const auto length = ::read(log_.Get(), record_.data(), record_.size());
      if (length > 0)
      {
        messages.Offer({record_.data(), static_cast<std::size_t>(length)});
        continue;
      }
      // EPIPE: the kernel overwrote records we had not read yet; the next
      // read continues with the oldest one left. EAGAIN: no more records.
      if (length < 0 && (errno == EINTR || errno == EPIPE))
      {
        continue;
      }
      break;
    }
    messages.CopyTo(report);
    log_.Reset();
    error_ = EBADF;
    return report;
  }

 private:
  FileDescriptor log_;
  int error_ = EBADF;
  // One record per read(). The kernel limits a message to 1 KiB before
  // escaping; this leaves room for escapes and the KEY=VALUE lines.
  std::array<char, 8192> record_{};
};

// Whether p_target has ended: its /proc entry is gone, it is a zombie, or
// the PID now belongs to another process. The error is errno when the check
// could not be made for lack of file descriptors; the caller must not take
// that as "still running".
[[nodiscard]] inline std::expected<bool, int> ProcessEnded(
    const TargetIdentity& p_target)
{
  std::array<char, 4096> buffer{};
  const auto descriptor =
      OpenReadonly(FixedString{"/proc/{}/stat", p_target.pid_}.CStr());
  if (!descriptor && DescriptorsExhausted(errno))
  {
    return std::unexpected(errno);
  }
  const auto stat = ReadAtStart(descriptor, buffer).and_then(ParseStat);
  return !stat || stat->state_ == 'Z' || stat->state_ == 'X' ||
         stat->starttime_ != p_target.starttime_;
}

}  // namespace triangulator
