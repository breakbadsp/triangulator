#pragma once

// Fixed-width ABI shared by the freestanding BPF C++ program and its loader.
using U64 = unsigned long long;
using U32 = unsigned int;
inline constexpr U32 kMaxSocketCounters = 4096;
struct CounterKey
{
  U64 thread_start_;
  U64 socket_id_;
  U32 tid_;
  U32 kind_;  // 1 TCP4, 2 TCP6, 3 Unix stream, 4 datagram, 5 seqpacket, 6
              // marker
};
struct Counters
{
  U64 input_;
  U64 output_;
  U64 receives_;
  U64 sends_;
  U64 messages_;
  char name_[16]{};
};
struct TraceConfig
{
  U32 pid_;
  U32 padding_;
  U64 process_start_;  // /proc starttime, in clock ticks
  U64 clock_ticks_;
};
