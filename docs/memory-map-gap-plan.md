# Memory zoom: gaps and implementation plan

Research date: 2026-10-11. Implementation baseline: `e4f9d99`.

This document compares the zoom card in the
[original mock-up](mockups/process-memory-map.html) with the current dashboard.
It gives a plan for each gap. The proposals are not implemented.
Read [Memory map](memory-map.md) for current behavior and the
[reviewed design](process-memory-map-design.md) for the earlier proposal.

Most gaps can be closed without root access for a normal target owned by the
sampler user. Two goals need changes: clean/dirty page colors are not available
from unprivileged `pagemap`, and an allocator's largest free block is not
available from `/proc`.

## Access and permissions

The table uses these access classes:

| Class | Required access | Special privileges and limits |
|---|---|---|
| **UI** | Data already received by the dashboard | No new Linux permissions. |
| **MAP** | Read the target's `/proc/PID/maps` | Normally works for matching user credentials and a dumpable target. The kernel checks `PTRACE_MODE_READ_FSCREDS`. No debugger attach is needed. |
| **PAGE** | MAP access plus read `/proc/PID/pagemap` | Normally needs no capability for page-state flags on Linux 4.2 or later. The file is owner-readable. `CONFIG_PROC_PAGE_MONITOR` must be enabled. |
| **SMAPS** | Read `/proc/PID/smaps` | Normally works under the same target-access conditions as MAP. Needs `CONFIG_PROC_PAGE_MONITOR`. The cost, rather than privilege, is the main restriction. |
| **PFN** | Read physical frame numbers and `/proc/kpageflags` | Needs `CAP_SYS_ADMIN` in the initial user namespace for frame numbers, plus file access to `kpageflags`. This is outside the proposed default path. |

Matching UID alone does not guarantee access. Credential checks, target
dumpability, file modes, security modules, `/proc` mount options such as
`hidepid`, and PID/user namespaces can restrict it. `CAP_SYS_PTRACE` in the
target's user namespace can satisfy the ptrace capability checks. Linux 6.17
also accepts `CAP_PERFMON` through `mm_access` for read-mode inspection.
Neither capability alone guarantees access through file modes or mount
restrictions. In particular, `pagemap` has owner-read mode. Container root is
not equivalent to host root. These details are visible in
[ptrace access rules][ptrace], [procfs mount options][proc], and the
[Linux 6.17 access code][fork] and [procfs file modes][base].

Yama's `ptrace_scope` restrictions apply to attach-mode checks. Do not describe
`ptrace_scope=1` as a general ban on MAP or PAGE reads. Other security policy
can still deny access. Do not change target credentials, dumpability, or system
policy automatically. Show the failed source and its error instead.
[Yama documentation][yama] and [ptrace access rules][ptrace] describe the
distinction.

On Linux 4.0 and 4.1, unprivileged `pagemap` opens fail. From Linux 4.2, the
kernel hides frame numbers but retains page-state flags for an authorized
reader. `CAP_SYS_ADMIN` is not needed merely to count present or swapped
pages. See the [pagemap interface][pm].

## Gap table

Rows 3 and 4 separate goals that have different feasibility or permissions.
The numbers retain the original gap list.

