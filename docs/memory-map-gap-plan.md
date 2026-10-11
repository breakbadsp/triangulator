# Memory zoom: gaps and implementation plan

Review date: 2026-10-11. Repository baseline: `12267f1`.

This plan keeps small dashboard changes that use data already available.
It compares the zoom card in the
[original mock-up](mockups/process-memory-map.html) with the current dashboard.
The proposals below are not implemented by this document.
Read [Memory map](memory-map.md) for current behavior and the
[reviewed design](process-memory-map-design.md) for the earlier proposal.
This plan limits the next work to the items below. The larger detail system
in the earlier proposal is not part of this work.

## Scope and access

Use the current memory layout, resource samples, and browser history.
Keep the sampler, collector, wire format, API, and sampling interval unchanged.
No new Linux permissions or target-host programs are needed.

The layout gives mapping addresses and sizes. Resource samples give
process-wide resident memory, swap, and the sampler host's base page size.
They do not give resident or swapped bytes for a selected region.
Keep those scopes clear in labels and help.

Do not add reads of `pagemap`, `smaps`, or `kpageflags`. Do not add debugger
attach, target writes, privileged operations, or a watch/stop control path.
If existing data is missing, stale, or incomplete, show that state. Do not
replace an unknown value with zero or infer unmapped space from missing data.

## Changes to keep

The gap numbers refer to the original comparison. Each item can be a small
implementation change in [the dashboard](../collector/dashboard.html).

| Gap | Change | Implementation and completion criteria |
|---|---|---|
| **9. Page size and units** | Remove the fixed 4 KiB assumption from the zoom grid. | Use `live.resources.limits.page_size` from the current target's resource sample. Use KiB/MiB/GiB for binary-scaled memory-map values. If page size is unavailable, show an unknown page size and describe cells in bytes; do not show a page count. Keep at most 512 cells. Test 4 KiB and 64 KiB metadata. No new memory metadata is required. |
| **5. Largest unmapped gap** | Add the longest address gap inside the selected bar. | Sort member ranges, clip them to the selected span, and find the longest uncovered interval. Use `BigInt` for address arithmetic. Show the value only for a current, complete layout. Keep **Largest region** as a separate fact. Explain that an address gap is not an allocator free block. |
| **7. Sampled growth facts** | Refresh growth facts when a new memory sample arrives, even when the layout is unchanged. | Reuse browser history and existing sample timestamps. Label the heap value **Heap mapping size change**, instead of **Break moved**. Show the actual measured interval. Keep **mapped since the previous layout** for outlines. Do not claim growth in the last 10 s or an exact `brk` movement. |
| **8. Mapping-boundary charts** | Show heap mapping end and main `[stack]` mapping start from existing layouts. | Store these addresses with each matching memory sample, including unchanged layouts. Subtract a baseline with `BigInt`, then plot byte offsets as sampled steps. Stack-start offsets decrease when the mapping grows down. Label the heap end as page-aligned. Keep mapped sizes in facts and retain the resident-anonymous chart. |
| **10. Compact layout and help** | Reduce card height and explain thread stacks. | Put member regions in a disclosure. Keep facts, legend, and charts visible. Give chart titles enough width and stack charts vertically on narrow screens. Explain that common pthread stacks reserve a fixed range, while residency can change. Residency does not measure current stack depth. |

For growth facts and boundary charts, use only layouts that match the current
summary. Reset history when the sampler session or target changes. Leave
missing or stale samples unavailable. Do not carry a previous target's values
into the current target. Browser history starts when the page opens; no stored
history is required.

## Small follow-up

**Gap 6: space above the heap mapping.** Add this only after the changes above.
It needs more display state than the other items, but no new sampled data.

Use a small, capped margin above the selected heap mapping. Use all layout
regions to distinguish an unmapped gap from a neighboring mapping. Keep the
selected heap's facts separate from the larger display span. Keep the grid
limit of 512 cells. Retain the display span while growth fits inside it; reset
it when the selection or target changes, or when the heap leaves that span.

Label the boundary **Heap mapping end**. Do not call it the exact program
break. Omit the margin when layout coverage is incomplete or stale.

## Work excluded from this plan

These gaps need new data collection or a larger design. They are not later
stages of the implementation sequence below.

| Gap or proposal | Reason to exclude it |
|---|---|
| **1, 2, 4a. Selected-region resident/swapped totals and page-state cells** | The current transport has summary and region records only. These features need target-host page scanning, bounded work, result identity and coverage, transport, and API changes. Keep mapping-kind cells. |
| **3a, 3b. Private-dirty totals and huge-page detail** | These need additional sources and target-cost measurements. Huge-page use and huge-page policy also need separate meanings. Keep them unavailable at region scope. |
| **4b. Clean/dirty page colors** | The current data cannot supply them. Soft-dirty is not a substitute for true dirty state. Do not add privileged physical-page inspection. |
| **5. Allocator free blocks or largest nonresident run** | Mapping gaps do not describe allocator free blocks. Allocator data needs an application interface; nonresident runs need page scanning. |
| **7. Fixed 10 s growth and timed outlines** | Default memory sampling is every 30 s. A reliable shorter window needs cadence and coverage work. Keep the measured interval and previous-layout comparison. |
| **Selection helpers, leases, new kernel ioctls, and stored history** | These add control paths, compatibility work, or storage. None is needed for the retained dashboard changes. |

## Implementation order

1. Correct page size, units, growth labels, and fact refresh: gaps 9 and 7.
2. Add the largest unmapped gap and boundary charts: gaps 5 and 8.
3. Compact the layout and update thread-stack help: gap 10.
4. Add the bounded heap margin as a separate follow-up: gap 6.

For each implementation change, add contextual help for each changed label,
chart, legend, and disclosure. Follow
[Help for new dashboard features](contextual-help-design.md#help-for-new-dashboard-features).
Update [manual QA cases](qa/test-cases.md) in the same change. Leave unexecuted
cases as `NOT_RUN`.

## Validation for implementation changes

These checks describe future feature validation. Their status is **NOT_RUN**.
No dashboard feature is added by this document.

| Area | Required evidence |
|---|---|
| Page size and units | 4 KiB, 64 KiB, and missing page-size metadata. Correct byte labels and no invented page counts. At most 512 grid cells. |
| Address gaps | Contiguous, separated, and grouped ranges; addresses above `2^53`; partial and truncated layouts. Unknown coverage must not become a measured gap. |
| Growth and charts | Heap growth and contraction, downward stack growth, unchanged layouts, missing samples, delayed layouts, session restart, and target changes. Facts refresh with new samples and show the measured interval. |
| Heap margin follow-up | Neighboring mapping, heap growth past the display span, selection change, and incomplete layout. Heap facts exclude the margin. |
| Dashboard | Desktop and narrow screens, readable titles, keyboard access to the disclosure and help, and retention of the resident-anonymous chart. Use the project manual-QA process for requested browser QA. |

Build and run `make check` before each implementation commit, as required by
`AGENTS.md`.
