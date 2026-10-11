# Gap implementation todos

Memory zoom tasks, in implementation order. Use existing memory layouts,
resource samples, and browser history.

- [x] **Page size and units.** Use `live.resources.limits.page_size` for the
  zoom grid and KiB/MiB/GiB for binary-scaled values. If page size is unknown,
  show cell sizes in bytes. Keep at most 512 cells.
- [ ] **Growth facts.** Refresh on each memory sample, including unchanged
  layouts. Use **Heap mapping size change** and show the measured interval.
  Keep outlines labeled **mapped since the previous layout**.
- [ ] **Largest unmapped gap.** Find the longest uncovered interval inside
  the selected bar. Use `BigInt` for addresses and a current, complete layout.
  Keep **Largest region** separate. Explain that gaps are not allocator free
  blocks.
- [ ] **Boundary charts.** Plot heap mapping end and main `[stack]` mapping
  start as offsets from a baseline. Subtract addresses with `BigInt` and show
  sampled steps. Label the heap end as page-aligned. Keep mapped sizes in
  facts and retain the resident-anonymous chart.
- [ ] **Compact layout and help.** Put member regions in a disclosure. Keep
  facts, legend, and charts visible. Make titles readable and stack charts
  vertically on narrow screens. Explain fixed thread-stack reservations and
  the difference between residency and stack depth.
- [ ] **Heap margin, last.** Add a small, capped display margin above the heap.
  Check all layout regions for neighboring mappings. Keep heap facts separate
  from the display span and retain the 512-cell limit. Keep the span until
  growth exceeds it; reset it on selection or target changes. Omit the margin
  for incomplete or stale layouts.

Use layouts that match the current summary. Show missing or stale data as
unavailable. Reset history when the sampler session or target changes.

For each task, update contextual help and `docs/qa/test-cases.md` as required
by `AGENTS.md`. Check 4 KiB, 64 KiB, and missing page-size metadata; incomplete
layouts; growth and contraction; target changes; and narrow screens.