| Gap and current behavior | Can it be added? | Proposed implementation | Access | Limits and completion criteria |
|---|---|---|---|---|
| **1. Selected-region resident size and percentage.** Only process RSS is available. | **Yes.** | Scan only the selected mapped ranges. Count `pagemap` entries with present bit 63. Multiply by the sampler host's base page size. Divide by mapped bytes for the percentage. Sum member VMAs for a grouped bar. [Page flags][pm-man] | PAGE | Report scan coverage and timestamps. A partial scan is not a complete total. State counts can change during the scan and are not an atomic `smaps` RSS snapshot. Validate against a controlled private anonymous mapping. |
| **2. Selected-region swapped size.** Only process swap is available. | **Yes, with a shared-memory limit.** | Count swapped bit 62 over the selected ranges. Reuse the scan for gap 1. Keep unmapped, mapped nonresident, and swapped states separate. [Page flags][pm-man] | PAGE | A zero entry does not prove that a shared-memory page was never allocated: shared swap can lose its PTE marker. Use an optional SMAPS result for shared-memory aggregate accounting, or mark that coverage as limited. [Shared-memory exceptions][pm] |
| **3a. Private dirty bytes.** No selected-region value. | **Yes, as an optional aggregate.** | Sum `Private_Dirty` for the selected VMAs from `smaps`. Read on explicit request in a separate target-host C++ or Rust helper. Give results their own timestamp. [SMAPS fields][smaps] | SMAPS | `smaps` is sequential. Finding a late VMA can walk preceding VMAs. A byte/time budget cannot interrupt one blocked kernel read. Measure target impact before enabling it. This requires an explicit change to the reviewed design, which excludes `smaps`. |
| **3b. Huge-page bytes and “disabled” status.** Both are missing. | **Yes, with precise labels.** | Optional SMAPS detail can report `AnonHugePages`, `FilePmdMapped`, `ShmemPmdMapped`, and private/shared HugeTLB bytes separately. Report `THPeligible` and `VmFlags` separately from observed use. Read available `THP_enabled` process status and THP sysfs policy on the sampler host. [SMAPS fields][smaps], [process status][proc], and [THP controls][thp] | SMAPS; ordinary read access to target-host status and sysfs policy | Zero huge-page bytes does not mean disabled. `AnonHugePages` does not cover every multi-size THP allocation. Global `never` alone does not exclude `MADV_COLLAPSE`. An optional read-only `PAGEMAP_SCAN` can identify `PAGE_IS_HUGE`, but this covers PMD-mapped THP or HugeTLB, not all huge-page backing. Show this restricted scope. [Scan categories][scan] |
| **4a. Nonresident/resident/swapped grid.** Cells show mapping kinds only. | **Yes.** | Reduce the PAGE scan into at most 512 cells. Each cell contains measured page counts or fractions. Use separate patterns for unmapped, nonresident, swapped, mixed, and not measured. Keep mapping kind as a separate property. | PAGE | A cell covers many pages. Do not color it as wholly resident when only some pages are present. Bit 61 means file-backed **or** shared anonymous; it does not prove sharing between processes. Bit 56 is not a complete shared-memory classifier. [Pagemap semantics][pm] |
| **4b. Clean/dirty page colors.** Neither exists. | **Not in the default read-only, unprivileged path.** | Keep resident and swapped colors. Put optional SMAPS dirty totals in facts, not individual cells. A separate privileged experiment could join PFNs to physical `kpageflags` DIRTY, but that is not identical to per-mapping `smaps` dirty accounting. [Physical page flags][pm] | PFN for the physical-flag alternative | Soft-dirty records writes or mapping renewal, not the true dirty state. Do not substitute it. Resetting it through `clear_refs` changes target PTEs and causes later write faults. Do not use reset or write-protection operations in this plan. [Soft-dirty behavior][soft] |
| **5. Largest hole.** Current facts show total unmapped bytes and largest region. | **Yes for address gaps; not for allocator free blocks from `/proc`.** | Name the measurement **Largest unmapped gap**. Sort and clip member mappings to the displayed span, then compute the longest uncovered interval. A separate **Largest nonresident run** can use page-level scan results. | UI for gaps; PAGE for nonresident runs | A nonresident page can hold live data in swap. It is not an allocator free block. A contiguous heap mapping can have zero unmapped gaps while its allocator is fragmented. Allocator free-block data needs an application/allocator interface; even root access to `/proc` does not supply a generic allocator measurement. |
| **6. Unmapped space above the heap boundary.** Grid ends at the selection boundary. | **Yes.** | Add a bounded display margin above the heap mapping. Use neighboring mappings to distinguish actual gaps from another mapped region. Preserve this display range during growth so cells can change from unmapped to mapped. | UI | Show **above heap mapping end**. `/proc/PID/maps` gives a page-aligned mapping end, not the byte-exact current `brk`. Do not read `pagemap` for known unmapped gaps. Do not invent space when the layout is truncated. [Mapping ranges][proc] |
| **7. Growth in the last 10 s.** Outline compares layouts. “Break moved” uses browser history and can remain stale. | **Yes, as sampled growth.** | Use a visible-section watch with a short lease, bounded MAP sampling, and monotonic timestamps. The existing `memory_interval_s` accepts shorter intervals. Retain endpoints from unchanged samples too. Compare samples near the requested 10 s boundary. Refresh facts on each new sample. Expire outlines by time. | MAP; UI for fact refresh | Show the actual elapsed interval if it differs from 10 s. Polling misses changes between samples, including remove/recreate at the same address. Do not claim an exact `brk` event stream. Ensure sampler restart, target change, loss, and stale samples reset or invalidate comparisons. |
| **8. Heap-end and stack-start charts.** Current charts show sizes and `/ min` rates. | **Yes for mapping boundaries.** | Retain heap mapping end and main `[stack]` mapping start from each layout. Compute address differences with `BigInt` before conversion to plotted offsets. Let stack-start offsets fall as the mapping grows down. Label heap end as page-aligned. Keep size as a separate value. | UI; MAP for fresh points | `/proc/PID/stat` field `startstack` is the initial stack address, not its current lower mapping boundary. [STAT fields][stat] Keep sampled steps. Use measured time windows for rates. Retain the process-wide resident-anonymous chart; its data already exists. |
| **9. Page size and units.** Grid assumes 4,096-byte pages and uses KB/MB for binary scaling. | **Yes.** | Use the existing sampler-derived resource `limits.page_size` first. It comes from `sysconf(_SC_PAGESIZE)`. Add it to memory metadata if memory must work without resource samples. Use it for `pagemap` indexing and cell sizing. Use KiB/MiB/GiB for division by 1,024. [sysconf][sysconf] | UI for reuse/units; no privilege for sampler `sysconf` | Use the sampler host's value, not the collector host's value. Keep base page size separate from huge-page use. Unknown page size must not silently become 4 KiB. Validate 4 KiB and 64 KiB metadata. |
| **10. Compact layout and thread-stack explanation.** Extra table/notes increase height; chart titles wrap. | **Yes.** | Keep facts, legend, and charts in the main card. Move member VMAs to a disclosure. Give chart headings enough width and stack charts vertically on narrow screens. Add a short thread-stack help topic. | UI | Explain that common pthread stacks reserve a fixed range, while residency changes. This is not a universal rule for every runtime. Residency does not measure current stack depth. Keep contextual help and add manual QA cases in the implementation change. |

