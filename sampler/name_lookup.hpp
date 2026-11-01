#pragma once

#include "discovery.hpp"
#include "proc.hpp"

namespace triangulator
{

// Looks up the targets of a target table each tick. A PID target costs one
// stat read. A name target is found by a /proc pass that reads at most
// kScanEntriesPerTick entries per tick, as discovery does, so a host with
// many processes cannot delay a tick. Only a complete pass decides whether
// a name is unique, ambiguous or absent. Between passes, the PID that the
// last pass found is checked every tick with one stat read, so an exit, a
// PID reuse or a new name is seen at once. A pass starts kDiscoveryInterval
// after the last one, or at once while a name has no PID. A second process
// with the same name is therefore seen at the end of the next pass.
class NameLookup final
{
 public:
  // p_root is /proc, or a test directory in the same layout.
  explicit NameLookup(const char* p_root = "/proc") : root_("{}", p_root)
  {
  }

  // After a reload: the pass in progress used the old table. The PIDs
  // found are kept by name, so unchanged targets keep their sessions.
  void Restart() noexcept
  {
    directory_.reset();
    next_pass_ = Nanoseconds{0};
  }

  [[nodiscard]] std::array<TargetLookup, target_wire::kMaxTargets> Find(
      std::span<const TargetConfig> p_targets, Nanoseconds p_now)
  {
    assert(p_targets.size() <= target_wire::kMaxTargets);
    Step(p_targets, p_now);
    std::array<TargetLookup, target_wire::kMaxTargets> results{};
    for (std::size_t index = 0; index < p_targets.size(); ++index)
    {
      const auto& selector = p_targets[index].selector_;
      if (const auto* pid = std::get_if<TargetPid>(&selector))
      {
        results[index] = FindTarget(*pid, root_.CStr());
        continue;
      }
      const auto& name = std::get<TargetName>(selector).value_;
      auto* found = Resolved(name);
      if (!found)
      {
        // No complete pass found it. After a failed pass, that is unknown.
        results[index] = error_ != 0 ? TargetLookup{std::unexpected(error_)}
                                     : TargetLookup{std::nullopt};
        continue;
      }
      const auto stat = ReadProcessStat(found->pid_, root_.CStr());
      if (!stat)
      {
        results[index] = std::unexpected(stat.error());
        continue;
      }
      if (!*stat || std::string_view{(*stat)->name_.data()} != name)
      {
        *found = {};  // gone or renamed; the next pass starts at once
        results[index] = std::nullopt;
        continue;
      }
      results[index] = TargetIdentity{found->pid_, (*stat)->starttime_};
    }
    return results;
  }

 private:
  struct Found
  {
    ProcessName name_{};
    int pid_ = 0;
  };

  [[nodiscard]] Found* Resolved(std::string_view p_name) noexcept
  {
    const auto found = std::ranges::find_if(
        resolved_,
        [p_name](const Found& p_found)
        {
          return p_found.pid_ != 0 && Text(p_found.name_) == p_name;
        });
    return found == resolved_.end() ? nullptr : &*found;
  }

  void Step(std::span<const TargetConfig> p_targets, Nanoseconds p_now)
  {
    const auto is_name = [](const TargetConfig& p_target)
    {
      return std::holds_alternative<TargetName>(p_target.selector_);
    };
    if (std::ranges::none_of(p_targets, is_name))
    {
      return;
    }
    if (!directory_)
    {
      const bool unresolved = std::ranges::any_of(
          p_targets,
          [&](const TargetConfig& p_target)
          {
            return is_name(p_target) &&
                   !Resolved(std::get<TargetName>(p_target.selector_).value_);
          });
      if (p_now < next_pass_ && !unresolved)
      {
        return;
      }
      directory_.emplace(root_.CStr());
      pass_start_ = p_now;
      pass_pids_ = {};
      pass_ambiguous_ = {};
      if (!*directory_)
      {
        Fail(errno, p_now);
        return;
      }
    }
    std::array<char, 4096> buffer{};
    for (std::size_t count = 0; count < kScanEntriesPerTick; ++count)
    {
      const auto entry = directory_->Next();
      if (!entry)
      {
        Fail(entry.error(), p_now);
        return;
      }
      if (!*entry)
      {
        Complete(p_targets);
        return;
      }
      const auto pid = ParseNumber<int>(**entry);
      if (!pid || *pid <= 0)
      {
        continue;
      }
      const auto descriptor =
          OpenReadonly(FixedString{"{}/{}/comm", root_.View(), *pid}.CStr());
      if (!descriptor && DescriptorsExhausted(errno))
      {
        Fail(errno, p_now);
        return;
      }
      auto comm = ReadAtStart(descriptor, buffer);
      if (!comm)
      {
        continue;  // exited during the pass
      }
      if (comm->ends_with('\n'))
      {
        comm->remove_suffix(1);
      }
      for (std::size_t index = 0; index < p_targets.size(); ++index)
      {
        const auto* name = std::get_if<TargetName>(&p_targets[index].selector_);
        if (name && name->value_ == *comm)
        {
          pass_ambiguous_[index] = pass_pids_[index] != 0;
          pass_pids_[index] = *pid;
        }
      }
    }
  }

  // An incomplete pass decides nothing: the PIDs found before stay.
  void Fail(int p_error, Nanoseconds p_now) noexcept
  {
    directory_.reset();
    error_ = p_error;
    next_pass_ = p_now + kDiscoveryInterval;
  }

  void Complete(std::span<const TargetConfig> p_targets) noexcept
  {
    resolved_ = {};
    for (std::size_t index = 0; index < p_targets.size(); ++index)
    {
      const auto* name = std::get_if<TargetName>(&p_targets[index].selector_);
      if (name && pass_pids_[index] != 0 && !pass_ambiguous_[index])
      {
        auto& found = resolved_[index];
        std::ranges::copy(
            std::string_view{name->value_}.substr(0, found.name_.size() - 1),
            found.name_.begin());
        found.pid_ = pass_pids_[index];
      }
    }
    error_ = 0;
    directory_.reset();
    next_pass_ = pass_start_ + kDiscoveryInterval;
  }

  FixedString root_;
  std::optional<Directory> directory_;
  Nanoseconds pass_start_{0};
  Nanoseconds next_pass_{0};
  // Errno of the last failed pass, or zero after a complete one.
  int error_ = 0;
  // The pass in progress, by target index.
  std::array<int, target_wire::kMaxTargets> pass_pids_{};
  std::array<bool, target_wire::kMaxTargets> pass_ambiguous_{};
  // The last complete pass, by name: a reload can reorder the table.
  std::array<Found, target_wire::kMaxTargets> resolved_{};
};

}  // namespace triangulator
