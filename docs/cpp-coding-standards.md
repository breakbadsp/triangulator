# C++ coding standards

Apply these rules to new and edited C++ code, including headers and tests.
Keep changes within the task scope. Do not rename unrelated code.

## Naming and layout

These rules match `$HOME/ai/conventions/cpp.md`.

| Kind | Convention | Example |
|------|------------|---------|
| Functions and methods | PascalCase | `DecodePacket` |
| Every named parameter, including lambdas | `p_` + snake_case | `p_packet` |
| Local variables | snake_case | `thread_count` |
| Types, aliases, template parameters | PascalCase | `Record`, `TNumber` |
| Class and struct data members | snake_case + trailing `_` | `last_seen_` |
| Constants and `constexpr` variables | `k` + PascalCase | `kMaxDatagramBytes` |
| Enumerators | PascalCase; initialize the first explicitly | `Info = 0` |
| Namespaces | lowercase with underscores | `triangulator` |
| Macros | Avoid; otherwise uppercase with underscores | `TRIANGULATOR_VERSION` |
| Files | lowercase with underscores or dashes; `.hpp` / `.cpp` | `storage.hpp` |

- Use Allman braces and 2-space indentation. Do not use tabs.
- Use braces for every `if`, `else`, `for`, and `while` body.
- Follow `.clang-format`.
- Include units in names, such as `interval_ms` and `buffer_bytes`.
  Distinguish indices, counts, and sizes.
- Use clear names. Use abbreviations only when standard, such as `pid` or `fd`.

## Design and ownership

- Give each function one operation. Keep functions short and use early returns.
- Prefer composition to inheritance. Use a `struct` for independent data.
  Use a `class` to protect invariants.
- Initialize every variable. Use `const` unless a value must change.
  Use `constexpr` and named constants for compile-time values.
- Pass small types by value and larger read-only types by `const&`.
  Return values instead of output parameters. Return a struct for several values.
- Use references for required objects. Use raw pointers only for optional,
  non-owning access. Never return a reference or pointer to a local object.
- Use RAII for every resource: descriptors, sockets, SQLite handles, and locks.
  Put a new handle in its owner before any operation that can fail.
- Prefer scoped objects and `std::unique_ptr`. Use `std::shared_ptr` only for
  shared ownership. Do not use bare `new` / `delete` or `malloc` / `free`.
- Let members manage cleanup. If you define or delete a copy, move, or destructor
  operation, handle all five special members. Cleanup must not fail.
- Make single-argument constructors `explicit` and leaf classes `final`.
  Do not call virtual functions from constructors or destructors.
- Keep immutable data members private with no setter. Avoid `const` or reference
  members that prevent assignment and moves.
- Prevent narrowing and signed/unsigned comparison errors. Use named casts,
  `std::cmp_less`, or `std::bit_cast` as appropriate. Do not cast away `const`.
- Use `nullptr`. Use `memcpy` only with trivially copyable types.
- Keep `std::string_view` and `std::span` within the lifetime of their data.
  Constrain templates with concepts. Prefer `using` to `typedef`.

## Error handling

- Return operating errors, such as bad input or failed I/O, as
  `std::expected<T, E>`. Use `std::expected<void, E>` when there is no value.
- Use `std::optional<T>` when a missing value is valid. Do not use a sentinel.
- Mark functions that return either type `[[nodiscard]]`.
- Check the result before using `*result` or `result->`. Do not use `.value()`.
- Use an `enum class` or a `std::string_view` of a string literal for hot-path
  errors. Error construction must not allocate there.
- Capture `errno` immediately with `std::error_code{errno, std::generic_category()}`.
  Startup and configuration errors can use `std::string`.
- For construction that can fail, use a static `Create` function that returns
  `std::expected`. Keep the constructor private and non-failing.
- Use non-throwing library overloads when available. Otherwise, catch library
  exceptions at the nearest boundary and return an error value.
  Do not recover from `std::bad_alloc`; let it terminate the program.
- Allow exception handlers only for library conversion, final handlers in
  `main` or thread entry functions, and test helpers. Final handlers log failures;
  `main` returns a non-zero status, and a thread ends the failed unit of work.
- Do not use exceptions for operating errors, loop control, or across module
  boundaries. Do not use them on the per-datagram or per-sample path.
- Use `noexcept` only when the function cannot throw. Keep exceptions enabled
  for standard-library calls and the permitted handlers.

## Assertions and limits

- Use `assert` for programmer errors: broken invariants, invalid internal
  indices, and impossible states. Keep assertions free of side effects.
- Use `static_assert` for compile-time facts, such as wire sizes.
- Validate external input and return an error. Never assert on datagrams,
  files, `/proc` data, HTTP requests, or configuration.
- Bound loops over external data, recursion depth, queues, buffers, and caches.
  Count and report limit violations without unbounded growth or repeated logs.

## Concurrency

- Follow the architecture rules in `AGENTS.md`. Slow helpers must not delay
  the collector main loop. Publish immutable snapshots to the HTTP thread.
- Minimize shared mutable data. Do not use `volatile` for synchronization.
- Use named RAII lock guards. Keep locks short and do not call unknown code
  while holding a lock.
- Prefer `std::jthread`. Do not detach threads.
- Do not pass lambdas with reference captures to another thread.

## The hot path

The hot path runs for every datagram or sample. It includes `/proc` reads,
packet encoding and decoding, and collector state updates.

- Measure performance changes and report the before and after results.
- Reuse bounded buffers. The sampler allocates only at startup and reload.
  The collector datagram path allocates only at startup. See
  [sampler allocation rules](tigerstyle-adaption.md) and
  [collector allocation rules and exclusions](collector-allocations.md).
- Batch SQLite writes in transactions. Prefer contiguous data for iteration.
- Do not use virtual dispatch or RTTI in per-datagram code.
- Use `[[likely]]` and `[[unlikely]]` only when supported by a profile.

## Source files and comments

- Use `#pragma once`. Each header must include what it uses.
- Mark free functions defined in headers `inline`.
- Use `namespace triangulator`. Do not use global `using namespace` in headers.
- Explain reasons and constraints in comments. Do not repeat the code.
- Write comments as sentences. Start each test with what it checks and how.

## Validation

Before committing, build and run `make check`. For C++ changes, also run
`make format` and `make format-check`. Keep the default warning flags and
`-Werror` enabled. Follow the commit and pull request workflow in `AGENTS.md`.