## Implementation boundaries

The default path should remain read-only. Add no `clear_refs` writes,
debugger attach, target memory reads, or `PAGEMAP_SCAN` write-protection flags.
The reviewed design already removed clean/dirty cells. Retain that decision.
Private-dirty and detailed huge-page totals are separate optional work.

The current implementation has only TVMA summary and region records. It has
no detail request, page cells, or page-state API. A browser-only change cannot
close gaps 1, 2, or 4a. See
[the wire records](../common/memory_wire.hpp),
[the sampler](../sampler/memory.hpp), and
[the collector](../collector/memory.hpp).

The proposed implementation sequence is:

1. **Correct the existing UI.** Close gaps 5 (unmapped gaps), 6, 8, 9, and 10.
   Fix the fact refresh in gap 7. These changes can use current data. Treat
   truncated layouts as incomplete, not as evidence of empty address ranges.
2. **Add bounded selection detail.** Use a C++ or Rust helper on the target
   host so page-table walks cannot delay thread sampling. A remote collector
   must request detail from that host; its own `/proc` is unrelated. Reuse the
   reviewed design's authenticated watch/stop and lease concept. Validate the
   selected range against the configured target's latest mappings. Do not
   accept arbitrary PIDs or paths. This new control path needs the threat
   review required by that design.
3. **Define the detail contract.** Include session, PID, process start identity,
   layout identity, selected ranges, base page size, scan timestamps, progress,
   and source/error status. Version the transport and API. Publish coherent
   detail results outside the collector's UDP loop. Do not insert extended
   dashboard processing into that loop.
