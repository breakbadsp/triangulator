// SPDX-License-Identifier: GPL-2.0-only
// CO-RE field mirrors and BTF map declarations must use Linux ABI names.
// Everything else follows the project's C++ conventions. No events leave the
// kernel: these probes only update bounded cumulative counter maps.
#include "shared.hpp"

struct task_struct
{
  unsigned long long start_boottime;
  task_struct* group_leader;
};
struct sock_common
{
  unsigned short skc_family;
};
struct sock
{
  sock_common __sk_common;
  unsigned short sk_type;
  unsigned short sk_protocol;
};

static auto* const kLookup =
    reinterpret_cast<void* (*)(const void*, const void*)>(1);
static auto* const kUpdate =
    reinterpret_cast<long (*)(const void*, const void*, const void*, U64)>(2);
static auto* const kDelete =
    reinterpret_cast<long (*)(const void*, const void*)>(3);
static auto* const kPidTid = reinterpret_cast<U64 (*)()>(14);
static auto* const kComm = reinterpret_cast<long (*)(void*, U32)>(16);
static auto* const kTask = reinterpret_cast<void* (*)()>(35);
static auto* const kRead =
    reinterpret_cast<long (*)(void*, U32, const void*)>(113);

extern "C"
{
  struct
  {
    int (*type)[2];  // BPF_MAP_TYPE_ARRAY
    int (*max_entries)[1];
    U32* key;
    TraceConfig* value;
  } config __attribute__((section(".maps"), used));
  struct
  {
    int (*type)[1];  // BPF_MAP_TYPE_HASH, never LRU: retired totals survive
    int (*max_entries)[kMaxSocketCounters];
    CounterKey* key;
    Counters* value;
  } counters __attribute__((section(".maps"), used));
  struct
  {
    int (*type)[1];
    int (*max_entries)[kMaxSocketCounters];
    U64* key;
    U64* value;
  } sockets __attribute__((section(".maps"), used));
  struct
  {
    int (*type)[2];
    int (*max_entries)[1];
    U32* key;
    U64* value;
  } losses __attribute__((section(".maps"), used));
  struct
  {
    int (*type)[2];
    int (*max_entries)[1];
    U32* key;
    U64* value;
  } identities __attribute__((section(".maps"), used));
  char kLicense[] __attribute__((section("license"), used)) = "GPL";
}

static __attribute__((always_inline)) void Lost()
{
  U32 zero = 0;
  auto* loss = static_cast<U64*>(kLookup(&losses, &zero));
  if (loss)
  {
    __sync_fetch_and_add(loss, 1);
  }
}

// Explicit preserve_access_index works in freestanding C++ without vmlinux.h.
#define CORE_READ(destination, field)        \
  kRead(&(destination), sizeof(destination), \
        __builtin_preserve_access_index(&(field)))

static __attribute__((always_inline)) int Count(sock* p_socket, int p_result,
                                                int p_flags, bool p_input,
                                                bool p_message)
{
  U32 zero = 0;
  const auto* settings = static_cast<TraceConfig*>(kLookup(&config, &zero));
  const U64 pid_tid = kPidTid();
  if (!settings || (pid_tid >> 32) != settings->pid_)
  {
    return 0;
  }
  auto* task = static_cast<task_struct*>(kTask());
  task_struct* leader = nullptr;
  U64 process_start = 0;
  CounterKey key{};
  if (CORE_READ(leader, task->group_leader) ||
      CORE_READ(process_start, leader->start_boottime) ||
      CORE_READ(key.thread_start_, task->start_boottime))
  {
    Lost();
    return 0;
  }
  // Match the process generation, not only its recyclable PID.
  if (!settings->clock_ticks_ ||
      process_start / (1000000000ULL / settings->clock_ticks_) !=
          settings->process_start_)
  {
    return 0;
  }
  key.tid_ = static_cast<U32>(pid_tid);
  key.kind_ = 6;
  if (!p_message)
  {
    if (p_result < 0 || (p_input && (p_flags & (2 | 8192))))  // PEEK / ERRQUEUE
    {
      return 0;
    }
    unsigned short family = 0, type = 0, protocol = 0;
    if (CORE_READ(family, p_socket->__sk_common.skc_family) ||
        CORE_READ(type, p_socket->sk_type) ||
        CORE_READ(protocol, p_socket->sk_protocol))
    {
      Lost();
      return 0;
    }
    if ((family == 2 || family == 10) && type == 1 && protocol == 6)
    {
      key.kind_ = family == 2 ? 1 : 2;
    }
    else if (family == 1 && (type == 1 || type == 2 || type == 5))
    {
      key.kind_ = type == 1 ? 3 : (type == 2 ? 4 : 5);
    }
    else
    {
      return 0;  // UDP and non-requested socket kinds
    }
    // Zero on streams is EOF/no progress, not an operation carrying data.
    if (p_result == 0 && (key.kind_ <= 3))
    {
      return 0;
    }
    const U64 address = reinterpret_cast<U64>(p_socket);
    auto* identity = static_cast<U64*>(kLookup(&sockets, &address));
    if (!identity)
    {
      auto* serial = static_cast<U64*>(kLookup(&identities, &zero));
      if (!serial)
      {
        Lost();
        return 0;
      }
      const U64 born = __sync_fetch_and_add(serial, 1) + 1;
      kUpdate(&sockets, &address, &born, 1);  // BPF_NOEXIST: shared socket race
      identity = static_cast<U64*>(kLookup(&sockets, &address));
    }
    if (!identity)
    {
      Lost();
      return 0;
    }
    key.socket_id_ = *identity;
  }
  auto* value = static_cast<Counters*>(kLookup(&counters, &key));
  if (!value)
  {
    Counters empty{};
    kComm(empty.name_, sizeof(empty.name_));
    kUpdate(&counters, &key, &empty, 1);
    value = static_cast<Counters*>(kLookup(&counters, &key));
  }
  if (!value)
  {
    Lost();
    return 0;
  }
  if (p_message)
  {
    __sync_fetch_and_add(&value->messages_, 1);
  }
  else if (p_input)
  {
    __sync_fetch_and_add(&value->input_, static_cast<U64>(p_result));
    __sync_fetch_and_add(&value->receives_, 1);
  }
  else
  {
    __sync_fetch_and_add(&value->output_, static_cast<U64>(p_result));
    __sync_fetch_and_add(&value->sends_, 1);
  }
  return 0;
}

extern "C" __attribute__((section("raw_tp/sock_recv_length"), used)) int
Receive(U64* p_context)
{
  return Count(reinterpret_cast<sock*>(p_context[0]),
               static_cast<int>(p_context[1]), static_cast<int>(p_context[2]),
               true, false);
}
extern "C" __attribute__((section("raw_tp/sock_send_length"), used)) int Send(
    U64* p_context)
{
  return Count(reinterpret_cast<sock*>(p_context[0]),
               static_cast<int>(p_context[1]), 0, false, false);
}
extern "C" __attribute__((section("fentry/sk_free"), used)) int Release(
    U64* p_context)
{
  const U64 address = p_context[0];
  kDelete(&sockets, &address);
  return 0;
}
extern "C" __attribute__((section("uprobe"), used)) int Message(U64* p_context)
{
  // BTF requires named parameters even when the probe ignores its context.
  (void)p_context;
  return Count(nullptr, 0, 0, false, true);
}
