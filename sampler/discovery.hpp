#pragma once

#include <algorithm>
#include <array>
#include <chrono>
#include <expected>
#include <format>
#include <optional>
#include <span>
#include <string_view>

#include "config.hpp"
#include "proc.hpp"

namespace triangulator
{

using namespace std::chrono_literals;

// A pass over /proc starts at most this often. One tick reads at most
// kScanEntriesPerTick entries and the pass continues on the next tick, so a
// host with many processes spreads the pass instead of delaying a tick.
inline constexpr Nanoseconds kDiscoveryInterval = 1s;
inline constexpr std::size_t kScanEntriesPerTick = 512;
// Ticks that a slot keeps after its process ends: the exit report goes out
// on 5 of them, then the release notice on 5 more. Datagrams can be lost.
inline constexpr std::uint8_t kReportTicks = 5;
inline constexpr std::uint8_t kReleaseTicks = 5;

enum class SlotState : std::uint8_t
{
  Free = 0,
  Waiting,    // a configured exact name with no running process
  Running,    // one process instance
  Releasing,  // no rule selects it, or its process ended; freed soon
};

using ProcessName = std::array<char, kMaxRuleBytes + 1>;

// One discovered target. The ID belongs to the slot from admission until it
// is freed: rule edits never rename it, so its session and history stay.
struct DiscoverySlot
{
  SlotState state_ = SlotState::Free;
  TargetIdentity identity_{};
  ProcessName
      name_{};  // the process name, or the name a waiting slot waits for
  std::array<char, 32> id_{};
  std::uint8_t ordinal_ = 0;  // N of an "name.N" ID; 0 without a suffix
  std::uint8_t selection_ =
      0;  // target_wire kNameSelected and kPatternSelected
  std::uint8_t release_ticks_ = 0;
  bool reassigned_ = false;  // a new ID: the sampler must start a new session
};

[[nodiscard]] inline std::string_view Text(const ProcessName& p_name) noexcept
{
  return {p_name.data(), ::strnlen(p_name.data(), p_name.size())};
}

// The rules that select a process name, as target_wire flag bits.
[[nodiscard]] inline std::uint8_t Selection(const Config& p_config,
                                            std::string_view p_name) noexcept
{
  std::uint8_t selection = 0;
  if (std::ranges::contains(p_config.process_names_, p_name))
  {
    selection |= target_wire::kNameSelected;
  }
  if (std::ranges::any_of(p_config.process_patterns_,
                          [p_name](const std::string& p_pattern)
                          {
                            return GlobMatch(p_pattern, p_name);
                          }))
  {
    selection |= target_wire::kPatternSelected;
  }
  return selection;
}

// The ID text for a process name: bytes that an ID cannot hold become '_'.
[[nodiscard]] inline std::array<char, 32> IdBase(std::string_view p_name)
{
  std::array<char, 32> base{};
  for (std::size_t index = 0; index < p_name.size(); ++index)
  {
    const char character = p_name[index];
    const bool kept = (character >= 'a' && character <= 'z') ||
                      (character >= 'A' && character <= 'Z') ||
                      (character >= '0' && character <= '9') ||
                      character == '-' || character == '_' || character == '.';
    base[index] = kept ? character : '_';
  }
  // "." and ".." are not valid IDs, as they are path names.
  if (p_name == "." || p_name == "..")
  {
    std::ranges::fill_n(base.begin(),
                        static_cast<std::ptrdiff_t>(p_name.size()), '_');
  }
  return base;
}

// Owns the discovery slots: which process each one follows and its ID. The
// sampler owns one TargetSampler for each slot and asks this class, each
// tick, what that slot follows. Nothing here allocates after Configure().
class Discovery final
{
 public:
  explicit Discovery(const char* p_directory = "/proc")
      : directory_path_("{}", p_directory)
  {
  }

