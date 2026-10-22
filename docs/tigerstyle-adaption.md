# Sampler allocation decisions

- Allow allocations at startup and configuration reload. Steady ticks must allocate nothing.
- Replace libc directory iteration with bounded `getdents64` storage. A C++ memory resource cannot prevent allocations inside `opendir`.
- Use a reserved, sorted socket vector. Binary search needs less code than a custom hash table.
- Keep only the sockets sent on the wire. A fixed array for every matched socket would require more than 10 MiB.
- Reject a per-tick `std::pmr` arena. It cannot control libc allocations, throws on overflow, and cannot own state that survives a tick.
- Format warnings after the rate-limit check. Suppressed warnings must not allocate or format text.
- Contract and executable proof: [allocation_test.cpp](../tests/allocation_test.cpp). Reload, fatal error paths, and packet transmission are outside that test.
