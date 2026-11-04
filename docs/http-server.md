# Collector HTTP server

The collector uses [cpp-httplib](https://github.com/yhirose/cpp-httplib)
v0.64.0, vendored in `third_party/cpp-httplib/` with a worker-start hook
for thread names. The library parses
and frames messages and writes responses. `collector/http_server.hpp` enforces
the limits it lacks. The route handlers and API contract are unchanged.

## Why cpp-httplib

civetweb has its own thread and configuration model. llhttp parses only, so we
would still own sockets, framing, and deadlines. cpp-httplib is one header with
no runtime dependency, so the release collector stays a static binary. TLS,
zlib, and brotli stay off, and a build that enables one fails.

## Limits the library does not give

The library does not count request-head bytes. Its read deadline covers only
the headers, not the body. `http_server.hpp` overrides
`process_and_close_socket` and wraps each connection's stream in
`LimitedStream`:

- Head: 65,536 bytes on the wire, counted before the library trims anything.
  A field line over 8,192 bytes gets 400 from the library.
- Read: 5 s in total for headers and body together.
- Write: 5 s in total for one response.
- Body: 16 KiB (413 above it).
- Connections: 64 at once. When all are busy, a new connection gets an
  immediate 503 and is closed. There is no queue.
- Shutdown: `Stop()` interrupts pending reads and writes and joins every worker
  before the shared state is destroyed.
- Policy headers (`Cache-Control`, `X-Content-Type-Options`, the Content
  Security Policy) go on every response, library errors included.
- `Range` is ignored, as before. `SO_REUSEPORT` is off, so a second collector
  fails to bind the same port. The peer address comes from the socket, and
  forwarded-address headers are ignored.

The override uses the library's `detail::` internals. An upgrade can break the
build, but not silently, because the version is pinned and checked. Upgrade
only with the real-socket tests in `tests/http_server_test.cpp`.

## Protocol differences from the old server

Responses are HTTP/1.1 with `Connection: close`. Library-written errors have
empty bodies. An HTTP/1.1 request without `Host` gets 400. A target over 8,192
bytes gets 414. A syntactically invalid `Range` gets 416. A handler exception
gets 500.

## Open decisions

- Authentication and permissions for write routes. The `X-Triangulator` and
  `Origin` checks only stop browser cross-site writes.
- Where HTTPS ends. If a proxy is added, decide which peers and forwarded
  headers to trust. The loopback rule for target control cannot identify the
  original client behind a local proxy.
- Watch updates return 428 and 409 for a missing or stale `If-Match`. Standard
  behavior is 412. Change the clients, tests, and the
  [watch revision instructions](../collector/README.md#multiple-viewers)
  together.