  // Applies the rules at startup or reload. An instance that a rule still
  // selects keeps its slot, ID, and session; one that no rule selects is
  // released. Each configured name with no slot gets a waiting slot while a
  // slot is free.
  void Configure(const Config& p_config)
  {
    capacity_ = p_config.max_targets_;
    for (std::size_t index = 0; index < slots_.size(); ++index)
    {
      auto& slot = slots_[index];
      if (index >= capacity_)
      {
        slot = {};
        continue;
      }
      if (slot.state_ == SlotState::Running)
      {
        slot.selection_ = Selection(p_config, Text(slot.name_));
        if (slot.selection_ == 0)
        {
          Release(slot, kReleaseTicks);
        }
      }
      else if (slot.state_ == SlotState::Waiting)
      {
        slot.selection_ = Selection(p_config, Text(slot.name_));
        if ((slot.selection_ & target_wire::kNameSelected) == 0)
        {
          Release(slot, kReleaseTicks);
        }
      }
    }
    for (const auto& name : p_config.process_names_)
    {
      AddWaiting(p_config, name);
    }
    // New rules can match processes that the last pass skipped.
    directory_.reset();
    candidates_ = {};
    next_pass_ = Nanoseconds{0};
  }

  // Reads at most kScanEntriesPerTick /proc entries of the current pass and
  // selects the lowest PIDs for admission at the end of the pass. A waiting
  // slot for the same name comes first, then a free slot. Admitted instances
  // are never evicted; a match with no slot counts as excluded. The value is
  // true when this call finished a pass. Error: errno when file descriptors ran
  // out; the pass starts again at the next interval.
  [[nodiscard]] std::expected<bool, int> Scan(const Config& p_config,
                                              Nanoseconds p_now)
  {
    for (const auto& name : p_config.process_names_)
    {
      AddWaiting(p_config, name);
    }
    if (!directory_)
    {
      if (p_now < next_pass_)
      {
        return false;
      }
      directory_.emplace(directory_path_.CStr());
      pass_start_ = p_now;
      pass_excluded_ = 0;
      candidates_ = {};
      if (!*directory_)
      {
        return Abort(errno, p_now);
      }
    }
    for (std::size_t count = 0; count < kScanEntriesPerTick; ++count)
    {
      const auto entry = directory_->Next();
      if (!entry)
      {
        if (auto admitted = AdmitCandidates(p_config); !admitted)
        {
          return Abort(admitted.error(), p_now);
        }
        excluded_ = pass_excluded_;
        directory_.reset();
        next_pass_ = pass_start_ + kDiscoveryInterval;
        return true;
      }
      const auto pid = ParseNumber<int>(*entry);
      if (!pid || *pid <= 0 || Follows(*pid))
      {
        continue;
      }
      if (auto examined = Examine(p_config, *pid); !examined)
      {
        return Abort(examined.error(), p_now);
      }
    }
    return false;
  }

  // The process of a running slot ended. Its slot waits for the next process
  // with that name when the name is configured and has no other slot.
  // Otherwise it is released after its exit report has gone out.
  void End(const Config& p_config, std::size_t p_index)
  {
    auto& slot = slots_[p_index];
    slot.identity_ = {};
    slot.selection_ = Selection(p_config, Text(slot.name_));
    const bool other = std::ranges::any_of(
        Used(),
        [&](const DiscoverySlot& p_other)
        {
          return &p_other != &slot && p_other.state_ != SlotState::Releasing &&
                 Text(p_other.name_) == Text(slot.name_);
        });
    if ((slot.selection_ & target_wire::kNameSelected) != 0 && !other)
    {
      slot.state_ = SlotState::Waiting;
      return;
    }
    Release(slot, kReportTicks + kReleaseTicks);
  }

  // Counts one tick of a releasing slot, and frees it after its last one.
  void StepRelease(std::size_t p_index)
  {
    auto& slot = slots_[p_index];
    if (--slot.release_ticks_ == 0)
    {
      slot = {};
    }
  }

  // The target_wire flags that the slot's announcements carry.
  [[nodiscard]] std::uint8_t Flags(std::size_t p_index) const noexcept
  {
    const auto& slot = slots_[p_index];
    const bool released = slot.state_ == SlotState::Releasing &&
                          slot.release_ticks_ <= kReleaseTicks;
    return static_cast<std::uint8_t>(
        slot.selection_ | (released ? target_wire::kReleased : 0) |
        (slot.ordinal_ << target_wire::kOrdinalShift));
  }

