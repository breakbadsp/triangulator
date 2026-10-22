# Socket I/O and message completion

Status: implemented as an optional eBPF source. The ordinary `/proc` sampler
works without it. Exact coverage is in
[socket.bpf.cpp](../socket_sampler/socket.bpf.cpp) and the
[loader](../socket_sampler/main.cpp). Measurement limits are in
[measurement limits](measurement-limits.md#sockets).

## Decisions

- Keep eBPF optional. Requiring it would remove the unprivileged deployment path.
- Use socket operation results for per-thread byte counts. TCP diagnostics count
  transport receipt, Unix sockets have no equivalent byte counters, and thread
  `/proc/io` mixes socket and other I/O.
- Use the `sock_recv_length` and `sock_send_length` tracepoints. They run after
  the operation and also cover the internal `sendmmsg` and `recvmmsg` paths that
  public `sock_sendmsg` and `sock_recvmsg` probes miss.
- Require an explicit application marker for completed messages. Bytes and
  receive operations do not establish completion. Without a marker, the value
  is unavailable, not zero.

## Measurement contract

- Received and sent bytes are the nonnegative results of observed operations.
  Sent means accepted by the socket, not delivered.
- Peeks, error-queue receives, failed operations, stream EOF, and UDP do not count.
- A truncated datagram follows the kernel return length, not the bytes parsed.
- Counter maps hold 4,096 lifetime counters. A lost update makes totals lower
  bounds and lifetime averages unavailable.

## Setup

```sh
make socket-sampler
build/triangulator-socket-sampler PID COLLECTOR-IP:PORT build/socket.bpf.o
```

This needs clang with the BPF backend, libbpf, kernel BTF, the two tracepoints,
and the privilege to load BPF tracing programs (usually root or `CAP_BPF` plus
`CAP_PERFMON`). The loader never changes capabilities, sudo policy, or sysctls.
Run it in the target's PID namespace. It watches one PID generation: restart it
for a new process. The collector can run on another host.
