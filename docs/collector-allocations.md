# Collector allocation decisions

- Reserve bounded storage at startup. Datagram bursts must not cause heap growth.
- Pass rows directly to storage. A pending-row buffer would need an arbitrary drop limit.
- Keep records by value. Shared ownership per sample adds allocations without a lifetime benefit.
- Reject a `std::pmr` arena: overflow would throw, and bounded rows would still need a drop policy.
- Reject a custom SQLite allocator: it would need thread-safe general allocation for little gain once the page cache reaches its limit.
- Exclude SQLite allocation, startup, new-day file creation, HTTP, replay, and periodic snapshots from the zero-allocation contract.
- Historical measurement: 60 ticks, 25 threads, 12 resource samples; allocations fell from 6,452 to zero without raw storage, and from 13,952 to zero with it. Baseline: `9fa7bbc`.
- SQLite separately made 22 and 107 allocations in the two cases, before and after.
- Contract and executable proof: [collector_allocation_test.cpp](../tests/collector_allocation_test.cpp).