  [[nodiscard]] std::span<DiscoverySlot> Used() noexcept
  {
    return std::span{slots_}.first(capacity_);
  }
  // Matching processes that the last complete pass could not admit.
  [[nodiscard]] std::uint32_t Excluded() const noexcept
  {
    return excluded_;
  }

 private:
  struct Candidate
  {
    int pid_ = 0;
    std::uint64_t starttime_ = 0;
    ProcessName name_{};
  };
  FixedString directory_path_;
  std::array<Candidate, target_wire::kMaxTargets * 2> candidates_{};
  std::array<DiscoverySlot, target_wire::kMaxTargets> slots_{};
  std::size_t capacity_ = 0;
  std::optional<Directory> directory_;
  Nanoseconds pass_start_{0};
  Nanoseconds next_pass_{0};
  std::uint32_t pass_excluded_ = 0;
  std::uint32_t excluded_ = 0;
  std::array<char, 64> buffer_{};

  static void Release(DiscoverySlot& p_slot, std::uint8_t p_ticks)
  {
    p_slot.state_ = SlotState::Releasing;
    p_slot.release_ticks_ = p_ticks;
  }

  [[nodiscard]] std::expected<bool, int> Abort(int p_error, Nanoseconds p_now)
  {
    directory_.reset();
    next_pass_ = p_now + kDiscoveryInterval;
    if (DescriptorsExhausted(p_error))
    {
      return std::unexpected(p_error);
    }
    return false;
  }

  // A slot follows this PID already, so its name needs no read.
  [[nodiscard]] bool Follows(int p_pid) noexcept
  {
    return std::ranges::any_of(Used(),
                               [p_pid](const DiscoverySlot& p_slot)
                               {
                                 return p_slot.identity_.pid_ == p_pid &&
                                        p_slot.state_ != SlotState::Free;
                               });
  }

  // Reads one process name, and admits the process when a rule selects it
  // and a slot is available. Error: errno when descriptors ran out.
  [[nodiscard]] std::expected<void, int> Examine(const Config& p_config,
                                                 int p_pid)
  {
    const auto descriptor =
        OpenReadonly(FixedString{"/proc/{}/comm", p_pid}.CStr());
    if (!descriptor && DescriptorsExhausted(errno))
    {
      return std::unexpected(errno);
    }
    auto name = ReadAtStart(descriptor, buffer_);
    if (!name)
    {
      return {};
    }
    if (name->ends_with('\n'))
    {
      name->remove_suffix(1);
    }
    if (name->empty() || name->size() > kMaxRuleBytes)
    {
      return {};
    }
    const auto selection = Selection(p_config, *name);
    if (selection == 0)
    {
      return {};
    }
    const auto identity = FindTarget(TargetPid{p_pid});
    if (!identity)
    {
      return std::unexpected(identity.error());
    }
    if (!*identity)
    {
      return {};
    }
    ++pass_excluded_;
    // Each waiting name has a reserved candidate. Free slots share a fixed
    // lowest-PID set. Directory enumeration order cannot change admission.
    Candidate candidate{p_pid, (**identity).starttime_, {}};
    std::ranges::copy(*name, candidate.name_.begin());
    if (auto* waiting = Waiting(*name))
    {
      const auto index = static_cast<std::size_t>(waiting - slots_.data());
      auto& held = candidates_[target_wire::kMaxTargets + index];
      if (held.pid_ == 0 || p_pid < held.pid_)
      {
        held = candidate;
      }
    }
    auto free_candidates = std::span{candidates_}.first(capacity_);
    const auto empty = std::ranges::find(free_candidates, 0, &Candidate::pid_);
    if (empty != free_candidates.end())
    {
      *empty = candidate;
    }
    else
    {
      auto largest =
          std::ranges::max_element(free_candidates, {}, &Candidate::pid_);
      if (p_pid < largest->pid_)
      {
        *largest = candidate;
      }
    }
    return {};
  }