4. **Add page states.** Implement gaps 1, 2, and 4a with aligned, bounded
   `pagemap` reads. One entry is eight bytes. Preserve exact integer totals
   before cell reduction. Limit memory, pages per burst, and time between
   reads. Resume large scans, back off after slow reads, and invalidate detail
   when the target or selected layout changes. A running target can still
   change during a scan. Report this as sampled detail, not an atomic snapshot.
5. **Add timed growth.** Close gap 7 with explicit watch cadence and coverage.
   Browser history starts when the page opens. Stored history is separate work
   and is not needed to reproduce this card.
6. **Decide optional detail.** For gaps 3a and 3b, measure the SMAPS helper's
   cost before changing the current no-SMAPS design. Consider a read-only
   `PAGEMAP_SCAN` optimization, available from Linux 6.7. Probe support at
   runtime. Keep raw `pagemap` as a compatibility path. [Scan API][scan-man]
   `PROCMAP_QUERY`, available from Linux 6.11, can simplify
   VMA lookup; it does not supply SMAPS dirty totals. [Procfs APIs][proc]

An incomplete or denied scan must retain a reason and coverage. Never replace
it with zero. Selection changes and expired leases must stop further work.
Small read sizes and elapsed-time checks reduce work between calls; they do
not provide a hard upper bound on a single kernel call.

## Validation for implementation changes

These checks are a plan. Their status is **NOT_RUN**. No feature is added by
this document.

| Area | Required evidence |
|---|---|
| Residency and cells | An owned anonymous mapping with a known touched subset. Mixed cells retain fractions. Partial and unread ranges remain distinct from zero. |
| Swap and shared memory | An owned workload on a host with swap. Skip with a reason if swap is unavailable. Confirm the shared-memory coverage limitation. Do not change host swap settings to force a result. |
| Dirty and huge-page detail | Compare optional totals with SMAPS for an owned target. Test THP policy separately from usage. Unsupported fields remain unavailable. |
| Access | A normal same-user target; an owned non-dumpable target; different-user and restricted-procfs cases in an isolated test environment. Record the failing source. |
| Boundaries and time | Heap expansion and contraction, stack expansion, unchanged layouts, missing intervals, selection changes, restart, and PID reuse. Verify timed outline expiry and downward stack-start plots. |
| Portability and cost | 4 KiB/64 KiB metadata; unsupported ioctls; truncated layouts; a large VMA scan. Measure thread-sampling delay, helper resource use, and target latency before and after detail sampling. |
| Dashboard | Desktop and narrow screens; readable labels; contextual help for every changed element; updated cases in `docs/qa/test-cases.md`. Run requested browser QA through the project manual-QA process. |

[pm]: https://docs.kernel.org/admin-guide/mm/pagemap.html
[pm-man]: https://www.man7.org/linux/man-pages/man5/proc_pid_pagemap.5.html
[smaps]: https://www.man7.org/linux/man-pages/man5/proc_pid_smaps.5.html
[proc]: https://docs.kernel.org/filesystems/proc.html
[ptrace]: https://www.man7.org/linux/man-pages/man2/ptrace.2.html
[yama]: https://docs.kernel.org/admin-guide/LSM/Yama.html
[fork]: https://github.com/torvalds/linux/blob/v6.17/kernel/fork.c#L1336-L1366
[base]: https://github.com/torvalds/linux/blob/v6.17/fs/proc/base.c#L3350-L3357
[thp]: https://docs.kernel.org/admin-guide/mm/transhuge.html
[soft]: https://docs.kernel.org/admin-guide/mm/soft-dirty.html
[scan]: https://docs.kernel.org/admin-guide/mm/pagemap.html#pagemap-scan-ioctl
[scan-man]: https://man7.org/linux/man-pages/man2/PAGEMAP_SCAN.2const.html
[stat]: https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
[sysconf]: https://www.man7.org/linux/man-pages/man3/sysconf.3.html
