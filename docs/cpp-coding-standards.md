# C++ coding standards

How C++ is written in this repository: the sampler (`sampler/`), the core
collector (`collector/`) and the C++ tests (`tests/*.cpp`).

The base is the [C++ Core Guidelines](https://isocpp.github.io/CppCoreGuidelines/CppCoreGuidelines),
with ideas from [TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md).
This document differs from both on purpose in four places, and says so each
time:

1. **Errors are values.** Fallible functions return `std::expected` or
   `std::optional`. Exceptions are kept only in the few places listed under
   "Error handling".
2. **Our own naming** (PascalCase functions, `p_` parameters), not the
   Guidelines' `snake_case`.
3. **Allman braces and 2-space indentation**, enforced by `.clang-format`.
4. **A hot-path section** for the code that handles every datagram.

Adapted from `docs/cpp-coding-standards.md`, `docs/naming-conventions.md`
and `prep/TIGER_STYLE.md` in
[modern_exchng_cpp](https://github.com/breakbadsp/modern_exchng_cpp). The
last section lists what changed and why.

## Principles

1. **Simple first.** Simple code is easier to get right, and easier to make
   fast after that. Pick the obvious solution unless a measurement says
   otherwise.
2. **RAII for every resource.** Every file descriptor, socket, SQLite handle,
   thread and lock belongs to an object that releases it.
3. **Errors are values.** See "Error handling".
4. **Composition before inheritance.** Inherit only for a real "is-a"
   interface with runtime polymorphism.
5. **Immutable by default.** Start with `const` / `constexpr` and make
   something mutable only when it has to change.
6. **Let the type system catch mistakes.** Prefer compile-time checks to
   runtime checks.
7. **Put a limit on everything.** Every loop, queue, buffer and cache has
   an upper bound (TigerStyle).
8. **Always say why.** A comment explains why the code is written this way,
   not what it does.

## Naming and layout

These match `$HOME/ai/conventions/cpp.md`, and they take precedence over
Google style.

| Kind | Convention | Example |
|------|------------|---------|
| Functions and methods | PascalCase | `DecodePacket`, `WriteRollup` |
| Function parameters | `p_` + snake_case, every named parameter (free functions, methods, lambdas) | `p_packet`, `p_day` |
| Local variables | snake_case | `thread_count` |
| Classes, structs, aliases, template parameters | PascalCase | `Engine`, `Record`, `TNumber` |
| Class and struct data members | snake_case + trailing `_` | `tid_`, `last_seen_` |
| Constants and `constexpr` | `k` + PascalCase | `kMaxDatagramBytes` |
| Enumerators | PascalCase, no `k`; the first one has an explicit initializer | `LogLevel::Info`, `Debug = 0` |
| Namespaces | lowercase, underscores between words | `triangulator` |
| Macros | avoid; if needed, `ALL_CAPS` | `TRIANGULATOR_VERSION` |
| Files | lowercase, underscores; `.hpp` / `.cpp` | `storage.hpp` |

- **Braces:** Allman. Every `{` and `}` sits on its own line.
- **Braces are mandatory** on every `if` / `else` / `for` / `while`, even
  when the body is one statement.
- **Indentation:** 2 spaces, never tabs. Run `make format`. `make
  format-check` fails if the code has drifted from `.clang-format`.
- **Units go last in a name** (TigerStyle): `interval_ms`, `latency_ms_max`
  and `latency_ms_min`. Related names then line up and sort together.
- **No abbreviations** unless they're standard in the domain (`tid`, `pid`,
  `fd`, `io`).
- **Structs are passive aggregates.** If a type has an invariant to
  protect, make it a `class`. The trailing `_` on struct members keeps them
  consistent with class members. It doesn't mean the struct hides anything.

## Error handling

### Two kinds of failure

TigerStyle separates two things, and this document follows it:

- **Operating errors** are expected: a malformed datagram, a missing file,
  a busy SQLite database, a port already in use, a thread that exited
  between two `/proc` reads. Handle them. Return them as values.
- **Programmer errors** are bugs: an index past the end, a broken
  invariant, a state that "can't happen". Don't return these. Check them
  with an assertion (see "Assertions"), which crashes the program. A crash
  turns a silent correctness bug into a visible one.

### Return values, not exceptions

- A function that can fail returns `std::expected<T, E>`. If it has no
  value to return, use `std::expected<void, E>`.
- A value that may legitimately be missing, where missing is not an error,
  is a `std::optional<T>`. Don't use sentinels (`-1`, `""`, `nullptr`).
- Every function that returns `std::expected` or `std::optional` is
  `[[nodiscard]]`. Our build uses `-Werror`, so ignoring the result is a
  compile error.
- Choose the error type `E` by how hot the path is:
  - Per-datagram or per-sample paths: an `enum class` or a
    `std::string_view` that points at a string literal. Building an error
    never allocates. (`collector/protocol.hpp` `Decode` does this.)
  - System calls: `std::error_code{errno, std::generic_category()}`.
    Capture `errno` right away, before another call can overwrite it.
  - Startup and configuration: `std::string`, so the message can name the
    file, key or value (as `collector/config.hpp` does).
- Use an early `return` for each error, so the main path stays flat. Use
  `and_then` / `transform` / `or_else` only when the chain is clearer than
  the `if` statements it replaces.
- Don't call `.value()` on a `std::expected` or `std::optional`. It throws
  when the object is empty. Check first and then use `*result` or
  `result->`, or use `value_or`.

```cpp
enum class DecodeError
{
  ShortHeader = 0,
  BadVersion,
  BadLength,
};

[[nodiscard]] std::expected<Header, DecodeError> DecodeHeader(
    std::span<const std::byte> p_bytes)
{
  if (p_bytes.size() < kHeaderBytes)
  {
    return std::unexpected(DecodeError::ShortHeader);
  }
  const auto version = ReadLittleEndian<std::uint16_t>(p_bytes, 0);
  if (version != kProtocolVersion)
  {
    return std::unexpected(DecodeError::BadVersion);
  }
  // ...
  return header;
}
```

```cpp
// A system call. Capture errno before anything else can change it.
[[nodiscard]] std::expected<std::uint64_t, std::error_code> MonotonicNs()
{
  timespec now{};
  if (::clock_gettime(CLOCK_MONOTONIC, &now) != 0)
  {
    return std::unexpected(std::error_code{errno, std::generic_category()});
  }
  return static_cast<std::uint64_t>(now.tv_sec) * 1'000'000'000U +
         static_cast<std::uint64_t>(now.tv_nsec);
}
```

### A constructor that can fail

Don't throw from a constructor. Make the constructor private and add a
static `Create` that returns `std::expected`. The constructor then only
stores a resource that has already been acquired, so it can't fail.

```cpp
class File final
{
public:
  [[nodiscard]] static std::expected<File, std::error_code> Create(
      const std::filesystem::path& p_path)
  {
    const int fd = ::open(p_path.c_str(), O_RDONLY | O_CLOEXEC);
    if (fd < 0)
    {
      return std::unexpected(std::error_code{errno, std::generic_category()});
    }
    return File{fd};
  }

  ~File()
  {
    if (fd_ >= 0)
    {
      ::close(fd_);
    }
  }

  File(const File&) = delete;
  File& operator=(const File&) = delete;

  File(File&& p_other) noexcept : fd_(std::exchange(p_other.fd_, -1))
  {
  }

  File& operator=(File&& p_other) noexcept
  {
    if (this != &p_other)
    {
      if (fd_ >= 0)
      {
        ::close(fd_);
      }
      fd_ = std::exchange(p_other.fd_, -1);
    }
    return *this;
  }

  [[nodiscard]] int Fd() const noexcept
  {
    return fd_;
  }

private:
  explicit File(int p_fd) noexcept : fd_(p_fd)
  {
  }

  int fd_;
};
```

If the only resource is a pointer or a descriptor with a simple close
function, a `std::unique_ptr` with a custom deleter is shorter. The SQLite
handles in `collector/storage.hpp` work this way.

### When an exception is allowed

Exceptions are not banned, but each one has to be justified. One is
allowed only in these places:

1. **Code we don't own that throws**: `std::thread`'s constructor,
   `std::filesystem` calls that have no `std::error_code` overload,
   allocation, and so on. Use the non-throwing overload when one exists.
   Otherwise catch at the narrowest boundary and convert to
   `std::expected`. Let `std::bad_alloc` terminate the program.
2. **The last-resort handler in `main` and at the top of a thread's
   function.** One `catch (const std::exception&)` logs the error. In
   `main` it returns a non-zero exit code. In a thread it ends the current
   unit of work, such as one HTTP request (`DashboardServer::Serve`). It
   catches bugs. It is not the error-handling design.
3. **Test helpers.** In `tests/*.cpp` a failed check may throw to abort the
   current test case.

Exceptions are never used:

- on the per-datagram or per-sample path;
- for operating errors (a bad packet, a missing day file, a busy database);
- as control flow, such as `try { ... } catch (...) { continue; }` in a
  loop;
- to cross a module boundary. A function that a caller can call returns
  `std::expected`.

We don't build with `-fno-exceptions`. The standard library still throws
(allocation, `std::thread`, some `std::filesystem` calls), and the cases
above need the mechanism.

### `noexcept`

Mark a function `noexcept` when it really can't throw: moves, swaps,
destructors, accessors, and pure arithmetic on trivial types. Don't add it
to a function that allocates or calls something that might throw. With
exceptions enabled, a wrong `noexcept` turns an exception into
`std::terminate`.

## Assertions

Assertions catch programmer errors (TigerStyle). Our Makefile doesn't
define `NDEBUG`, so `assert` stays enabled in the shipped binaries.

- Assert preconditions, postconditions and invariants that a bug could
  break. Examples: an index you're about to use is in range, a state
  machine is in an allowed state, a count stays under its limit.
- Assert both sides of a boundary. Assert what you expect to hold, and
  also what must not happen.
- Split compound assertions: write `assert(a); assert(b);`, not
  `assert(a && b);`. When one fails, the message shows which condition was
  false.
- Use `static_assert` for facts about the build: a wire-struct size, a
  limit that relates to another limit, `std::is_trivially_copyable_v`.
- **Never assert on input from outside the process**: datagrams, files,
  `/proc`, HTTP requests, config. Those are operating errors and get a
  `std::expected`. A sampler on another host must never be able to crash
  the collector.
- An assertion must have no side effects.

```cpp
static_assert(sizeof(WireHeader) == 24, "the wire format is fixed");
static_assert(kMaxThreads <= std::numeric_limits<std::uint16_t>::max());

void ThreadTable::Erase(std::size_t p_slot)
{
  assert(p_slot < slots_.size());
  assert(slots_[p_slot].live_);
  // ...
}
```

C++26 contracts (`pre`, `post`, `contract_assert`) would replace some of
this, but only GCC implements them so far. We'll keep using `assert` until
both of our compilers support contracts.

## Functions

| Rule | Summary |
|------|---------|
| **F.2** | One function, one logical operation |
| **F.3** | Keep functions short. Aim for under 70 lines (TigerStyle). Splitting a long function usually reveals the pieces it was made of |
| **F.4** | If it can run at compile time, make it `constexpr` |
| **F.8** | Prefer pure functions; keep leaf functions pure |
| **F.16** | Pass cheap-to-copy types by value, larger types by `const&`. Pass by value when the function keeps its own copy (a sink) |
| **F.20 / F.21** | Return values, not output parameters. Return a struct for several values |
| **F.43** | Never return a pointer or reference to a local |
| **I.23** | Few parameters. Two neighboring parameters of the same type are easy to swap at the call site; use a struct or a distinct type |

- **References by default.** A reference is never null. Use a raw pointer
  only when null is a valid state, and then it never owns anything.
- **Push `if`s up and `for`s down.** Keep the branching in the parent
  function and move the straight-line work into helpers.
- **Split compound conditions** into nested `if`s when that makes it
  clearer which cases are handled. State conditions positively: prefer
  `index < count` to `!(index >= count)`.
- **Pass options to library calls explicitly** at the call site (flags,
  timeouts, `O_CLOEXEC`), instead of relying on defaults that could change.

```cpp
struct RateWindow
{
  double start_s_{};
  double end_s_{};
};

// Cheap types by value. The two doubles travel together in a struct, so
// a caller can't swap start and end.
[[nodiscard]] double Rate(std::uint64_t p_delta, RateWindow p_window);

// Large and read-only: const reference.
[[nodiscard]] Json Snapshot(const Engine& p_engine);

// A sink: by value, then moved into place.
void SetName(std::string p_name);
```

Avoid these:

- returning `T&&` or `const T` by value (a `const` return value can't be
  moved from);
- C-style variadics (`va_arg`). Use `std::format` or a variadic template;
- a lambda that captures by reference and is handed to another thread;
- recursion over data that comes from outside the process, because its
  depth has no bound. Use a loop with an explicit limit. A recursive parser
  must carry a depth limit.

## Classes and composition

| Rule | Summary |
|------|---------|
| **C.2** | `class` if there is an invariant; `struct` if the members vary independently |
| **C.9** | Expose as little as possible |
| **C.20** | Rule of Zero: don't write special members if you don't need them |
| **C.21** | Rule of Five: if you write or delete one, handle all five |
| **C.35** | A base destructor is public virtual or protected non-virtual |
| **C.41** | A constructor produces a fully initialized object |
| **C.46** | Single-argument constructors are `explicit` |
| **C.128** | An override uses exactly one of `virtual`, `override`, `final` |
| — | Mark a class `final` unless it is meant to be a base |
| — | Inheritance is always `public`. If you want private inheritance, use a member |

```cpp
// Avoid: inheriting only to reuse FormatLine(). A logger is not a formatter.
class Logger : public Formatter
{
};

// Prefer: the logger has a formatter.
class Logger final
{
public:
  void Write(std::string_view p_text)
  {
    std::println(stderr, "{}", formatter_.FormatLine(p_text));
  }

private:
  Formatter formatter_;
};
```

- **Data members are not `const` and not references.** Either one makes the
  class impossible to assign, and a `const` member can't be moved from.
  Make the member private with no setter.
- Don't call virtual functions from a constructor or destructor.
- Don't `memset` / `memcpy` a type that isn't trivially copyable.

## Resource management

| Rule | Summary |
|------|---------|
| **R.1** | RAII for every resource |
| **R.3** | A raw `T*` doesn't own, and is used only when null is valid |
| **R.5** | Prefer scoped objects; don't use the heap without a reason |
| **R.10 / R.11** | No `malloc`/`free`, no naked `new`/`delete` |
| **R.20 / R.21** | `std::unique_ptr` for ownership; `std::shared_ptr` only when ownership really is shared |

RAII doesn't depend on exceptions. A destructor runs on every way out of a
scope, including an early `return` of an error. `std::expected` changes how
a failure is reported, not how resources are cleaned up. Destructors,
deallocation and swap must never fail.

C APIs (`open`, `socket`, `sqlite3_open_v2`): wrap the handle in its owner
right after you acquire it, before the next line that can return early.

## Expressions and statements

| Rule | Summary |
|------|---------|
| **ES.5** | Keep scopes small; declare a variable where it is first needed |
| **ES.20** | Always initialize |
| **ES.23** | Prefer `{}` initialization (but see below) |
| **ES.25** | `const` / `constexpr` unless the value changes |
| **ES.45** | No magic numbers; use named constants |
| **ES.46** | No narrowing. The build uses `-Wconversion` |
| **ES.47** | `nullptr`, never `0` or `NULL` |
| **ES.48 / ES.50** | No C-style casts; use the named casts or `std::bit_cast`. Never cast away `const` |

`{}` and `()` differ for containers: `std::vector<int>{3}` holds one
element, the value 3, while `std::vector<int>(3)` holds three zeros. Use `()`
when you mean the size.

Mixing signed and unsigned values is a common bug. Use `std::cmp_less` and
the other comparison helpers from `<utility>`, or make the conversion
explicit with a `static_cast` and a reason.

**Index, count and size are different things** (TigerStyle). An index is
0-based and a count is 1-based, so going from one to the other needs a `+
1`. A size is a count times a unit. Name the variables so the difference
shows (`slot_index`, `slot_count`, `buffer_bytes`). When integer division
rounds, make it visible which way and why.

## Constants and immutability

- Objects are `const` by default (Con.1). Member functions are `const`
  unless they change the object (Con.2).
- Use `constexpr` for anything that can be computed at compile time
  (Con.5), with a `k` prefix: `constexpr std::size_t kMaxDatagramBytes =
  65'507;`.
- A member that must not change after construction: make it private with
  no setter, rather than a `const` member (see "Classes").

## Concurrency

The collector's main loop runs on one thread. The HTTP server runs on its
own thread and reads a published snapshot (`collector/http.hpp`). Keep it
that way. Per `AGENTS.md`, a slow helper must never delay the main loop.

| Rule | Summary |
|------|---------|
| **CP.2 / CP.3** | No data races; share as little writable data as possible |
| **CP.8** | Never use `volatile` for synchronization |
| **CP.20** | RAII locks only (`std::scoped_lock`, `std::unique_lock`) |
| **CP.22** | Never call unknown code while holding a lock |
| **CP.44** | Always name a lock guard. An unnamed one is destroyed at once, and the lock is never held |

- Publish immutable data across threads (for example a
  `std::shared_ptr<const T>` swapped under a short lock) instead of sharing
  mutable state.
- Prefer `std::jthread` to `std::thread`: its destructor joins, so a thread
  can't be left running by mistake. Never `detach`.
- Avoid false sharing. If two threads each write their own variable often,
  keep those variables on separate cache lines (`alignas(64)`).

```cpp
class Snapshot final
{
public:
  void Publish(std::shared_ptr<const std::string> p_body)
  {
    const std::scoped_lock lock{mutex_};
    body_ = std::move(p_body);
  }

  [[nodiscard]] std::shared_ptr<const std::string> Live()
  {
    const std::scoped_lock lock{mutex_};
    return body_;
  }

private:
  std::mutex mutex_;
  std::shared_ptr<const std::string> body_;
};
```

## Templates

| Rule | Summary |
|------|---------|
| **T.10 / T.11** | Constrain templates with concepts, standard ones where possible |
| **T.43** | `using`, not `typedef` |
| **T.120** | Template metaprogramming only when `constexpr` can't do the job |

```cpp
template <std::unsigned_integral TNumber>
[[nodiscard]] TNumber ReadLittleEndian(std::span<const std::byte> p_bytes,
                                       std::size_t p_offset);
```

## Standard library

- `std::array` / `std::vector` over C arrays. `std::vector` is the default
  container.
- `std::string` owns text; `std::string_view` and `std::span` only look at
  it. Never keep a view after the thing it points into is gone.
- `std::format` / `std::print` instead of `<<` chains and `printf`.
- `std::unreachable()` for a branch that truly can't happen, after a
  `switch` that covers every enumerator. `-Wswitch` then reports a newly
  added enumerator that the `switch` doesn't handle.
- `std::to_underlying(e)` instead of
  `static_cast<std::underlying_type_t<E>>(e)`.
- `std::flat_map` / `std::flat_set` when lookups and iteration far
  outnumber insertions.
- No new third-party dependencies without a good reason. SQLite is the
  only one today.

## The hot path

The hot path is the code that runs for every datagram or every sample:
the sampler's `/proc` reads, packet encode and decode, and the collector's
per-thread state updates. `docs/collector-comparison.md` shows why this
code is in C++. These rules keep it fast.

- **Measure first** (Per.1, Per.2, Per.6). Do a quick estimate of network,
  disk, memory and CPU while designing. After that, change hot code only
  with a measurement, and report the before and after numbers.
- **Don't allocate on every datagram.** Reuse buffers. Set bounds once at
  startup. Keep maps keyed by thread so they don't rebuild on each tick.
  Allocation at startup, and when a new thread first appears, is fine.
- **Put a limit on everything.** Each loop over external data has a maximum
  (threads per packet, bytes per datagram, entries in a cache). Hitting a
  limit is an operating error: count it, log it once, and carry on. The
  collector does not grow without bound because a sampler misbehaves.
- **Batch.** Write rollups to SQLite in transactions, not row by row. Let
  the program run at its own pace instead of doing I/O as a direct reaction
  to each event.
- **Keep data contiguous.** Prefer `std::vector<Record>` to
  `std::vector<std::unique_ptr<Record>>` for anything walked in a loop.
- **No virtual dispatch or RTTI** (`dynamic_cast`, `typeid`) in per-datagram
  code. Use templates or `if constexpr` there.
- **`[[likely]]` / `[[unlikely]]`** only on a branch that a profile showed
  to matter.

## Source files

| Rule | Summary |
|------|---------|
| **SF.7** | No `using namespace` at global scope in a header |
| **SF.8** | `#pragma once` on every header |
| **SF.11** | Headers are self-contained: each includes what it uses |

Most of this code is header-only, with one `main.cpp` per binary. Free
functions defined in a header are `inline`. Put everything in
`namespace triangulator`.

## Comments

- Explain why the code is written this way. The code already says what it
  does.
- Write comments as sentences: a capital letter and a full stop. A short
  comment at the end of a line can be a phrase.
- A test begins with a sentence on what it checks and how.

## Checklist

Before you call C++ work done:

- [ ] `make format-check` and `make check` pass, with `-Werror`
- [ ] Fallible functions return `std::expected`; missing values are
      `std::optional`; both are `[[nodiscard]]`
- [ ] No new `throw` / `try` / `catch` outside the three allowed places
- [ ] No `.value()` on `std::expected` / `std::optional`
- [ ] Assertions for programmer errors; never assertions on external input
- [ ] Every loop, queue and cache over external data has a limit
- [ ] No allocation per datagram on the hot path
- [ ] RAII for every handle; no naked `new` / `delete`
- [ ] Rule of Zero or all five special members
- [ ] Single-argument constructors are `explicit`; leaf classes are `final`
- [ ] Every variable initialized; `const` by default; no magic numbers
- [ ] No narrowing, no C-style casts, `nullptr`
- [ ] Locks are RAII and named; no `detach`
- [ ] PascalCase functions, `p_` parameters, members with a trailing `_`,
      `k` constants, PascalCase enumerators with the first initialized
- [ ] Allman braces, braces on every branch, 2-space indent

## Differences from the modern_exchng_cpp documents

The upstream guide was written for a single-threaded matching engine. These
are the changes, and why:

- **Exceptions.** Upstream bans `throw`/`try`/`catch` outright and asks for
  `-fno-exceptions`. Here `std::expected` is the rule, but exceptions are
  allowed in three narrow places. The standard library throws, and
  triangulator has a second thread and filesystem code. We don't use
  `-fno-exceptions`. Added: the operating-error versus programmer-error split
  from TigerStyle, a guide to choosing the error type, and "never call
  `.value()`".
- **Bugs in the upstream examples, fixed here** (and upstream in
  [modern_exchng_cpp#3](https://github.com/breakbadsp/modern_exchng_cpp/pull/3)):
  - The Enumerations section and `ParseError` used `kRed` / `kEmptyInput`.
    That breaks upstream's own rule of PascalCase enumerators, no `k`, and
    an explicit first initializer.
  - The examples used 4-space indentation, parameters without `p_`, and
    struct members without the trailing `_`, all against upstream's own
    naming rules.
  - The `FileHandle::Create` example always returned `no_such_file_or_directory`,
    whatever the real `errno` was (a permission error, for example). The
    example here reports `errno`.
  - The `Sensor` example had a `const std::string id_` member, while the
    same document lists `const` data members as an anti-pattern. They
    break assignment and moves. This document keeps the anti-pattern rule.
  - `Boil(const Temperature&)` passed a one-`double` struct by reference,
    against upstream's own F.16 rule (cheap types by value).
  - The `[[nodiscard]]` example claimed that ignoring a result "won't
    compile". On its own it is a warning. Here it fails the build only
    because we use `-Werror`.
  - A line in the checklist was garbled ("ends with `_` plain snake_case").
- **Not carried over:** the C++26 contracts section (GCC-only, and the
  Makefile uses `-std=c++23`), the "no heap allocation once running" rule
  (narrowed to "no allocation per datagram"), the references to the order
  book, and these TigerStyle rules: 4-space indentation, `snake_case`
  functions, static allocation for everything, and in-place initialization
  through out pointers. Each of those conflicts with the naming above or
  with F.20.
- **Formatting:** upstream's `.clang-format` is LLVM-based with a 100-column
  limit. Triangulator keeps its Google-based 80-column file. Both use
  Allman braces, 2-space indentation and inserted braces, so the visible
  style is the same, and switching would only reformat every file.
- **Added from TigerStyle:** assertions (with a carve-out for external
  input), limits on everything, functions under about 70 lines, "push `if`s
  up and `for`s down", units at the end of names, index/count/size
  discipline, explicit options at call sites, and always saying why.