  [[nodiscard]] std::expected<void, int> AdmitCandidates(const Config& p_config)
  {
    std::ranges::sort(candidates_, {}, &Candidate::pid_);
    int previous = 0;
    for (const auto& candidate : candidates_)
    {
      if (candidate.pid_ == 0 || candidate.pid_ == previous)
      {
        continue;
      }
      previous = candidate.pid_;
      auto* slot = Waiting(Text(candidate.name_));
      if (!slot)
      {
        slot = Free();
      }
      if (!slot)
      {
        continue;
      }
      if (auto admitted = Admit(p_config, *slot, candidate); !admitted)
      {
        return admitted;
      }
    }
    return {};
  }

  [[nodiscard]] std::expected<void, int> Admit(const Config& p_config,
                                               DiscoverySlot& p_slot,
                                               const Candidate& p_candidate)
  {
    auto* slot = &p_slot;
    const int p_pid = p_candidate.pid_;
    const auto name = Text(p_candidate.name_);
    const auto found = FindTarget(TargetPid{p_pid});
    if (!found)
    {
      return std::unexpected(found.error());
    }
    if (!*found || (**found).starttime_ != p_candidate.starttime_)
    {
      return {};  // It ended or the PID was reused during the scan.
    }
    if (slot->state_ == SlotState::Free)
    {
      Assign(*slot, name);
    }
    slot->state_ = SlotState::Running;
    slot->identity_ = **found;
    slot->selection_ = Selection(p_config, name);
    --pass_excluded_;
    return {};
  }

  [[nodiscard]] DiscoverySlot* Waiting(std::string_view p_name) noexcept
  {
    const auto slots = Used();
    const auto found =
        std::ranges::find_if(slots,
                             [p_name](const DiscoverySlot& p_slot)
                             {
                               return p_slot.state_ == SlotState::Waiting &&
                                      Text(p_slot.name_) == p_name;
                             });
    return found == slots.end() ? nullptr : &*found;
  }

  [[nodiscard]] DiscoverySlot* Free() noexcept
  {
    const auto slots = Used();
    const auto found =
        std::ranges::find(slots, SlotState::Free, &DiscoverySlot::state_);
    return found == slots.end() ? nullptr : &*found;
  }

  void AddWaiting(const Config& p_config, std::string_view p_name)
  {
    const bool held =
        std::ranges::any_of(Used(),
                            [p_name](const DiscoverySlot& p_slot)
                            {
                              return (p_slot.state_ == SlotState::Running ||
                                      p_slot.state_ == SlotState::Waiting) &&
                                     Text(p_slot.name_) == p_name;
                            });
    auto* slot = held ? nullptr : Free();
    if (!slot)
    {
      return;
    }
    Assign(*slot, p_name);
    slot->state_ = SlotState::Waiting;
    slot->selection_ = Selection(p_config, p_name);
  }

  // Gives a free slot an ID that no other slot has: the name, or "name.N"
  // with the smallest N from 2. There are at most 16 slots, so N <= 16.
  void Assign(DiscoverySlot& p_slot, std::string_view p_name)
  {
    p_slot = {};
    std::ranges::copy(p_name, p_slot.name_.begin());
    const auto base = IdBase(p_name);
    const std::string_view base_text{base.data(), p_name.size()};
    for (std::uint8_t ordinal = 1; ordinal <= target_wire::kMaxTargets;
         ++ordinal)
    {
      std::array<char, 32> id{};
      if (ordinal == 1)
      {
        std::ranges::copy(base_text, id.begin());
      }
      else
      {
        std::format_to_n(id.data(), id.size() - 1, "{}.{}", base_text, ordinal);
      }
      const std::string_view id_text{id.data(),
                                     ::strnlen(id.data(), id.size())};
      const bool taken = std::ranges::any_of(
          Used(),
          [&](const DiscoverySlot& p_other)
          {
            return &p_other != &p_slot && p_other.state_ != SlotState::Free &&
                   std::string_view{p_other.id_.data()} == id_text;
          });
      if (!taken)
      {
        p_slot.id_ = id;
        p_slot.ordinal_ = ordinal == 1 ? 0 : ordinal;
        p_slot.reassigned_ = true;
        return;
      }
    }
  }
};

}  // namespace triangulator
